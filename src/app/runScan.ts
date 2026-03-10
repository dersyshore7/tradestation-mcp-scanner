import { getFakeConfidence, type ScanConfidence, type ScanDirection } from "../scanner/scoring.js";
import { createTradeStationGetFetcher } from "../tradestation/client.js";

const STARTER_UNIVERSE = ["AAPL", "MSFT", "NVDA", "AMZN", "META"] as const;
const STARTER_UNIVERSE_SET = new Set<string>(STARTER_UNIVERSE);

export type ScanInput = {
  prompt: string;
  excludedTickers?: string[];
};

export type ScanResult = {
  ticker: string | null;
  direction: ScanDirection | null;
  confidence: ScanConfidence | null;
  conclusion: "confirmed" | "rejected" | "no_trade_today";
  reason: string;
};

type SymbolPromptMatch = {
  action: "analyze" | "review" | "scan";
  symbol: string;
};

const NON_TICKER_TOKENS = new Set(["FOR", "THIS", "WEEK", "FIND", "BULLISH", "SETUPS", "NEW", "RUN"]);

type Stage1Candidate = {
  symbol: string;
  lastPrice: number;
  averageVolume: number | null;
};

type OptionsCandidate = Stage1Candidate & {
  targetExpiration: string;
  targetDte: number;
  optionOpenInterest: number;
  optionSpread: number;
  optionMid: number;
};

type Stage2SymbolDiagnostic = {
  symbol: string;
  expirationsFound: boolean;
  selectedExpiration: string | null;
  selectedDte: number | null;
  selectedExpirationApiValue: string | null;
  selectedStrike: number | null;
  evaluatedContract: string | null;
  bid: number | null;
  ask: number | null;
  spreadWidth: number | null;
  spreadPercent: number | null;
  openInterest: number | null;
  pass: boolean;
  reason: string;
};

type StrikeCandidate = {
  strike: number;
  callSymbol: string | null;
  putSymbol: string | null;
};

type ChartCandidate = OptionsCandidate & {
  chartDirection: ScanDirection;
  chartMovePct: number;
  volumeRatio: number | null;
};

function pickTicker(candidates: string[], excludedTickers: string[]): string | null {
  const excludedSet = new Set(excludedTickers.map((item) => item.toUpperCase()));
  const picked = candidates.find((ticker) => !excludedSet.has(ticker.toUpperCase()));
  return picked ?? null;
}

function isStarterUniverseTicker(symbol: string): boolean {
  return STARTER_UNIVERSE_SET.has(symbol.toUpperCase());
}

function logGeneralScanDebug(stage: string, symbols: string[]): void {
  if (process.env.SCANNER_DEBUG !== "1") {
    return;
  }

  console.log(`[scanner:debug] ${stage}: ${symbols.length > 0 ? symbols.join(", ") : "(none)"}`);
}

function logStage2Diagnostics(diagnostics: Stage2SymbolDiagnostic[]): void {
  if (process.env.SCANNER_DEBUG !== "1") {
    return;
  }

  for (const item of diagnostics) {
    console.log(`[scanner:debug:stage2] ${item.symbol}: ${JSON.stringify(item)}`);
  }
}

export function runFakeScan(input: ScanInput): ScanResult {
  const promptLower = input.prompt.toLowerCase();
  const excluded = input.excludedTickers ?? [];

  if (promptLower.includes("bullish")) {
    const ticker = pickTicker(["AAPL", "MSFT"], excluded);

    if (!ticker) {
      return {
        ticker: null,
        direction: null,
        confidence: null,
        conclusion: "no_trade_today",
        reason: "Bullish prompt detected, but all mock bullish tickers are excluded.",
      };
    }

    return {
      ticker,
      direction: "bullish",
      confidence: getFakeConfidence("bullish"),
      conclusion: "confirmed",
      reason: "Mock bullish signal matched your prompt.",
    };
  }

  if (promptLower.includes("bearish")) {
    const ticker = pickTicker(["NVDA", "META"], excluded);

    if (!ticker) {
      return {
        ticker: null,
        direction: null,
        confidence: null,
        conclusion: "no_trade_today",
        reason: "Bearish prompt detected, but all mock bearish tickers are excluded.",
      };
    }

    return {
      ticker,
      direction: "bearish",
      confidence: getFakeConfidence("bearish"),
      conclusion: "confirmed",
      reason: "Mock bearish signal matched your prompt.",
    };
  }

  return {
    ticker: null,
    direction: null,
    confidence: null,
    conclusion: "no_trade_today",
    reason: "No bullish or bearish keyword found in prompt.",
  };
}

