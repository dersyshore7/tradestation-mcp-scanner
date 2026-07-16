const FMP_API_KEY_ENV = "FMP_API_KEY";
const FMP_BASE_URL = "https://financialmodelingprep.com";

export type FmpCongressionalTradeSignal = {
  symbol: string;
  action: "buy" | "sell";
  politician: string | null;
  chamber: "house" | "senate" | "unknown";
  transactionDate: string | null;
  filingDate: string | null;
  amount: string | null;
  sourceUrl: string;
  raw: Record<string, unknown>;
};

export type FmpStockNewsItem = {
  id: string;
  title: string;
  symbol: string | null;
  tickers: string[];
  publishedAt: string | null;
  site: string | null;
  url: string | null;
  text: string | null;
  raw: Record<string, unknown>;
};

export type FmpSourceResult<T> = {
  items: T[];
  warning: string | null;
};

function readFmpApiKey(): string | null {
  const value = process.env[FMP_API_KEY_ENV];
  return value && value.trim().length > 0 ? value.trim() : null;
}

export function hasFmpApiKey(): boolean {
  return readFmpApiKey() !== null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function readString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(row[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function normalizeSymbol(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const cleaned = value
    .trim()
    .toUpperCase()
    .replace(/^\$/, "")
    .replace(/\s+US$/, "")
    .replace(/\.US$/, "");
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(cleaned) ? cleaned : null;
}

function readSymbols(row: Record<string, unknown>): string[] {
  const values = [
    row.symbol,
    row.ticker,
    row.tickers,
    row.symbols,
    row.assetSymbol,
    row.asset_symbol,
    row.securityTicker,
  ];
  return [...new Set(values.flatMap((value) => {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeSymbol(asString(item))).filter((item): item is string => item !== null);
    }
    return (asString(value) ?? "")
      .split(/[,\s]+/)
      .map((item) => normalizeSymbol(item))
      .filter((item): item is string => item !== null);
  }))];
}

function normalizeCongressionalAction(row: Record<string, unknown>): "buy" | "sell" | null {
  const raw = readString(row, [
    "transactionType",
    "transaction_type",
    "transaction",
    "type",
    "action",
  ])?.toLowerCase() ?? "";

  if (/\b(purchase|buy|bought|acquisition)\b/.test(raw)) {
    return "buy";
  }
  if (/\b(sale|sell|sold|disposal)\b/.test(raw)) {
    return "sell";
  }
  return null;
}

function rowsFromPayload(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.map(asRecord).filter((row): row is Record<string, unknown> => row !== null);
  }
  const record = asRecord(payload);
  if (!record) {
    return [];
  }
  for (const key of ["data", "items", "results", "records"]) {
    const rows = record[key];
    if (Array.isArray(rows)) {
      return rows.map(asRecord).filter((row): row is Record<string, unknown> => row !== null);
    }
  }
  return [record];
}

async function fetchFmpJson(path: string, params: Record<string, string | number> = {}): Promise<unknown> {
  const apiKey = readFmpApiKey();
  if (!apiKey) {
    throw new Error(`Missing ${FMP_API_KEY_ENV}; FMP-backed virtual automations cannot load source data.`);
  }

  const url = new URL(path, FMP_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url);
  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`FMP request failed (${response.status}) for ${path}: ${text || "No response body."}`);
  }
  return payload;
}

function toCongressionalTradeSignal(
  row: Record<string, unknown>,
  chamber: "house" | "senate",
  sourceUrl: string,
): FmpCongressionalTradeSignal | null {
  const symbol = readSymbols(row)[0] ?? null;
  const action = normalizeCongressionalAction(row);
  if (!symbol || !action) {
    return null;
  }
  return {
    symbol,
    action,
    politician: readString(row, ["representative", "senator", "name", "member", "politician"]),
    chamber,
    transactionDate: readString(row, ["transactionDate", "transaction_date", "date", "traded"]),
    filingDate: readString(row, ["filingDate", "filing_date", "disclosureDate", "filed"]),
    amount: readString(row, ["amount", "transactionAmount", "amountRange", "range"]),
    sourceUrl,
    raw: row,
  };
}

export async function loadFmpCongressionalTradeSignals(limit = 100): Promise<FmpSourceResult<FmpCongressionalTradeSignal>> {
  try {
    const [housePayload, senatePayload] = await Promise.all([
      fetchFmpJson("/stable/house-latest", { page: 0, limit }),
      fetchFmpJson("/stable/senate-latest", { page: 0, limit }),
    ]);
    const house = rowsFromPayload(housePayload)
      .map((row) => toCongressionalTradeSignal(row, "house", "/stable/house-latest"))
      .filter((item): item is FmpCongressionalTradeSignal => item !== null);
    const senate = rowsFromPayload(senatePayload)
      .map((row) => toCongressionalTradeSignal(row, "senate", "/stable/senate-latest"))
      .filter((item): item is FmpCongressionalTradeSignal => item !== null);

    return {
      items: [...house, ...senate].slice(0, limit),
      warning: null,
    };
  } catch (error) {
    return {
      items: [],
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

function toStockNewsItem(row: Record<string, unknown>, index: number): FmpStockNewsItem | null {
  const title = readString(row, ["title", "headline"]);
  if (!title) {
    return null;
  }
  const tickers = readSymbols(row);
  const publishedAt = readString(row, ["publishedDate", "published_at", "publishedAt", "date"]);
  const url = readString(row, ["url", "link", "article_url"]);
  return {
    id: readString(row, ["id", "uuid"]) ?? `${publishedAt ?? "unknown"}:${title}:${index}`,
    title,
    symbol: tickers[0] ?? null,
    tickers,
    publishedAt,
    site: readString(row, ["site", "source", "publisher"]),
    url,
    text: readString(row, ["text", "summary", "content", "description"]),
    raw: row,
  };
}

export async function loadFmpStockNews(limit = 20): Promise<FmpSourceResult<FmpStockNewsItem>> {
  try {
    const payload = await fetchFmpJson("/stable/news/stock-latest", { page: 0, limit });
    return {
      items: rowsFromPayload(payload)
        .map(toStockNewsItem)
        .filter((item): item is FmpStockNewsItem => item !== null)
        .slice(0, limit),
      warning: null,
    };
  } catch (error) {
    return {
      items: [],
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}
