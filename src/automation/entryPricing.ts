import {
  getTradeStationPriceIncrement,
  roundTradeStationPriceAtOrBelow,
} from "./tradestation.js";

const BID_SIDE_ENTRY_STRATEGY = "bid_plus_one_tick_capped_at_mid";

export type BidSideEntryPricingSnapshot = {
  strategy: typeof BID_SIDE_ENTRY_STRATEGY;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  tickSize: number;
  rawTarget: number;
  finalLimit: number;
  cap: number;
};

export type BidSideEntryPricingResult =
  | {
      pass: true;
      pricing: BidSideEntryPricingSnapshot;
    }
  | {
      pass: false;
      strategy: typeof BID_SIDE_ENTRY_STRATEGY;
      reason: string;
      bid: number | null;
      ask: number | null;
      mid: number | null;
    };

function asUsablePositiveNumber(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function buildMidpointLimitCap(params: {
  optionSymbol: string;
  mid: number | null;
}): number | null {
  const mid = asUsablePositiveNumber(params.mid);
  if (mid === null) {
    return null;
  }

  return roundTradeStationPriceAtOrBelow(params.optionSymbol, mid);
}

export function buildBidSideEntryPricing(params: {
  optionSymbol: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
}): BidSideEntryPricingResult {
  const bid = asUsablePositiveNumber(params.bid);
  const ask = asUsablePositiveNumber(params.ask);
  const mid = asUsablePositiveNumber(params.mid);
  if (bid === null || ask === null || mid === null) {
    return {
      pass: false,
      strategy: BID_SIDE_ENTRY_STRATEGY,
      reason: "Option quote is missing a usable positive bid, ask, or midpoint.",
      bid,
      ask,
      mid,
    };
  }
  if (ask <= bid) {
    return {
      pass: false,
      strategy: BID_SIDE_ENTRY_STRATEGY,
      reason: "Option quote has an unusable bid/ask spread.",
      bid,
      ask,
      mid,
    };
  }
  if (mid < bid || mid > ask) {
    return {
      pass: false,
      strategy: BID_SIDE_ENTRY_STRATEGY,
      reason: "Option midpoint is outside the quoted bid/ask spread.",
      bid,
      ask,
      mid,
    };
  }

  const tickSize = getTradeStationPriceIncrement(params.optionSymbol, bid);
  const rawTarget = Math.min(bid + tickSize, mid);
  const cap = buildMidpointLimitCap({
    optionSymbol: params.optionSymbol,
    mid,
  });
  if (cap === null) {
    return {
      pass: false,
      strategy: BID_SIDE_ENTRY_STRATEGY,
      reason: "Could not compute a valid midpoint cap for the option limit.",
      bid,
      ask,
      mid,
    };
  }
  const finalLimit = Math.min(
    roundTradeStationPriceAtOrBelow(params.optionSymbol, rawTarget),
    cap,
  );
  if (finalLimit <= 0) {
    return {
      pass: false,
      strategy: BID_SIDE_ENTRY_STRATEGY,
      reason: "Could not compute a valid bid-side limit at or below midpoint.",
      bid,
      ask,
      mid,
    };
  }

  return {
    pass: true,
    pricing: {
      strategy: BID_SIDE_ENTRY_STRATEGY,
      bid,
      ask,
      mid,
      spread: ask - bid,
      tickSize,
      rawTarget: Number(rawTarget.toFixed(4)),
      finalLimit,
      cap,
    },
  };
}
