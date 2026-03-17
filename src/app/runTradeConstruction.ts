import { createTradeStationGetFetcher } from "../tradestation/client.js";
import { type ScanConfidence, type ScanDirection } from "../scanner/scoring.js";
import { evaluateChartAnchoredTradability } from "./chartAnchoredTradability.js";
import {
  buildDirectOptionSymbols,
  fetchFirstUsableDirectOptionQuote,
  pickTargetExpiration,
  readExpirations,
  readStrikes,
  runSingleSymbolTradeStationAnalysis,
} from "./runScan.js";

const TARGET_ALLOCATION_PCT = 0.33;
const TARGET_DTE_MIN = 14;
const TARGET_DTE_MAX = 21;
const TARGET_DTE_CENTER = 17;
const FALLBACK_EQUITY_ENV = "TRADE_CARD_FALLBACK_ACCOUNT_EQUITY";

type TradeConstructionPromptMatch = {
  symbol: string;
};

export type TradeConstructionInput = {
  prompt: string;
  confirmedDirection?: ScanDirection;
  confirmedConfidence?: ScanConfidence;
};

export type TradeConstructionResult = {
  ticker: string;
  direction: ScanDirection;
  confidence: ScanConfidence;
  expectedTiming: string;
  buy: string;
  invalidationExit: string;
  takeProfitExit: string;
  timeExit: string;
  rrMath: string;
  rationale: string;
};

type TradeInputs = {
  underlyingPrice: number;
  strike: number;
  expirationDate: string;
  dte: number;
  optionSymbol: string;
  optionMid: number;
  equity: number;
  allocation: number;
  contracts: number;
  notional: number;
  invalidationUnderlying: number;
  targetUnderlying: number;
  optionAtInvalidation: number;
  optionAtTarget: number;
  invalidationReason: string;
  targetReason: string;
  riskPerContract: number;
  rewardPerContract: number;
  totalRisk: number;
  totalReward: number;
  equitySource: string;
};

type TradeConstructionDiagnostics = {
  selectedExpiration: string | null;
  strikesExpirationParam: string | null;
  strikesRequestTarget: string | null;
  strikesCountReturned: number | null;
  chosenStrike: number | null;
  attemptedOptionSymbols: string[];
  optionQuoteRequestTargets: string[];
  optionQuoteStatuses: number[];
  chosenOptionSymbol: string | null;
  failureReason: string | null;
};

function parseTradeConstructionPrompt(prompt: string): TradeConstructionPromptMatch | null {
  const matched = prompt.match(/(?:^|\s)(?:build trade|trade setup|construct trade)\s+\$?([A-Za-z]{1,5})(?=\s|$|[,.!?;:])/i);
  if (!matched || !matched[1]) {
    return null;
  }

  const symbolRaw = matched[1];
  const symbol = symbolRaw.toUpperCase();
  if (symbolRaw !== symbol || !/^[A-Z]{1,5}$/.test(symbol)) {
    return null;
  }

  return { symbol };
}

function readNumber(source: Record<string, unknown> | null, keys: string[]): number | null {
  if (!source) {
    return null;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim().replace(/,/g, ""));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function pickFirstObject(payload: unknown, keys: string[]): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (Array.isArray(payload)) {
    const first = payload[0];
    return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
  }

  const objectPayload = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = objectPayload[key];
    if (Array.isArray(value)) {
      const first = value[0];
      if (first && typeof first === "object") {
        return first as Record<string, unknown>;
      }
    }
    if (value && typeof value === "object") {
      return value as Record<string, unknown>;
    }
  }

  return objectPayload;
}

function renderMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function computeThursdayBeforeExpiration(expirationDate: string): string | null {
  const expiration = new Date(`${expirationDate}T00:00:00Z`);
  if (Number.isNaN(expiration.getTime())) {
    return null;
  }

  const thursdayBefore = new Date(expiration);
  thursdayBefore.setUTCDate(thursdayBefore.getUTCDate() - 1);
  while (thursdayBefore.getUTCDay() !== 4) {
    thursdayBefore.setUTCDate(thursdayBefore.getUTCDate() - 1);
  }

  return formatIsoDate(thursdayBefore);
}