function parseBars(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const objectPayload = payload as Record<string, unknown>;
  const bars = objectPayload["Bars"];
  if (Array.isArray(bars)) {
    return bars.filter((bar): bar is Record<string, unknown> => !!bar && typeof bar === "object");
  }

  return [];
}

function getDte(expirationDate: Date): number {
  const now = new Date();
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((expirationDate.getTime() - now.getTime()) / msPerDay);
}

function readExpirations(payload: unknown): { date: string; dte: number; apiValue: string }[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const objectPayload = payload as Record<string, unknown>;
  const rawExpirations = objectPayload["Expirations"];
  if (!Array.isArray(rawExpirations)) {
    return [];
  }

  const results: { date: string; dte: number; apiValue: string }[] = [];

  for (const entry of rawExpirations) {
    let dateText: string | null = null;
    if (typeof entry === "string") {
      dateText = entry;
    } else if (entry && typeof entry === "object") {
      const dateValue = (entry as Record<string, unknown>)["Date"];
      if (typeof dateValue === "string") {
        dateText = dateValue;
      }
    }

    if (!dateText) {
      continue;
    }

    const expirationDate = new Date(dateText);
    if (Number.isNaN(expirationDate.getTime())) {
      continue;
    }

    const dte = getDte(expirationDate);
    if (dte > 0) {
      results.push({ date: expirationDate.toISOString().slice(0, 10), dte, apiValue: dateText });
    }
  }

  return results;
}

function parseContracts(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const objectPayload = payload as Record<string, unknown>;
  const keys = ["Options", "OptionChain", "Contracts", "Calls", "Puts", "Strikes"];
  for (const key of keys) {
    const value = objectPayload[key];
    if (Array.isArray(value)) {
      return value.filter((contract): contract is Record<string, unknown> => !!contract && typeof contract === "object");
    }
  }

  return [];
}

