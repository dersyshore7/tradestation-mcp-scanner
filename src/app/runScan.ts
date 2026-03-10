import { getFakeConfidence, type ScanConfidence, type ScanDirection } from "../scanner/scoring.js";
import { createTradeStationGetFetcher } from "../tradestation/client.js";

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

function pickTicker(candidates: string[], excludedTickers: string[]): string | null {
  const excludedSet = new Set(excludedTickers.map((item) => item.toUpperCase()));
  const picked = candidates.find((ticker) => !excludedSet.has(ticker.toUpperCase()));
  return picked ?? null;
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
    const ticker = pickTicker(["AAPL", "TSLA"], excluded);

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

function parseSingleSymbolPrompt(prompt: string): SymbolPromptMatch | null {
  const matched = prompt.match(/\b(analyze|review|scan)\s+\$?([A-Za-z]{1,5})\b/i);

  if (!matched) {
    return null;
  }

  const actionRaw = matched[1];
  const symbolRaw = matched[2];
  if (!actionRaw || !symbolRaw) {
    return null;
  }

  return {
    action: actionRaw.toLowerCase() as SymbolPromptMatch["action"],
    symbol: symbolRaw.toUpperCase(),
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
    return runFakeScan(input);
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