function buildExpectedTiming(
  direction: ScanDirection,
  confidence: ScanConfidence,
  trade: Pick<TradeInputs, "dte" | "underlyingPrice" | "targetUnderlying" | "optionMid" | "optionAtTarget">,
): string {
  const targetMovePct = Math.abs((trade.targetUnderlying - trade.underlyingPrice) / trade.underlyingPrice);
  const optionFollowThroughPct = Math.abs((trade.optionAtTarget - trade.optionMid) / trade.optionMid);

  const momentumStrength = confidence === "93-97" || confidence === "85-92" ? "strong" : confidence === "75-84" ? "moderate" : "mixed";
  const volumeConfirmation = confidence === "93-97" || confidence === "85-92" ? "confirmed" : "adequate";
  const continuationStructure = confidence === "93-97" ? "clean" : confidence === "85-92" ? "mostly clean" : "developing";
  const setupPace = confidence === "93-97" || (confidence === "85-92" && trade.dte <= 21) ? "immediate" : "slower-developing";

  let timingBucket = "Unclear timing";
  if (confidence === "93-97" && trade.dte <= 21 && targetMovePct <= 0.03) {
    timingBucket = "Today / next session";
  } else if ((confidence === "93-97" || confidence === "85-92") && trade.dte <= 28 && targetMovePct <= 0.04) {
    timingBucket = "Next 1–3 trading days";
  } else if (confidence === "85-92" || (confidence === "75-84" && trade.dte <= 35)) {
    timingBucket = "Next 1–2 weeks";
  } else if (trade.dte > 21 || confidence === "65-74") {
    timingBucket = "Slower swing / may take most of DTE";
  }

  return `${timingBucket} (${direction} bias; momentum ${momentumStrength}, volume ${volumeConfirmation}, continuation ${continuationStructure}, target distance ${(targetMovePct * 100).toFixed(1)}%, DTE ${trade.dte}, setup ${setupPace}, est. option follow-through ${(optionFollowThroughPct * 100).toFixed(0)}%).`;
}

async function resolveDirectionAndConfidence(
  symbol: string,
  confirmedDirection?: ScanDirection,
  confirmedConfidence?: ScanConfidence,
): Promise<{ direction: ScanDirection; confidence: ScanConfidence }> {
  if (confirmedDirection && confirmedConfidence) {
    if (confirmedConfidence === "65-74") {
      throw new Error(`Trade-card construction requires confirmed confidence >= 75 for ${symbol}.`);
    }
    return { direction: confirmedDirection, confidence: confirmedConfidence };
  }

  const review = await runSingleSymbolTradeStationAnalysis(symbol);
  if (review.conclusion !== "confirmed" || !review.direction || !review.confidence) {
    throw new Error(`Trade-card construction requires an upstream confirmed setup for ${symbol}.`);
  }

  if (review.confidence === "65-74") {
    throw new Error(`Trade-card construction requires confirmed confidence >= 75 for ${symbol}.`);
  }

  return {
    direction: review.direction,
    confidence: review.confidence,
  };
}

function findFirstNumberByKeys(value: unknown, keys: string[]): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findFirstNumberByKeys(item, keys);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = readNumber(record, [key]);
    if (direct !== null) {
      return direct;
    }
  }

  for (const nested of Object.values(record)) {
    const nestedValue = findFirstNumberByKeys(nested, keys);
    if (nestedValue !== null) {
      return nestedValue;
    }
  }

  return null;
}

async function resolveAccountEquity(get: (path: string) => Promise<Response>): Promise<{ equity: number; source: string }> {
  const fallbackText = process.env[FALLBACK_EQUITY_ENV];
  const fallbackValue = fallbackText ? Number(fallbackText) : null;

  try {
    const accountsResponse = await get("/brokerage/accounts");
    if (accountsResponse.ok) {
      const accountsPayload = await accountsResponse.json();
      const accountEntries = ((accountsPayload as Record<string, unknown>)?.Accounts ?? []) as unknown[];
      const accountObjects = Array.isArray(accountEntries)
        ? accountEntries.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        : [];

      const equityFromAccounts = findFirstNumberByKeys(accountObjects, [
        "NetLiquidationValue",
        "NetLiq",
        "TotalEquity",
        "TotalEquityValue",
        "Equity",
        "AccountValue",
      ]);
      if (equityFromAccounts !== null) {
        return { equity: equityFromAccounts, source: "brokerage/accounts payload" };
      }

      for (const account of accountObjects) {
        const accountId =
          (typeof account.AccountID === "string" ? account.AccountID : null) ??
          (typeof account.AccountId === "string" ? account.AccountId : null) ??
          (typeof account.AccountNumber === "string" ? account.AccountNumber : null);
        if (!accountId) {
          continue;
        }

        const balancesResponse = await get(`/brokerage/accounts/${encodeURIComponent(accountId)}/balances`);
        if (!balancesResponse.ok) {
          continue;
        }

        const balancesPayload = await balancesResponse.json();
        const equityFromBalances = findFirstNumberByKeys(balancesPayload, [
          "NetLiquidationValue",
          "NetLiq",
          "TotalEquity",
          "TotalEquityValue",
          "Equity",
          "AccountValue",
          "CashBalance",
        ]);
        if (equityFromBalances !== null) {
          return { equity: equityFromBalances, source: `brokerage/accounts/${accountId}/balances` };
        }
      }
    }
  } catch {
    // fall through to fallback path
  }

  if (fallbackValue !== null && Number.isFinite(fallbackValue) && fallbackValue > 0) {
    return { equity: fallbackValue, source: `${FALLBACK_EQUITY_ENV} env fallback` };
  }

  throw new Error(
    `Could not resolve account equity from TradeStation balances. Set ${FALLBACK_EQUITY_ENV} for manual fallback.`,
  );
}