function readText(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function readStrikes(payload: unknown): StrikeCandidate[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const objectPayload = payload as Record<string, unknown>;
  const rawStrikes = objectPayload["Strikes"];
  if (Array.isArray(rawStrikes) && rawStrikes.every((item) => typeof item === "number" || typeof item === "string")) {
    return rawStrikes
      .map((item) => (typeof item === "number" ? item : Number(item)))
      .filter((item): item is number => Number.isFinite(item))
      .map((strike) => ({ strike, callSymbol: null, putSymbol: null }))
      .sort((a, b) => a.strike - b.strike);
  }

  const contracts = parseContracts(payload);
  if (contracts.length === 0) {
    return [];
  }

  const results: StrikeCandidate[] = [];
  for (const contract of contracts) {
    const strike = readNumber(contract, ["Strike", "StrikePrice", "Price"]);
    if (strike === null) {
      continue;
    }

    const callSymbol = readText(contract, ["CallSymbol", "Call", "OptionSymbol", "Symbol"]);
    const putSymbol = readText(contract, ["PutSymbol", "Put"]);
    results.push({ strike, callSymbol, putSymbol });
  }

  const deduped = new Map<number, StrikeCandidate>();
  for (const strikeEntry of results) {
    if (!deduped.has(strikeEntry.strike)) {
      deduped.set(strikeEntry.strike, strikeEntry);
      continue;
    }

    const existing = deduped.get(strikeEntry.strike);
    if (!existing) {
      continue;
    }

    deduped.set(strikeEntry.strike, {
      strike: strikeEntry.strike,
      callSymbol: existing.callSymbol ?? strikeEntry.callSymbol,
      putSymbol: existing.putSymbol ?? strikeEntry.putSymbol,
    });
  }

  return [...deduped.values()].sort((a, b) => a.strike - b.strike);
}

function buildOptionSymbol(symbol: string, expirationDate: string, type: "C" | "P", strike: number): string {
  const [yearText, monthText, dayText] = expirationDate.split("-");
  const yearShort = yearText?.slice(-2) ?? "00";
  const month = monthText ?? "01";
  const day = dayText ?? "01";
  const strikeCode = Math.round(strike * 1000)
    .toString()
    .padStart(8, "0");
  return `${symbol.padEnd(6, " ")}${yearShort}${month}${day}${type}${strikeCode}`;
}

async function runStage2OptionsTradability(
  get: (path: string) => Promise<Response>,
  stage1Passed: Stage1Candidate[],
): Promise<{ passed: OptionsCandidate[]; diagnostics: Stage2SymbolDiagnostic[] }> {
  const stage2Passed: OptionsCandidate[] = [];
  const diagnostics: Stage2SymbolDiagnostic[] = [];

  for (const candidate of stage1Passed) {
    const diagnostic: Stage2SymbolDiagnostic = {
      symbol: candidate.symbol,
      expirationsFound: false,
      selectedExpiration: null,
      selectedDte: null,
      selectedExpirationApiValue: null,
      selectedStrike: null,
      evaluatedContract: null,
      bid: null,
      ask: null,
      spreadWidth: null,
      spreadPercent: null,
      openInterest: null,
      pass: false,
      reason: "Not evaluated.",
    };

    const expirationsResponse = await get(`/marketdata/options/expirations/${encodeURIComponent(candidate.symbol)}`);
    if (!expirationsResponse.ok) {
      diagnostic.reason = `Expirations request failed (${expirationsResponse.status}).`;
      diagnostics.push(diagnostic);
      continue;
    }

    const expirationsPayload = await expirationsResponse.json();
    const expirations = readExpirations(expirationsPayload);
    diagnostic.expirationsFound = expirations.length > 0;
    if (expirations.length === 0) {
      diagnostic.reason = "No valid future expirations found.";
      diagnostics.push(diagnostic);
      continue;
    }

    const inRange = expirations.filter((item) => item.dte >= 14 && item.dte <= 21);
    const targetExpiration = (inRange.length > 0 ? inRange : expirations).sort(
      (a, b) => Math.abs(a.dte - 17) - Math.abs(b.dte - 17),
    )[0];

    if (!targetExpiration) {
      diagnostic.reason = "Unable to pick target expiration.";
      diagnostics.push(diagnostic);
      continue;
    }

    diagnostic.selectedExpiration = targetExpiration.date;
    diagnostic.selectedDte = targetExpiration.dte;
    diagnostic.selectedExpirationApiValue = targetExpiration.apiValue;

    const strikesPath = `/marketdata/options/strikes/${encodeURIComponent(candidate.symbol)}?expiration=${encodeURIComponent(targetExpiration.apiValue)}`;
    const strikesResponse = await get(strikesPath);
    if (!strikesResponse.ok) {
      diagnostic.reason = `Strikes request failed (${strikesResponse.status}).`;
      diagnostics.push(diagnostic);
      continue;
    }

    const strikesPayload = await strikesResponse.json();
    const strikes = readStrikes(strikesPayload);
    if (strikes.length === 0) {
      diagnostic.reason = "No usable strikes returned for target expiration.";
      diagnostics.push(diagnostic);
      continue;
    }

    const selectedStrike = [...strikes].sort(
      (a, b) => Math.abs(a.strike - candidate.lastPrice) - Math.abs(b.strike - candidate.lastPrice),
    )[0];

    if (!selectedStrike) {
      diagnostic.reason = "Unable to select strike near underlying price.";
      diagnostics.push(diagnostic);
      continue;
    }

    diagnostic.selectedStrike = selectedStrike.strike;

    const symbolsToTry = [
      selectedStrike.callSymbol,
      selectedStrike.putSymbol,
      buildOptionSymbol(candidate.symbol, targetExpiration.date, "C", selectedStrike.strike),
      buildOptionSymbol(candidate.symbol, targetExpiration.date, "P", selectedStrike.strike),
      buildOptionSymbol(candidate.symbol, targetExpiration.date, "C", selectedStrike.strike).replace(/\s+/g, ""),
      buildOptionSymbol(candidate.symbol, targetExpiration.date, "P", selectedStrike.strike).replace(/\s+/g, ""),
    ].filter((item, index, list): item is string => {
      if (typeof item !== "string" || item.trim().length === 0) {
        return false;
      }

      return list.indexOf(item) === index;
    });

    let quoteData: { optionSymbol: string; openInterest: number; spread: number; mid: number; bid: number; ask: number } | null = null;
    for (const optionSymbol of symbolsToTry) {
      const optionQuoteResponse = await get(`/marketdata/quotes/${encodeURIComponent(optionSymbol)}`);
      if (!optionQuoteResponse.ok) {
        continue;
      }

      const optionQuotePayload = await optionQuoteResponse.json();
      const optionQuote = pickFirstQuote(optionQuotePayload);
      const openInterest = readNumber(optionQuote, ["OpenInterest", "OpenInt", "OI"]);
      const bid = readNumber(optionQuote, ["Bid"]);
      const ask = readNumber(optionQuote, ["Ask"]);
      if (openInterest === null || bid === null || ask === null || ask <= bid || bid <= 0) {
        continue;
      }

      const spread = ask - bid;
      const mid = (ask + bid) / 2;
      quoteData = { optionSymbol, openInterest, spread, mid, bid, ask };
      break;
    }

    if (!quoteData) {
      diagnostic.reason = "No usable direct option quote found for selected strike.";
      diagnostics.push(diagnostic);
      continue;
    }

    const spreadPct = quoteData.mid > 0 ? quoteData.spread / quoteData.mid : Number.POSITIVE_INFINITY;
    const hasTightSpread = quoteData.spread <= 1.5 && spreadPct <= 0.12;
    if (quoteData.openInterest <= 500) {
      diagnostic.evaluatedContract = quoteData.optionSymbol;
      diagnostic.bid = quoteData.bid;
      diagnostic.ask = quoteData.ask;
      diagnostic.spreadWidth = quoteData.spread;
      diagnostic.spreadPercent = spreadPct;
      diagnostic.openInterest = quoteData.openInterest;
      diagnostic.reason = "Candidate contract failed OI threshold (requires > 500).";
      diagnostics.push(diagnostic);
      continue;
    }

    if (!hasTightSpread) {
      diagnostic.evaluatedContract = quoteData.optionSymbol;
      diagnostic.bid = quoteData.bid;
      diagnostic.ask = quoteData.ask;
      diagnostic.spreadWidth = quoteData.spread;
      diagnostic.spreadPercent = spreadPct;
      diagnostic.openInterest = quoteData.openInterest;
      diagnostic.reason = "Candidate contract failed spread threshold (requires <= 1.5 and <= 12% of mid).";
      diagnostics.push(diagnostic);
      continue;
    }

    diagnostic.evaluatedContract = quoteData.optionSymbol;
    diagnostic.bid = quoteData.bid;
    diagnostic.ask = quoteData.ask;
    diagnostic.spreadWidth = quoteData.spread;
    diagnostic.spreadPercent = spreadPct;
    diagnostic.openInterest = quoteData.openInterest;
    diagnostic.pass = true;
    diagnostic.reason = "Passed Stage 2 filters.";

    stage2Passed.push({
      ...candidate,
      targetExpiration: targetExpiration.date,
      targetDte: targetExpiration.dte,
      optionOpenInterest: quoteData.openInterest,
      optionSpread: quoteData.spread,
      optionMid: quoteData.mid,
    });
    diagnostics.push(diagnostic);
  }

  return { passed: stage2Passed, diagnostics };
}

async function runStarterUniverseTradeStationScan(input: ScanInput): Promise<ScanResult> {
  const get = await createTradeStationGetFetcher();
  const excludedSet = new Set((input.excludedTickers ?? []).map((item) => item.toUpperCase()));
  const stage1Entered = STARTER_UNIVERSE.filter((symbol) => !excludedSet.has(symbol));
  logGeneralScanDebug("Stage 1 entered", stage1Entered);

  // Stage 1: basic stock filters
  const stage1Passed: Stage1Candidate[] = [];
  for (const symbol of STARTER_UNIVERSE) {
    if (excludedSet.has(symbol)) {
      continue;
    }

    const quoteResponse = await get(`/marketdata/quotes/${encodeURIComponent(symbol)}`);
    if (!quoteResponse.ok) {
      continue;
    }

    const quotePayload = await quoteResponse.json();
    const quote = pickFirstQuote(quotePayload);
    const lastPrice = readNumber(quote, ["Last", "LastTrade", "Trade", "Close"]);
    const averageVolume = readNumber(quote, ["AverageVolume", "AverageDailyVolume", "AvgVolume", "Volume"]);

    if (lastPrice === null || lastPrice < 10 || lastPrice > 500) {
      continue;
    }

    if (averageVolume !== null && averageVolume <= 1_000_000) {
      continue;
    }

    stage1Passed.push({ symbol, lastPrice, averageVolume });
  }

  logGeneralScanDebug(
    "Stage 1 passed",
    stage1Passed.map((candidate) => candidate.symbol),
  );

  if (stage1Passed.length === 0) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: "No symbols passed Stage 1 stock filters in the starter universe.",
    };
  }

  // Stage 2: options tradability filters
  const { passed: stage2Passed, diagnostics: stage2Diagnostics } = await runStage2OptionsTradability(get, stage1Passed);
  logStage2Diagnostics(stage2Diagnostics);

  logGeneralScanDebug(
    "Stage 2 passed",
    stage2Passed.map((candidate) => candidate.symbol),
  );

  if (stage2Passed.length === 0) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: "No symbols passed Stage 2 options tradability filters.",
    };
  }

  // Stage 3: simple bar/candlestick + volume review
  const stage3Passed: ChartCandidate[] = [];
  for (const candidate of stage2Passed) {
    const barsResponse = await get(
      `/marketdata/barcharts/${encodeURIComponent(candidate.symbol)}?interval=1&unit=Daily&barsback=20`,
    );
    if (!barsResponse.ok) {
      continue;
    }

    const barsPayload = await barsResponse.json();
    const bars = parseBars(barsPayload);
    if (bars.length < 10) {
      continue;
    }

    const firstBar = bars[0] ?? null;
    const lastBar = bars[bars.length - 1] ?? null;
    const firstClose = readNumber(firstBar, ["Close"]);
    const lastClose = readNumber(lastBar, ["Close"]);
    const lastVolume = readNumber(lastBar, ["TotalVolume", "Volume"]);

    let volumeSum = 0;
    let volumeCount = 0;
    for (const bar of bars.slice(0, -1)) {
      const barVolume = readNumber(bar, ["TotalVolume", "Volume"]);
      if (barVolume !== null) {
        volumeSum += barVolume;
        volumeCount += 1;
      }
    }

    if (firstClose === null || lastClose === null || firstClose === 0) {
      continue;
    }

    const movePct = ((lastClose - firstClose) / firstClose) * 100;
    const avgVolume = volumeCount > 0 ? volumeSum / volumeCount : null;
    const volumeRatio = avgVolume !== null && lastVolume !== null && avgVolume > 0 ? lastVolume / avgVolume : null;

    const hasVolumeSupport = volumeRatio === null || volumeRatio >= 0.8;
    if (!hasVolumeSupport) {
      continue;
    }

    if (movePct >= 1) {
      stage3Passed.push({ ...candidate, chartDirection: "bullish", chartMovePct: movePct, volumeRatio });
      continue;
    }

    if (movePct <= -1) {
      stage3Passed.push({ ...candidate, chartDirection: "bearish", chartMovePct: movePct, volumeRatio });
      continue;
    }
  }

  logGeneralScanDebug(
    "Stage 3 passed",
    stage3Passed.map((candidate) => candidate.symbol),
  );

  if (stage3Passed.length === 0) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: "No symbols passed Stage 3 chart/bar review.",
    };
  }

  // Stage 4: simple final score and pick
  const ranked = stage3Passed
    .map((candidate) => {
      const moveScore = Math.min(Math.abs(candidate.chartMovePct), 6);
      const oiScore = Math.min(candidate.optionOpenInterest / 500, 6);
      const spreadScore = Math.max(0, 3 - (candidate.optionSpread / Math.max(candidate.optionMid, 0.01)) * 10);
      const volumeScore = candidate.volumeRatio === null ? 1 : Math.min(candidate.volumeRatio, 2);
      const score = moveScore + oiScore + spreadScore + volumeScore;
      return { ...candidate, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: "No final candidate was available after scoring.",
    };
  }

  const confidence: ScanConfidence = best.score >= 14 ? "85-92" : best.score >= 10 ? "75-84" : "65-74";
  logGeneralScanDebug("Final selected", [best.symbol]);

  return {
    ticker: best.symbol,
    direction: best.chartDirection,
    confidence,
    conclusion: "confirmed",
    reason: `Passed 4-stage scan: price/volume, options (${best.targetDte} DTE, OI ${Math.round(best.optionOpenInterest)}), chart move ${best.chartMovePct.toFixed(2)}%.`,
  };
}

