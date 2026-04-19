import { createTradeStationFetcher } from "../tradestation/client.js";

export type TradeStationOrderType = "Market" | "Limit" | "Stop" | "StopLimit";
export type TradeStationTradeAction =
  | "BUY"
  | "SELL"
  | "BUYTOOPEN"
  | "BUYTOCLOSE"
  | "SELLTOOPEN"
  | "SELLTOCLOSE";
export type TradeStationDuration = "DAY" | "GTC" | "GTD" | "DYP" | "GCP";

export type TradeStationOrderRequest = {
  accountId: string;
  symbol: string;
  quantity: number;
  orderType: TradeStationOrderType;
  tradeAction: TradeStationTradeAction;
  limitPrice?: number;
  stopPrice?: number;
  duration?: TradeStationDuration;
};

export type TradeStationOrderResult = {
  orderId: string | null;
  status: string | null;
  averageFillPrice: number | null;
  raw: unknown;
};

export type TradeStationQuoteSnapshot = {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  raw: unknown;
};

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as JsonObject;
}

function pickFirstObject(payload: unknown, keys: string[]): JsonObject | null {
  if (Array.isArray(payload)) {
    const first = payload[0];
    return asObject(first);
  }

  const objectPayload = asObject(payload);
  if (!objectPayload) {
    return null;
  }

  for (const key of keys) {
    const nested = objectPayload[key];
    if (Array.isArray(nested)) {
      const first = nested[0];
      const objectFirst = asObject(first);
      if (objectFirst) {
        return objectFirst;
      }
    }

    const objectNested = asObject(nested);
    if (objectNested) {
      return objectNested;
    }
  }

  return objectPayload;
}

function readNumber(source: JsonObject | null, keys: string[]): number | null {
  if (!source) {
    return null;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.trim().replace(/,/g, ""));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function readString(source: JsonObject | null, keys: string[]): string | null {
  if (!source) {
    return null;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

function collectObjects(value: unknown, depth = 0): JsonObject[] {
  if (depth > 4) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectObjects(item, depth + 1));
  }

  const objectValue = asObject(value);
  if (!objectValue) {
    return [];
  }

  const nestedObjects = Object.values(objectValue).flatMap((item) =>
    collectObjects(item, depth + 1)
  );

  return [objectValue, ...nestedObjects];
}

export function extractOrderId(payload: unknown): string | null {
  for (const candidate of collectObjects(payload)) {
    const orderId = readString(candidate, ["OrderID", "OrderId", "orderId"]);
    if (orderId) {
      return orderId;
    }
  }

  return null;
}

export function extractOrderStatus(payload: unknown): string | null {
  for (const candidate of collectObjects(payload)) {
    const status = readString(candidate, [
      "StatusDescription",
      "Status",
      "status",
      "OrderStatus",
    ]);
    if (status) {
      return status;
    }
  }

  return null;
}

export function extractAverageFillPrice(payload: unknown): number | null {
  for (const candidate of collectObjects(payload)) {
    const price = readNumber(candidate, [
      "AvgFilledPrice",
      "AveragePrice",
      "FilledPrice",
      "ExecutionPrice",
      "Price",
      "price",
    ]);
    if (price !== null) {
      return price;
    }
  }

  return null;
}

function toQuoteSnapshot(symbol: string, payload: unknown): TradeStationQuoteSnapshot {
  const quote = pickFirstObject(payload, ["Quotes", "Quote", "Items", "Data"]);
  const bid = readNumber(quote, ["Bid", "BidPrice", "bid"]);
  const ask = readNumber(quote, ["Ask", "AskPrice", "ask"]);
  const last = readNumber(quote, ["Last", "LastPrice", "Trade", "Close", "close"]);

  return {
    symbol,
    last,
    bid,
    ask,
    mid: bid !== null && ask !== null ? (bid + ask) / 2 : null,
    raw: payload,
  };
}

function buildOrderPayload(order: TradeStationOrderRequest): JsonObject {
  const payload: JsonObject = {
    AccountID: order.accountId,
    Symbol: order.symbol,
    Quantity: order.quantity,
    OrderType: order.orderType,
    TradeAction: order.tradeAction,
    TimeInForce: {
      Duration: order.duration ?? "DAY",
    },
  };

  if (order.orderType === "Limit" || order.orderType === "StopLimit") {
    if (typeof order.limitPrice !== "number" || order.limitPrice <= 0) {
      throw new Error("limitPrice is required for Limit and StopLimit orders.");
    }
    payload.LimitPrice = Number(order.limitPrice.toFixed(2));
  }

  if (order.orderType === "Stop" || order.orderType === "StopLimit") {
    if (typeof order.stopPrice !== "number" || order.stopPrice <= 0) {
      throw new Error("stopPrice is required for Stop and StopLimit orders.");
    }
    payload.StopPrice = Number(order.stopPrice.toFixed(2));
  }

  return payload;
}

export async function createAutomationTradeStationClient(baseUrl: string): Promise<{
  fetchQuote: (symbol: string) => Promise<TradeStationQuoteSnapshot>;
  confirmOrder: (order: TradeStationOrderRequest) => Promise<TradeStationOrderResult>;
  placeOrder: (order: TradeStationOrderRequest) => Promise<TradeStationOrderResult>;
  getExecutions: (accountId: string, orderId: string) => Promise<unknown>;
  getBalances: (accountId: string) => Promise<unknown>;
  getPositions: (accountId: string) => Promise<unknown>;
}> {
  const request = await createTradeStationFetcher({
    baseUrl,
  });

  async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
    const response = await request(path, init);
    const text = await response.text();
    const payload = text.length > 0 ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new Error(
        `TradeStation request failed (${response.status}) for ${path}: ${text || "No response body."}`,
      );
    }

    return payload;
  }

  return {
    async fetchQuote(symbol: string): Promise<TradeStationQuoteSnapshot> {
      const payload = await requestJson(`/marketdata/quotes/${encodeURIComponent(symbol)}`);
      return toQuoteSnapshot(symbol, payload);
    },
    async confirmOrder(order: TradeStationOrderRequest): Promise<TradeStationOrderResult> {
      const payload = await requestJson("/orderexecution/orderconfirm", {
        method: "POST",
        body: JSON.stringify(buildOrderPayload(order)),
      });

      return {
        orderId: extractOrderId(payload),
        status: extractOrderStatus(payload),
        averageFillPrice: extractAverageFillPrice(payload),
        raw: payload,
      };
    },
    async placeOrder(order: TradeStationOrderRequest): Promise<TradeStationOrderResult> {
      const payload = await requestJson("/orderexecution/orders", {
        method: "POST",
        body: JSON.stringify(buildOrderPayload(order)),
      });

      return {
        orderId: extractOrderId(payload),
        status: extractOrderStatus(payload),
        averageFillPrice: extractAverageFillPrice(payload),
        raw: payload,
      };
    },
    async getExecutions(accountId: string, orderId: string): Promise<unknown> {
      return await requestJson(
        `/brokerage/accounts/${encodeURIComponent(accountId)}/orders/${encodeURIComponent(orderId)}/executions`,
      );
    },
    async getBalances(accountId: string): Promise<unknown> {
      return await requestJson(
        `/brokerage/accounts/${encodeURIComponent(accountId)}/balances`,
      );
    },
    async getPositions(accountId: string): Promise<unknown> {
      return await requestJson(
        `/brokerage/accounts/${encodeURIComponent(accountId)}/positions`,
      );
    },
  };
}
