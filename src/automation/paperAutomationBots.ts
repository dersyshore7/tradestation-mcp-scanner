export const LEGACY_PAPER_AUTOMATION_KEY = "legacy_paper_trader" as const;
export const VIRTUAL_PAPER_AUTOMATION_STARTING_BALANCE_USD = 10_000;

export const VIRTUAL_PAPER_AUTOMATION_KEYS = [
  "politician_replica",
  "news_reasoning_ai",
  "leaps_investor_ai",
  "support_resistance_ai",
] as const;

export const PAPER_AUTOMATION_KEYS = [
  LEGACY_PAPER_AUTOMATION_KEY,
  ...VIRTUAL_PAPER_AUTOMATION_KEYS,
] as const;

export type VirtualPaperAutomationKey = (typeof VIRTUAL_PAPER_AUTOMATION_KEYS)[number];
export type PaperAutomationKey = (typeof PAPER_AUTOMATION_KEYS)[number];

export type PaperAutomationBot = {
  key: VirtualPaperAutomationKey;
  pageKey: string;
  label: string;
  navLabel: string;
  tradeLabel: string;
  strategyKind: "politician" | "news" | "leaps" | "support_resistance";
  startingBalanceUsd: number;
  sourceSummary: string;
  cronMinuteOffset: number;
};

export const VIRTUAL_PAPER_AUTOMATION_BOTS: PaperAutomationBot[] = [
  {
    key: "politician_replica",
    pageKey: "politician-replica",
    label: "Politician Replica",
    navLabel: "Politician Replica",
    tradeLabel: "politician-replica",
    strategyKind: "politician",
    startingBalanceUsd: VIRTUAL_PAPER_AUTOMATION_STARTING_BALANCE_USD,
    sourceSummary: "FMP House/Senate financial disclosures",
    cronMinuteOffset: 1,
  },
  {
    key: "news_reasoning_ai",
    pageKey: "news-reasoning-ai",
    label: "News Reasoning AI",
    navLabel: "News Reasoning AI",
    tradeLabel: "news-AI",
    strategyKind: "news",
    startingBalanceUsd: VIRTUAL_PAPER_AUTOMATION_STARTING_BALANCE_USD,
    sourceSummary: "FMP stock news plus AI reasoning",
    cronMinuteOffset: 2,
  },
  {
    key: "leaps_investor_ai",
    pageKey: "leaps-investor-ai",
    label: "LEAPS Investor AI",
    navLabel: "LEAPS Investor AI",
    tradeLabel: "LEAPS-AI",
    strategyKind: "leaps",
    startingBalanceUsd: VIRTUAL_PAPER_AUTOMATION_STARTING_BALANCE_USD,
    sourceSummary: "Read-only TradeStation chart and options data",
    cronMinuteOffset: 3,
  },
  {
    key: "support_resistance_ai",
    pageKey: "support-resistance-ai",
    label: "Support/Resistance AI",
    navLabel: "Support/Resistance AI",
    tradeLabel: "support/resistance-AI",
    strategyKind: "support_resistance",
    startingBalanceUsd: VIRTUAL_PAPER_AUTOMATION_STARTING_BALANCE_USD,
    sourceSummary: "Read-only TradeStation support/resistance analysis",
    cronMinuteOffset: 4,
  },
];

export function readPaperAutomationKey(value: unknown): PaperAutomationKey | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return (PAPER_AUTOMATION_KEYS as readonly string[]).includes(normalized)
    ? normalized as PaperAutomationKey
    : null;
}

export function readVirtualPaperAutomationKey(value: unknown): VirtualPaperAutomationKey | null {
  const key = readPaperAutomationKey(value);
  return key !== null && isVirtualPaperAutomationKey(key) ? key : null;
}

export function isVirtualPaperAutomationKey(key: PaperAutomationKey): key is VirtualPaperAutomationKey {
  return (VIRTUAL_PAPER_AUTOMATION_KEYS as readonly string[]).includes(key);
}

export function getVirtualPaperAutomationBot(key: VirtualPaperAutomationKey): PaperAutomationBot {
  const bot = VIRTUAL_PAPER_AUTOMATION_BOTS.find((candidate) => candidate.key === key);
  if (!bot) {
    throw new Error(`Unknown virtual paper automation: ${key}`);
  }
  return bot;
}

export function getPaperAutomationLabel(key: PaperAutomationKey): string {
  return key === LEGACY_PAPER_AUTOMATION_KEY
    ? "Legacy Paper Trader"
    : getVirtualPaperAutomationBot(key).label;
}

export function paperAutomationColumnFilter(key: PaperAutomationKey): string {
  return `paper_automation_key=eq.${key}`;
}