export async function runStage2DebugForStarterUniverse(): Promise<Stage2SymbolDiagnostic[]> {
  const get = await createTradeStationGetFetcher();
  const stage1Candidates: Stage1Candidate[] = STARTER_UNIVERSE.map((symbol) => ({
    symbol,
    lastPrice: 0,
    averageVolume: null,
  }));
  const { diagnostics } = await runStage2OptionsTradability(get, stage1Candidates);
  return diagnostics;
}

function parseSingleSymbolPrompt(prompt: string): SymbolPromptMatch | null {
  const matched = prompt.match(/(?:^|\s)(analyze|review|scan)\s+\$?([A-Za-z]{1,5})(?=\s|$|[,.!?;:])/i);

  if (!matched) {
    return null;
  }

  const actionRaw = matched[1];
  const symbolRaw = matched[2];
  if (!actionRaw || !symbolRaw) {
    return null;
  }

  const symbol = symbolRaw.toUpperCase();
  const isUppercaseTickerStyle = symbolRaw === symbol;
  const looksLikeTicker = /^[A-Z]{1,5}$/.test(symbol);
  if (!isUppercaseTickerStyle || !looksLikeTicker || NON_TICKER_TOKENS.has(symbol)) {
    return null;
  }

  return {
    action: actionRaw.toLowerCase() as SymbolPromptMatch["action"],
    symbol,
  };
}

