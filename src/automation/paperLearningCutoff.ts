import type { JournalTradeDetail } from "../journal/types.js";

const PAPER_LEARNING_START_AT_ENV = "PAPER_LEARNING_START_AT";

export const DEFAULT_PAPER_LEARNING_START_AT = "2026-05-13T18:22:34.661Z";

export type PaperLearningWindow = {
  learningStartAt: string;
  learningStartAtMs: number;
};

export type PaperLearningTradeSet = {
  trades: JournalTradeDetail[];
  learningStartAt: string;
  excludedLearningTrades: number;
  window: PaperLearningWindow;
};

function parseLearningStartAt(value: string, source: string): PaperLearningWindow {
  const learningStartAtMs = Date.parse(value);
  if (!Number.isFinite(learningStartAtMs)) {
    throw new Error(`${source} must be a valid ISO timestamp.`);
  }

  return {
    learningStartAt: new Date(learningStartAtMs).toISOString(),
    learningStartAtMs,
  };
}

export function readPaperLearningWindow(): PaperLearningWindow {
  const configured = process.env[PAPER_LEARNING_START_AT_ENV]?.trim();
  return parseLearningStartAt(
    configured && configured.length > 0
      ? configured
      : DEFAULT_PAPER_LEARNING_START_AT,
    configured && configured.length > 0
      ? PAPER_LEARNING_START_AT_ENV
      : "default paper learning start",
  );
}

function readCreatedAtMs(record: { created_at: string }): number | null {
  const createdAtMs = Date.parse(record.created_at);
  return Number.isFinite(createdAtMs) ? createdAtMs : null;
}

export function filterRecordsForPaperLearning<T extends { created_at: string }>(
  records: readonly T[],
  window: PaperLearningWindow = readPaperLearningWindow(),
): T[] {
  return records.filter((record) => {
    const createdAtMs = readCreatedAtMs(record);
    return createdAtMs === null || createdAtMs >= window.learningStartAtMs;
  });
}

export function buildPaperLearningTradeSet(
  trades: readonly JournalTradeDetail[],
  window: PaperLearningWindow = readPaperLearningWindow(),
): PaperLearningTradeSet {
  const filteredTrades = filterRecordsForPaperLearning(trades, window);
  return {
    trades: filteredTrades,
    learningStartAt: window.learningStartAt,
    excludedLearningTrades: trades.length - filteredTrades.length,
    window,
  };
}