async function buildTradeInputs(
  symbol: string,
  direction: ScanDirection,
): Promise<{ tradeInputs: TradeInputs; diagnostics: TradeConstructionDiagnostics }> {
  const get = await createTradeStationGetFetcher();

  const diagnostics: TradeConstructionDiagnostics = {
    selectedExpiration: null,
    strikesExpirationParam: null,
    strikesRequestTarget: null,
    strikesCountReturned: null,
    chosenStrike: null,
    attemptedOptionSymbols: [],
    optionQuoteRequestTargets: [],
    optionQuoteStatuses: [],
    chosenOptionSymbol: null,
    failureReason: null,
  };

  try {
    const quoteResponse = await get(`/marketdata/quotes/${encodeURIComponent(symbol)}`);
    if (!quoteResponse.ok) {
      throw new Error(`Failed to load quote for ${symbol} (${quoteResponse.status}).`);
    }

    const quotePayload = await quoteResponse.json();
    const quote = pickFirstObject(quotePayload, ["Quotes", "Quote", "Data"]);
    const underlyingPrice = readNumber(quote, ["Last", "LastTrade", "Trade", "Mark", "Close"]);
    if (underlyingPrice === null || underlyingPrice <= 0) {
      throw new Error(`Could not read underlying price for ${symbol}.`);
    }

    const expirationsResponse = await get(`/marketdata/options/expirations/${encodeURIComponent(symbol)}`);
    if (!expirationsResponse.ok) {
      throw new Error(`Failed to load options expirations for ${symbol} (${expirationsResponse.status}).`);
    }

    const expirations = readExpirations(await expirationsResponse.json());
    if (expirations.length === 0) {
      diagnostics.failureReason = `No valid options expirations found for ${symbol}.`;
      throw new Error(diagnostics.failureReason);
    }

    const targetExpiration = pickTargetExpiration(expirations, TARGET_DTE_MIN, TARGET_DTE_MAX, TARGET_DTE_CENTER);
    if (!targetExpiration) {
      diagnostics.failureReason = `Unable to pick target expiration for ${symbol}.`;
      throw new Error(diagnostics.failureReason);
    }

    diagnostics.selectedExpiration = targetExpiration.date;
    diagnostics.strikesExpirationParam = targetExpiration.apiValue;
    const strikesRequestTarget = `/marketdata/options/strikes/${encodeURIComponent(symbol)}?expiration=${encodeURIComponent(targetExpiration.apiValue)}`;
    diagnostics.strikesRequestTarget = strikesRequestTarget;

    const strikesResponse = await get(strikesRequestTarget);
    if (!strikesResponse.ok) {
      diagnostics.failureReason = `Failed to load options strikes for ${symbol} (${strikesResponse.status}).`;
      throw new Error(diagnostics.failureReason);
    }

    const { strikes: strikeContracts, normalizedStrikeCount } = readStrikes(await strikesResponse.json());
    diagnostics.strikesCountReturned = normalizedStrikeCount;
    if (strikeContracts.length === 0) {
      diagnostics.failureReason = `No options strikes found for ${symbol} on ${targetExpiration.date} (request ${strikesRequestTarget}).`;
      throw new Error(diagnostics.failureReason);
    }

    const selectedStrike = strikeContracts.sort((a, b) => Math.abs(a.strike - underlyingPrice) - Math.abs(b.strike - underlyingPrice))[0];
    if (!selectedStrike) {
      throw new Error(`No ATM-adjacent strike found for ${symbol} on ${targetExpiration.date}.`);
    }

    diagnostics.chosenStrike = selectedStrike.strike;

    const symbolsToTry = buildDirectOptionSymbols(symbol, targetExpiration.date, selectedStrike);
    diagnostics.attemptedOptionSymbols = symbolsToTry;

    const preferredTypePattern = direction === "bullish" ? /\s\d{6}C/i : /\s\d{6}P/i;
    const preferredSymbols = symbolsToTry.filter((candidateSymbol) => preferredTypePattern.test(candidateSymbol));
    const fallbackSymbols = symbolsToTry.filter((candidateSymbol) => !preferredSymbols.includes(candidateSymbol));
    const orderedSymbolsToTry = [...preferredSymbols, ...fallbackSymbols];
    diagnostics.attemptedOptionSymbols = orderedSymbolsToTry;

    const { quote: optionQuote, attempts } = await fetchFirstUsableDirectOptionQuote(get, orderedSymbolsToTry);
    diagnostics.optionQuoteRequestTargets = attempts.map((attempt) => attempt.requestTarget);
    diagnostics.optionQuoteStatuses = attempts.map((attempt) => attempt.status);

    if (!optionQuote) {
      diagnostics.failureReason = `No usable ${direction === "bullish" ? "call" : "put"} option quote found for ${symbol} ${targetExpiration.date}.`;
      throw new Error(diagnostics.failureReason);
    }

    diagnostics.chosenOptionSymbol = optionQuote.optionSymbol;
    const optionSymbol = optionQuote.optionSymbol;
    const optionMid = optionQuote.mid;

    const { equity, source } = await resolveAccountEquity(get);
    const allocation = equity * TARGET_ALLOCATION_PCT;

    const chartLevels = await evaluateChartAnchoredTradability(get, symbol, direction, underlyingPrice);
    if (!chartLevels.pass) {
      throw new Error(chartLevels.reason);
    }
    const { invalidationUnderlying, targetUnderlying } = chartLevels;

    const deltaAssumption = 0.5;
    const invalidationMove = invalidationUnderlying - underlyingPrice;
    const targetMove = targetUnderlying - underlyingPrice;
    const optionAtInvalidation = Math.max(0.05, optionMid + (direction === "bullish" ? invalidationMove : -invalidationMove) * deltaAssumption);
    const optionAtTarget = Math.max(0.05, optionMid + (direction === "bullish" ? targetMove : -targetMove) * deltaAssumption);

    const riskPerContract = Math.max(0.01, (optionMid - optionAtInvalidation) * 100);
    const rewardPerContract = Math.max(0.01, (optionAtTarget - optionMid) * 100);
    const contracts = Math.max(0, Math.floor(allocation / (optionMid * 100)));
    const notional = contracts * optionMid * 100;
    const totalRisk = contracts * riskPerContract;
    const totalReward = contracts * rewardPerContract;

    const tradeInputs: TradeInputs = {
      underlyingPrice,
      strike: selectedStrike.strike,
      expirationDate: targetExpiration.date,
      dte: targetExpiration.dte,
      optionSymbol,
      optionMid,
      equity,
      allocation,
      contracts,
      notional,
      invalidationUnderlying,
      targetUnderlying,
      optionAtInvalidation,
      optionAtTarget,
      invalidationReason: chartLevels.invalidationReason,
      targetReason: chartLevels.targetReason,
      riskPerContract,
      rewardPerContract,
      totalRisk,
      totalReward,
      equitySource: source,
    };

    return { tradeInputs, diagnostics };
  } catch (error) {
    if (error instanceof Error && diagnostics.failureReason === null) {
      diagnostics.failureReason = error.message;
    }

    if (process.env.SCANNER_DEBUG === "1") {
      console.log(
        `[trade:debug] ${symbol} ${direction} | selectedExpiration=${diagnostics.selectedExpiration ?? "n/a"} | strikesExpirationParam=${diagnostics.strikesExpirationParam ?? "n/a"} | strikesRequestTarget=${diagnostics.strikesRequestTarget ?? "n/a"} | strikesCountReturned=${diagnostics.strikesCountReturned ?? -1} | chosenStrike=${diagnostics.chosenStrike ?? "n/a"} | attemptedOptionSymbols=${diagnostics.attemptedOptionSymbols.join(",") || "n/a"} | optionQuoteTargets=${diagnostics.optionQuoteRequestTargets.join(",") || "n/a"} | optionQuoteStatuses=${diagnostics.optionQuoteStatuses.join(",") || "n/a"} | chosenOptionSymbol=${diagnostics.chosenOptionSymbol ?? "n/a"} | failureReason=${diagnostics.failureReason ?? "none"}`,
      );
    }

    throw error;
  }
}

