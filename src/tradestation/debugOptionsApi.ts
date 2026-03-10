import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTradeStationGetFetcher } from "./client.js";

type ExpirationCandidate = {
  apiValue: string;
  dateOnly: string;
  dte: number;
};

type ProbeResult = {
  path: string;
  status: number;
  ok: boolean;
  bodyText: string;
  bodyJson: unknown | null;
};

function loadDotEnvFileIfPresent(): void {
  const envPath = resolve(process.cwd(), ".env");

  try {
    const contents = readFileSync(envPath, "utf8");

    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional.
  }
}

function getDte(targetDate: Date): number {
  const now = new Date();
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((targetDate.getTime() - now.getTime()) / msPerDay);
}

function parseExpirations(payload: unknown): ExpirationCandidate[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const raw = (payload as Record<string, unknown>)["Expirations"];
  if (!Array.isArray(raw)) {
    return [];
  }

  const parsed: ExpirationCandidate[] = [];

  for (const entry of raw) {
    const apiValue =
      typeof entry === "string"
        ? entry
        : typeof entry === "object" && entry
          ? ((entry as Record<string, unknown>)["Date"] as string | undefined)
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

    parsed.push({
      apiValue,
      dateOnly: date.toISOString().slice(0, 10),
      dte,
    });
  }

  return parsed;
}

function parseJsonMaybe(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function probe(get: (path: string) => Promise<Response>, path: string): Promise<ProbeResult> {
  const response = await get(path);
  const bodyText = await response.text();
  const bodyJson = parseJsonMaybe(bodyText);

  console.log("\n=== Probe ===");
  console.log(`target: ${path}`);
  console.log(`http status: ${response.status}`);
  if (bodyJson !== null) {
    console.log("parsed body:");
    console.log(JSON.stringify(bodyJson, null, 2));
  } else {
    console.log("raw body:");
    console.log(bodyText || "(empty)");
  }

  return {
    path,
    status: response.status,
    ok: response.ok,
    bodyText,
    bodyJson,
  };
}

function readNumber(source: Record<string, unknown>, keys: string[]): number | null {
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

function collectSymbolCandidates(payload: unknown): string[] {
  const results = new Set<string>();

  function visit(value: unknown): void {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    const obj = value as Record<string, unknown>;
    for (const [key, fieldValue] of Object.entries(obj)) {
      if (
        typeof fieldValue === "string" &&
        ["Symbol", "OptionSymbol", "CallSymbol", "PutSymbol"].includes(key) &&
        fieldValue.trim().length > 0
      ) {
        results.add(fieldValue.trim());
      }
      visit(fieldValue);
    }
  }

  visit(payload);
  return [...results];
}

function renderViabilitySummary(label: string, result: ProbeResult): void {
  const viable = result.ok ? "YES" : "NO";
  console.log(`viable-for-stage2(${label}): ${viable}`);
}

async function main(): Promise<void> {
  loadDotEnvFileIfPresent();

  const symbol = "AAPL";
  const get = await createTradeStationGetFetcher();

  console.log(`TradeStation options API debug for ${symbol}`);

  const expirationsResult = await probe(get, `/marketdata/options/expirations/${encodeURIComponent(symbol)}`);
  renderViabilitySummary("expirations", expirationsResult);

  if (!expirationsResult.ok || !expirationsResult.bodyJson) {
    console.log("Cannot continue: expirations request did not return JSON payload.");
    return;
  }

  const expirations = parseExpirations(expirationsResult.bodyJson);
  console.log("\nParsed expirations:");
  console.log(JSON.stringify(expirations, null, 2));

  const target = (expirations.filter((item) => item.dte >= 14 && item.dte <= 21).sort((a, b) => a.dte - b.dte)[0] ??
    expirations[0]) as ExpirationCandidate | undefined;

  if (!target) {
    console.log("No future expiration found, stopping debug.");
    return;
  }

  console.log(`\nSelected target expiration for 14-21 DTE checks: ${target.dateOnly} (dte=${target.dte})`);

  const chainPaths = [
    `/v3/marketdata/options/chains/${encodeURIComponent(symbol)}?expiration=${encodeURIComponent(target.dateOnly)}`,
    `/marketdata/options/chains/${encodeURIComponent(symbol)}?expiration=${encodeURIComponent(target.dateOnly)}`,
    `/marketdata/options/chains/${encodeURIComponent(symbol)}?expiration=${encodeURIComponent(target.apiValue)}`,
  ];

  const chainResults: ProbeResult[] = [];
  for (const path of chainPaths) {
    chainResults.push(await probe(get, path));
  }

  const workingChain = chainResults.find((item) => item.ok);
  const firstChainAttempt = chainResults[0];
  if (workingChain) {
    renderViabilitySummary("chain-endpoint", workingChain);
  } else if (firstChainAttempt) {
    renderViabilitySummary("chain-endpoint", firstChainAttempt);
  }

  if (workingChain) {
    console.log("\nChain endpoint is viable; Stage 2 can use this path once request shape is confirmed.");
    return;
  }

  console.log("\nChain endpoint still failing. Probing strikes + direct option quotes.");

  const strikesPath = `/marketdata/options/strikes/${encodeURIComponent(symbol)}?expiration=${encodeURIComponent(target.apiValue)}`;
  const strikesResult = await probe(get, strikesPath);
  renderViabilitySummary("strikes-endpoint", strikesResult);

  const optionSymbols = collectSymbolCandidates(strikesResult.bodyJson);
  const sampledOptionSymbols = optionSymbols.slice(0, 2);

  if (sampledOptionSymbols.length === 0) {
    console.log("No option symbols discovered from strikes payload; cannot test direct option quote path yet.");
    return;
  }

  for (const optionSymbol of sampledOptionSymbols) {
    const quoteResult = await probe(get, `/marketdata/quotes/${encodeURIComponent(optionSymbol)}`);
    const quoteObject =
      quoteResult.bodyJson && typeof quoteResult.bodyJson === "object" ? (quoteResult.bodyJson as Record<string, unknown>) : null;
    const firstQuote =
      quoteObject && Array.isArray(quoteObject["Quotes"]) && quoteObject["Quotes"][0] && typeof quoteObject["Quotes"][0] === "object"
        ? (quoteObject["Quotes"][0] as Record<string, unknown>)
        : quoteObject;

    let bid: number | null = null;
    let ask: number | null = null;
    let openInterest: number | null = null;
    if (firstQuote && typeof firstQuote === "object") {
      bid = readNumber(firstQuote, ["Bid"]);
      ask = readNumber(firstQuote, ["Ask"]);
      openInterest = readNumber(firstQuote, ["OpenInterest", "OpenInt", "OI"]);
    }

    const spread = bid !== null && ask !== null ? ask - bid : null;
    console.log("key option quote fields:");
    console.log(JSON.stringify({ optionSymbol, bid, ask, spread, openInterest }, null, 2));
    console.log(`viable-for-stage2(option-quote:${optionSymbol}): ${quoteResult.ok && bid !== null && ask !== null ? "YES" : "NO"}`);
  }

  console.log("\nDebug complete. Use the viable path above for Stage 2 endpoint updates.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
