import { createTradeStationGetFetcher } from "../tradestation/client.js";
import { type ScanConfidence, type ScanDirection } from "../scanner/scoring.js";
import { runSingleSymbolTradeStationAnalysis } from "./runScan.js";

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
  buy: string;
  invalidationExit: string;
  takeProfitExit: string;
  timeExit: string;
  rrMath: string;
  rationale: string;
};

type ExpirationEntry = { date: string; apiValue: string; dte: number };

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
  riskPerContract: number;
  rewardPerContract: number;
  totalRisk: number;
  totalReward: number;
  equitySource: string;
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

function getDte(date: Date): number {
  return Math.round((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function parseExpirations(payload: unknown): ExpirationEntry[] {
  const entries = ((payload as Record<string, unknown> | null)?.Expirations ?? []) as unknown[];
  if (!Array.isArray(entries)) {
    return [];
  }

  const parsed: ExpirationEntry[] = [];
  for (const item of entries) {
    const apiValue =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? ((item as Record<string, unknown>).Date as string | undefined)
          : undefined;
    if (!apiValue) {
      continue;
    }

    const date = new Date(apiValue);
    if (Number.isNaN(date.getTime())) {
      continue;
    }

    const dte = getDte(date);
    if (dte <= 0) {
      continue;
    }

    parsed.push({ date: date.toISOString().slice(0, 10), apiValue, dte });
  }

  return parsed;
}

function parseStrikeContracts(payload: unknown): { strike: number; callSymbol: string | null; putSymbol: string | null }[] {
  const entries = ((payload as Record<string, unknown> | null)?.Strikes ?? []) as unknown[];
  const results: { strike: number; callSymbol: string | null; putSymbol: string | null }[] = [];

  if (!Array.isArray(entries)) {
    return results;
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const strike = readNumber(entry as Record<string, unknown>, ["Strike", "StrikePrice", "Price"]);
    if (strike === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const callSymbol = typeof record.Call === "string" ? record.Call : typeof record.CallSymbol === "string" ? record.CallSymbol : null;
    const putSymbol = typeof record.Put === "string" ? record.Put : typeof record.PutSymbol === "string" ? record.PutSymbol : null;

    results.push({ strike, callSymbol, putSymbol });
  }

  return results;
}

function renderMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

async function resolveDirectionAndConfidence(
  symbol: string,
  confirmedDirection?: ScanDirection,
  confirmedConfidence?: ScanConfidence,
): Promise<{ direction: ScanDirection; confidence: ScanConfidence }> {
  if (confirmedDirection && confirmedConfidence) {
    return { direction: confirmedDirection, confidence: confirmedConfidence };
  }

  const review = await runSingleSymbolTradeStationAnalysis(symbol);
  if (!review.direction) {
    throw new Error(`Could not infer direction from single-symbol review for ${symbol}.`);
  }

  return {
    direction: confirmedDirection ?? review.direction,
    confidence: confirmedConfidence ?? review.confidence ?? "65-74",
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

async function buildTradeInputs(symbol: string, direction: ScanDirection): Promise<TradeInputs> {
  const get = await createTradeStationGetFetcher();

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

  const expirations = parseExpirations(await expirationsResponse.json());
  if (expirations.length === 0) {
    throw new Error(`No valid options expirations found for ${symbol}.`);
  }

  const targetExpiration = (expirations.filter((item) => item.dte >= TARGET_DTE_MIN && item.dte <= TARGET_DTE_MAX).sort(
    (a, b) => Math.abs(a.dte - TARGET_DTE_CENTER) - Math.abs(b.dte - TARGET_DTE_CENTER),
  )[0] ??
    expirations.sort((a, b) => Math.abs(a.dte - TARGET_DTE_CENTER) - Math.abs(b.dte - TARGET_DTE_CENTER))[0]) as ExpirationEntry;

  const strikesResponse = await get(
    `/marketdata/options/strikes/${encodeURIComponent(symbol)}?expiration=${encodeURIComponent(targetExpiration.apiValue)}`,
  );
  if (!strikesResponse.ok) {
    throw new Error(`Failed to load options strikes for ${symbol} (${strikesResponse.status}).`);
  }

  const strikeContracts = parseStrikeContracts(await strikesResponse.json());
  if (strikeContracts.length === 0) {
    throw new Error(`No options strikes found for ${symbol} on ${targetExpiration.date}.`);
  }

  const selectedStrike = strikeContracts.sort((a, b) => Math.abs(a.strike - underlyingPrice) - Math.abs(b.strike - underlyingPrice))[0];
  if (!selectedStrike) {
    throw new Error(`No ATM-adjacent strike found for ${symbol} on ${targetExpiration.date}.`);
  }

  const optionSymbol = direction === "bullish" ? selectedStrike.callSymbol : selectedStrike.putSymbol;
  if (!optionSymbol) {
    throw new Error(`No ${direction === "bullish" ? "call" : "put"} symbol found for ${symbol} ${targetExpiration.date}.`);
  }

  const optionQuoteResponse = await get(`/marketdata/quotes/${encodeURIComponent(optionSymbol)}`);
  if (!optionQuoteResponse.ok) {
    throw new Error(`Failed to load option quote for ${optionSymbol} (${optionQuoteResponse.status}).`);
  }

  const optionQuote = pickFirstObject(await optionQuoteResponse.json(), ["Quotes", "Quote", "Data"]);
  const bid = readNumber(optionQuote, ["Bid", "BestBid"]);
  const ask = readNumber(optionQuote, ["Ask", "BestAsk"]);
  const last = readNumber(optionQuote, ["Last", "Trade", "Mark"]);
  const optionMid = bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : last;
  if (optionMid === null || optionMid <= 0) {
    throw new Error(`Could not derive option entry premium for ${optionSymbol}.`);
  }

  const { equity, source } = await resolveAccountEquity(get);
  const allocation = equity * TARGET_ALLOCATION_PCT;

  const underlyingMovePct = 0.02;
  const invalidationUnderlying = direction === "bullish" ? underlyingPrice * (1 - underlyingMovePct) : underlyingPrice * (1 + underlyingMovePct);
  const targetUnderlying = direction === "bullish" ? underlyingPrice * (1 + underlyingMovePct * 2) : underlyingPrice * (1 - underlyingMovePct * 2);

  const deltaAssumption = 0.5;
  const invalidationMove = invalidationUnderlying - underlyingPrice;
  const targetMove = targetUnderlying - underlyingPrice;
  const optionAtInvalidation = Math.max(0.05, optionMid + (direction === "bullish" ? invalidationMove : -invalidationMove) * deltaAssumption);
  const optionAtTarget = Math.max(0.05, optionMid + (direction === "bullish" ? targetMove : -targetMove) * deltaAssumption);

  const riskPerContract = Math.max(0.01, (optionMid - optionAtInvalidation) * 100);
  const rewardPerContract = Math.max(0.01, (optionAtTarget - optionMid) * 100);
  const contracts = Math.max(1, Math.floor(allocation / riskPerContract));
  const notional = contracts * optionMid * 100;
  const totalRisk = contracts * riskPerContract;
  const totalReward = contracts * rewardPerContract;

  return {
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
    riskPerContract,
    rewardPerContract,
    totalRisk,
    totalReward,
    equitySource: source,
  };
}

export async function constructTradeCard(input: TradeConstructionInput): Promise<TradeConstructionResult> {
  const promptMatch = parseTradeConstructionPrompt(input.prompt);
  if (!promptMatch) {
    throw new Error("Invalid input prompt. Expected forms like: build trade OXY, trade setup OXY, or construct trade OXY.");
  }

  const symbol = promptMatch.symbol;
  const { direction, confidence } = await resolveDirectionAndConfidence(symbol, input.confirmedDirection, input.confirmedConfidence);
  const trade = await buildTradeInputs(symbol, direction);

  const rrRatio = trade.totalRisk > 0 ? trade.totalReward / trade.totalRisk : 0;
  const directionLabel = direction === "bullish" ? "Bullish" : "Bearish";

  if (process.env.SCANNER_DEBUG === "1") {
    console.log(
      `[trade:debug] ${symbol} ${direction} | equity=${trade.equity.toFixed(2)} (${trade.equitySource}) | allocation=${trade.allocation.toFixed(2)} | contracts=${trade.contracts} | option=${trade.optionSymbol} @ ${trade.optionMid.toFixed(2)}`,
    );
  }

  return {
    ticker: symbol,
    direction,
    confidence,
    buy: `${trade.contracts}x ${trade.optionSymbol} @ ${renderMoney(trade.optionMid)} limit (approx capital ${renderMoney(trade.notional)}, 33% allocation target ${renderMoney(trade.allocation)} from equity ${renderMoney(trade.equity)})`,
    invalidationExit: `Exit if ${symbol} trades through ${trade.invalidationUnderlying.toFixed(2)} (approx option ${renderMoney(trade.optionAtInvalidation)}).`,
    takeProfitExit: `Take profit near ${symbol} ${trade.targetUnderlying.toFixed(2)} (approx option ${renderMoney(trade.optionAtTarget)}).`,
    timeExit: `Exit by DTE <= 7 or after 7 calendar days, whichever comes first (selected ${trade.dte} DTE ${trade.expirationDate}).`,
    rrMath: `Risk/contract ${renderMoney(trade.riskPerContract)}, reward/contract ${renderMoney(trade.rewardPerContract)}; total risk ${renderMoney(trade.totalRisk)} vs total reward ${renderMoney(trade.totalReward)} (~${rrRatio.toFixed(2)}:1 reward:risk).`,
    rationale: `${directionLabel} setup follows confirmed review bias and uses nearest practical ATM ${trade.expirationDate} (${trade.dte} DTE) option for a simple first-pass 2:1 structure. Pricing uses current premium plus a delta-based approximation; equity source: ${trade.equitySource}.`,
  };
}