export async function constructTradeCard(input: TradeConstructionInput): Promise<TradeConstructionResult> {
  const promptMatch = parseTradeConstructionPrompt(input.prompt);
  if (!promptMatch) {
    throw new Error("Invalid input prompt. Expected forms like: build trade OXY, trade setup OXY, or construct trade OXY.");
  }

  const symbol = promptMatch.symbol;
  const { direction, confidence } = await resolveDirectionAndConfidence(symbol, input.confirmedDirection, input.confirmedConfidence);
  const { tradeInputs: trade, diagnostics } = await buildTradeInputs(symbol, direction);

  const rrRatio = trade.totalRisk > 0 ? trade.totalReward / trade.totalRisk : 0;
  const directionLabel = direction === "bullish" ? "Bullish" : "Bearish";
  const thursdayBeforeExpiration = computeThursdayBeforeExpiration(trade.expirationDate);
  const timeExitDate = thursdayBeforeExpiration ?? trade.expirationDate;

  if (process.env.SCANNER_DEBUG === "1") {
    console.log(
      `[trade:debug] ${symbol} ${direction} | selectedExpiration=${diagnostics.selectedExpiration ?? "n/a"} | strikesExpirationParam=${diagnostics.strikesExpirationParam ?? "n/a"} | strikesRequestTarget=${diagnostics.strikesRequestTarget ?? "n/a"} | strikesCountReturned=${diagnostics.strikesCountReturned ?? -1} | chosenStrike=${diagnostics.chosenStrike ?? "n/a"} | attemptedOptionSymbols=${diagnostics.attemptedOptionSymbols.join(",") || "n/a"} | optionQuoteTargets=${diagnostics.optionQuoteRequestTargets.join(",") || "n/a"} | optionQuoteStatuses=${diagnostics.optionQuoteStatuses.join(",") || "n/a"} | chosenOptionSymbol=${diagnostics.chosenOptionSymbol ?? "n/a"} | failureReason=${diagnostics.failureReason ?? "none"} | equity=${trade.equity.toFixed(2)} (${trade.equitySource}) | allocation=${trade.allocation.toFixed(2)} | contracts=${trade.contracts} | option=${trade.optionSymbol} @ ${trade.optionMid.toFixed(2)}`,
    );
  }

  return {
    ticker: symbol,
    direction,
    confidence,
    expectedTiming: buildExpectedTiming(direction, confidence, trade),
    buy: `${trade.contracts}x ${trade.optionSymbol} @ ${renderMoney(trade.optionMid)} limit (capital used ${renderMoney(trade.notional)} of 33% allocation target ${renderMoney(trade.allocation)} from equity ${renderMoney(trade.equity)})`,
    invalidationExit: `Exit if ${symbol} breaks ${trade.invalidationUnderlying.toFixed(2)} (${trade.invalidationReason}; approx option ${renderMoney(trade.optionAtInvalidation)}).`,
    takeProfitExit: `Take profit near ${symbol} ${trade.targetUnderlying.toFixed(2)} (${trade.targetReason}; approx option ${renderMoney(trade.optionAtTarget)}).`,
    timeExit: `Exit on Thursday before expiration (${timeExitDate}), or sooner if option value decays by more than 25% from entry premium (${renderMoney(trade.optionMid)}).`,
    rrMath: `Risk/contract ${renderMoney(trade.riskPerContract)}, reward/contract ${renderMoney(trade.rewardPerContract)}; total risk ${renderMoney(trade.totalRisk)} vs total reward ${renderMoney(trade.totalReward)} (~${rrRatio.toFixed(2)}:1 reward:risk).`,
    rationale: `${directionLabel} setup follows confirmed review bias and uses nearest practical ATM ${trade.expirationDate} (${trade.dte} DTE) option with chart-anchored invalidation/target levels that satisfy minimum 2:1 structure. Pricing uses current premium plus a delta-based approximation; equity source: ${trade.equitySource}.`,
  };
}
