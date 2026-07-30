import type { TradeDirection } from "../journal/types.js";
import type { StrategyVersionId } from "./strategyVersion.js";

export type ReplayBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type FrozenReplayCandidate = {
  strategyVersion: StrategyVersionId;
  symbol: string;
  direction: TradeDirection;
  decisionTime: string;
  entryUnderlying: number;
  stopUnderlying: number;
  targetUnderlying: number;
  maximumHoldBars: number;
};

export type FrozenReplayResult = {
  strategyVersion: StrategyVersionId;
  symbol: string;
  direction: TradeDirection;
  decisionTime: string;
  exitTime: string | null;
  exitReason: "stop" | "target" | "time" | "insufficient_future_data";
  realizedR: number | null;
};

function assertChronologicalBars(bars: ReplayBar[]): void {
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    if (
      !Number.isFinite(Date.parse(bar.time))
      || ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
      || bar.high < Math.max(bar.open, bar.close, bar.low)
      || bar.low > Math.min(bar.open, bar.close, bar.high)
    ) {
      throw new Error(`Invalid replay bar at index ${index}.`);
    }
    if (index > 0 && bars[index - 1]!.time >= bar.time) {
      throw new Error("Replay bars must be strictly time ordered.");
    }
  }
}

function validateCandidate(candidate: FrozenReplayCandidate): number {
  const risk = candidate.direction === "CALL"
    ? candidate.entryUnderlying - candidate.stopUnderlying
    : candidate.stopUnderlying - candidate.entryUnderlying;
  const reward = candidate.direction === "CALL"
    ? candidate.targetUnderlying - candidate.entryUnderlying
    : candidate.entryUnderlying - candidate.targetUnderlying;
  if (
    risk <= 0
    || reward <= 0
    || !Number.isInteger(candidate.maximumHoldBars)
    || candidate.maximumHoldBars < 1
  ) {
    throw new Error(`Invalid frozen replay geometry for ${candidate.symbol}.`);
  }
  return risk;
}

function realizedR(
  candidate: FrozenReplayCandidate,
  risk: number,
  exitUnderlying: number,
): number {
  const pnl = candidate.direction === "CALL"
    ? exitUnderlying - candidate.entryUnderlying
    : candidate.entryUnderlying - exitUnderlying;
  return Number((pnl / risk).toFixed(4));
}

export function replayFrozenUnderlyingStrategy(params: {
  bars: ReplayBar[];
  candidates: FrozenReplayCandidate[];
}): FrozenReplayResult[] {
  assertChronologicalBars(params.bars);
  const barIndex = new Map(params.bars.map((bar, index) => [bar.time, index]));

  return params.candidates.map((candidate) => {
    const risk = validateCandidate(candidate);
    const decisionIndex = barIndex.get(candidate.decisionTime);
    if (decisionIndex === undefined) {
      throw new Error(`Decision bar ${candidate.decisionTime} is unavailable.`);
    }

    const lastIndex = Math.min(
      params.bars.length - 1,
      decisionIndex + candidate.maximumHoldBars,
    );
    for (let index = decisionIndex + 1; index <= lastIndex; index += 1) {
      const bar = params.bars[index]!;
      const stopHit = candidate.direction === "CALL"
        ? bar.low <= candidate.stopUnderlying
        : bar.high >= candidate.stopUnderlying;
      const targetHit = candidate.direction === "CALL"
        ? bar.high >= candidate.targetUnderlying
        : bar.low <= candidate.targetUnderlying;

      // OHLC bars cannot establish intrabar ordering. Count a simultaneous
      // stop/target touch as the stop so the replay never manufactures profit.
      if (stopHit) {
        return {
          strategyVersion: candidate.strategyVersion,
          symbol: candidate.symbol,
          direction: candidate.direction,
          decisionTime: candidate.decisionTime,
          exitTime: bar.time,
          exitReason: "stop",
          realizedR: -1,
        };
      }
      if (targetHit) {
        return {
          strategyVersion: candidate.strategyVersion,
          symbol: candidate.symbol,
          direction: candidate.direction,
          decisionTime: candidate.decisionTime,
          exitTime: bar.time,
          exitReason: "target",
          realizedR: realizedR(candidate, risk, candidate.targetUnderlying),
        };
      }
    }

    if (lastIndex > decisionIndex) {
      const timeBar = params.bars[lastIndex]!;
      return {
        strategyVersion: candidate.strategyVersion,
        symbol: candidate.symbol,
        direction: candidate.direction,
        decisionTime: candidate.decisionTime,
        exitTime: timeBar.time,
        exitReason: "time",
        realizedR: realizedR(candidate, risk, timeBar.close),
      };
    }
    return {
      strategyVersion: candidate.strategyVersion,
      symbol: candidate.symbol,
      direction: candidate.direction,
      decisionTime: candidate.decisionTime,
      exitTime: null,
      exitReason: "insufficient_future_data",
      realizedR: null,
    };
  });
}