function pickFirstQuote(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (Array.isArray(payload)) {
    return (payload[0] as Record<string, unknown>) ?? null;
  }

  const objectPayload = payload as Record<string, unknown>;
  const quotes = objectPayload["Quotes"];
  if (Array.isArray(quotes)) {
    return (quotes[0] as Record<string, unknown>) ?? null;
  }

  return objectPayload;
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
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

async function fetchRecentCloseChange(get: (path: string) => Promise<Response>, symbol: string): Promise<number | null> {
  const response = await get(
    `/marketdata/barcharts/${encodeURIComponent(symbol)}?interval=5&unit=Minute&barsback=5`,
  );

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const bars = payload["Bars"];
  if (!Array.isArray(bars) || bars.length < 2) {
    return null;
  }

  const firstClose = readNumber(bars[0] as Record<string, unknown>, ["Close"]);
  const lastClose = readNumber(bars[bars.length - 1] as Record<string, unknown>, ["Close"]);

  if (firstClose === null || lastClose === null || firstClose === 0) {
    return null;
  }

  return ((lastClose - firstClose) / firstClose) * 100;
}

async function runSingleSymbolTradeStationAnalysis(symbol: string): Promise<ScanResult> {
  const get = await createTradeStationGetFetcher();
  const quoteResponse = await get(`/marketdata/quotes/${encodeURIComponent(symbol)}`);

  if (!quoteResponse.ok) {
    const bodyText = await quoteResponse.text();
    throw new Error(`Quote request failed (${quoteResponse.status}): ${bodyText}`);
  }

  const quotePayload = await quoteResponse.json();
  const quote = pickFirstQuote(quotePayload);
  const last = readNumber(quote, ["Last", "LastTrade", "Trade", "Close"]);
  const previousClose = readNumber(quote, ["PreviousClose", "PrevClose", "Close"]);
  const intradayBarChangePct = await fetchRecentCloseChange(get, symbol).catch(() => null);

  if (last !== null && previousClose !== null && previousClose !== 0) {
    const quoteChangePct = ((last - previousClose) / previousClose) * 100;

    if (quoteChangePct >= 0.4) {
      return {
        ticker: symbol,
        direction: "bullish",
        confidence: "75-84",
        conclusion: "confirmed",
        reason: `Quote is up ${quoteChangePct.toFixed(2)}% vs previous close (${last.toFixed(2)} vs ${previousClose.toFixed(2)}).`,
      };
    }

    if (quoteChangePct <= -0.4) {
      return {
        ticker: symbol,
        direction: "bearish",
        confidence: "75-84",
        conclusion: "confirmed",
        reason: `Quote is down ${Math.abs(quoteChangePct).toFixed(2)}% vs previous close (${last.toFixed(2)} vs ${previousClose.toFixed(2)}).`,
      };
    }
  }

  if (intradayBarChangePct !== null) {
    if (intradayBarChangePct > 0.2) {
      return {
        ticker: symbol,
        direction: "bullish",
        confidence: "65-74",
        conclusion: "confirmed",
        reason: `Recent intraday bars are trending up (${intradayBarChangePct.toFixed(2)}% over recent bars).`,
      };
    }

    if (intradayBarChangePct < -0.2) {
      return {
        ticker: symbol,
        direction: "bearish",
        confidence: "65-74",
        conclusion: "confirmed",
        reason: `Recent intraday bars are trending down (${intradayBarChangePct.toFixed(2)}% over recent bars).`,
      };
    }
  }

  return {
    ticker: symbol,
    direction: null,
    confidence: null,
    conclusion: "no_trade_today",
    reason: "Price change is too small for this simple first-pass check.",
  };
}

export async function runScan(input: ScanInput): Promise<ScanResult> {
  const symbolMatch = parseSingleSymbolPrompt(input.prompt);
  if (!symbolMatch) {
    const enforceStarterUniverse = (result: ScanResult): ScanResult => {
      if (!result.ticker || isStarterUniverseTicker(result.ticker)) {
        return result;
      }

      return {
        ticker: null,
        direction: null,
        confidence: null,
        conclusion: "no_trade_today",
        reason: `General scan mode is limited to starter universe (${STARTER_UNIVERSE.join(", ")}).`,
      };
    };

    try {
      return enforceStarterUniverse(await runStarterUniverseTradeStationScan(input));
    } catch {
      return enforceStarterUniverse(runFakeScan(input));
    }
  }

  const excluded = new Set((input.excludedTickers ?? []).map((item) => item.toUpperCase()));
  if (excluded.has(symbolMatch.symbol)) {
    return {
      ticker: null,
      direction: null,
      confidence: null,
      conclusion: "no_trade_today",
      reason: `${symbolMatch.symbol} is in excludedTickers.`,
    };
  }

  return runSingleSymbolTradeStationAnalysis(symbolMatch.symbol);
}
