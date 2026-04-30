import type { ScanResult } from "../app/runScan.js";
import type { TradeConstructionResult } from "../app/runTradeConstruction.js";
import type { JournalTradeDetail, TradeDirection } from "../journal/types.js";

export type EntryPolicyDecision = "favor" | "allow" | "caution" | "block";

const ENTRY_REWARD_R_CAP = 5;
const MIN_ENTRY_POLICY_SAMPLE = 3;

export type EntryRewardFeatureInput = {
  direction: TradeDirection;
  setupType: string;
  confidenceBucket: string | null;
  dteAtEntry: number | null;
  plannedRewardRisk: number | null;
  chartReviewScore: number | null;
  volumeRatio: number | null;
  optionSpread: number | null;
  marketRegime: string | null;
  scanTier: string | null;
  entryDay: string | null;
  entryTime: string | null;
};

export type EntryRewardFeatureBuckets = {
  direction: TradeDirection;
  setupType: string;
  confidenceBucket: string;
  dteBucket: string;
  rewardRiskBucket: string;
  chartScoreBucket: string;
  volumeBucket: string;
  optionSpreadBucket: string;
  marketRegimeBucket: string;
  scanTierBucket: string;
  entryDayBucket: string;
  entryTimeBucket: string;
};

export type EntryRewardFeatureSnapshot = {
  raw: EntryRewardFeatureInput;
  buckets: EntryRewardFeatureBuckets;
};

type EntryRewardExperience = {
  symbol: string;
  rewardR: number;
  buckets: EntryRewardFeatureBuckets;
};

type EntryRewardAggregate = {
  count: number;
  totalRewardR: number;
  positiveCount: number;
  symbols: string[];
};

export type EntryRewardBucketSummary = {
  key: string;
  count: number;
  averageRewardR: number;
  winRate: number;
  symbols: string[];
};

export type EntryFeatureCoverage = {
  feature: string;
  knownCount: number;
  unknownCount: number;
  unknownPct: number;
};

export type EntryRewardModel = {
  generatedAt: string;
  closedTradeCount: number;
  experienceCount: number;
  buckets: Record<string, EntryRewardAggregate>;
  featureCoverage: EntryFeatureCoverage[];
  topContexts: EntryRewardBucketSummary[];
  weakContexts: EntryRewardBucketSummary[];
};

export type EntryPolicyRecommendation = {
  decision: EntryPolicyDecision;
  matchedKey: string | null;
  sampleSize: number;
  averageRewardR: number | null;
  winRate: number | null;
  summary: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim().replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseRewardRisk(value: unknown): number | null {
  const numeric = asFiniteNumber(value);
  if (numeric !== null) {
    return numeric;
  }
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/([0-9]+(?:\.[0-9]+)?)\s*:?\s*1?/);
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function calculateRewardRisk(plannedProfit: unknown, plannedRisk: unknown): number | null {
  const profit = asFiniteNumber(plannedProfit);
  const risk = asFiniteNumber(plannedRisk);
  if (profit === null || risk === null || risk <= 0) {
    return null;
  }
  return Number((profit / risk).toFixed(2));
}

function readTelemetry(signalSnapshot: Record<string, unknown> | null): Record<string, unknown> | null {
  const scan = asRecord(signalSnapshot?.scan);
  return asRecord(scan?.telemetry) ?? asRecord(signalSnapshot?.telemetry);
}

function readPresentationSummary(signalSnapshot: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(signalSnapshot?.presentationSummary);
}

function formatChicagoParts(date = new Date()): {
  weekday: string;
  time: string;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    weekday: values.weekday ?? "unknown",
    time: `${values.hour ?? "00"}:${values.minute ?? "00"}:${values.second ?? "00"}`,
  };
}

function findTelemetryItem(telemetry: unknown, listKey: string, symbol: string): Record<string, unknown> | null {
  const record = asRecord(telemetry);
  const items = record?.[listKey];
  if (!Array.isArray(items)) {
    return null;
  }

  const normalizedSymbol = symbol.toUpperCase();
  return items
    .map((item) => asRecord(item))
    .find((item) => typeof item?.symbol === "string" && item.symbol.toUpperCase() === normalizedSymbol)
    ?? null;
}

function extractTelemetryFeatures(telemetry: unknown, symbol: string): {
  chartReviewScore: number | null;
  volumeRatio: number | null;
  optionSpread: number | null;
  plannedRewardRisk: number | null;
} {
  const ranking = findTelemetryItem(telemetry, "finalRankingDebug", symbol);
  const rankingInputs = asRecord(ranking?.scoreInputs);
  const reviewed = findTelemetryItem(telemetry, "reviewedFinalistOutcomes", symbol);
  const stage2Inputs = asRecord(reviewed?.stage2Inputs);
  const stage3Inputs = asRecord(reviewed?.stage3Inputs);
  const asymmetryDebug = asRecord(reviewed?.asymmetryDebug);

  return {
    chartReviewScore:
      asFiniteNumber(rankingInputs?.chartReviewScore)
      ?? asFiniteNumber(stage3Inputs?.chartReviewScore),
    volumeRatio:
      asFiniteNumber(rankingInputs?.volumeRatio)
      ?? asFiniteNumber(stage3Inputs?.volumeRatio),
    optionSpread:
      asFiniteNumber(rankingInputs?.optionSpread)
      ?? asFiniteNumber(stage2Inputs?.optionSpread),
    plannedRewardRisk:
      asFiniteNumber(asymmetryDebug?.finalizedTradeRewardRiskRatio)
      ?? asFiniteNumber(asymmetryDebug?.postConfirmationActualRewardRiskRatio),
  };
}

function extractTradeRewardRisk(trade: JournalTradeDetail): number | null {
  const directRewardRisk = calculateRewardRisk(trade.planned_profit_usd, trade.planned_risk_usd);
  if (directRewardRisk !== null) {
    return directRewardRisk;
  }

  const snapshot = asRecord(trade.signal_snapshot_json);
  const presentationSummary = readPresentationSummary(snapshot);
  const finalChartGeometry = asRecord(presentationSummary?.finalChartGeometry);
  return parseRewardRisk(
    finalChartGeometry?.finalChartRewardRisk
    ?? finalChartGeometry?.final_chart_reward_risk,
  );
}

function extractTradeEntryFeatures(trade: JournalTradeDetail): EntryRewardFeatureInput {
  const snapshot = asRecord(trade.signal_snapshot_json);
  const telemetry = readTelemetry(snapshot);
  const telemetryFeatures = extractTelemetryFeatures(telemetry, trade.symbol);
  const telemetryRecord = asRecord(telemetry);

  return {
    direction: trade.direction,
    setupType: trade.setup_type,
    confidenceBucket: trade.confidence_bucket,
    dteAtEntry: trade.dte_at_entry,
    plannedRewardRisk: extractTradeRewardRisk(trade) ?? telemetryFeatures.plannedRewardRisk,
    chartReviewScore: telemetryFeatures.chartReviewScore,
    volumeRatio: telemetryFeatures.volumeRatio,
    optionSpread: telemetryFeatures.optionSpread,
    marketRegime: trade.market_regime,
    scanTier:
      typeof telemetryRecord?.finalSelectionSourceTier === "string"
        ? telemetryRecord.finalSelectionSourceTier
        : typeof telemetryRecord?.winningTier === "string"
          ? telemetryRecord.winningTier
          : null,
    entryDay: trade.entry_day,
    entryTime: trade.entry_time,
  };
}

export function buildEntryRewardFeatureInput(params: {
  scan: ScanResult;
  tradeCard: TradeConstructionResult;
  entryTimestamp?: Date;
}): EntryRewardFeatureInput {
  const symbol = params.tradeCard.ticker || params.scan.ticker || "";
  const chicagoNow = formatChicagoParts(params.entryTimestamp);
  const telemetryFeatures = symbol
    ? extractTelemetryFeatures(params.scan.telemetry ?? null, symbol)
    : {
        chartReviewScore: null,
        volumeRatio: null,
        optionSpread: null,
        plannedRewardRisk: null,
      };

  return {
    direction: params.tradeCard.plannedJournalFields.direction,
    setupType: params.tradeCard.plannedJournalFields.setup_type,
    confidenceBucket: params.tradeCard.plannedJournalFields.confidence_bucket ?? params.scan.confidence,
    dteAtEntry: params.tradeCard.plannedJournalFields.dte_at_entry ?? null,
    plannedRewardRisk:
      calculateRewardRisk(
        params.tradeCard.plannedJournalFields.planned_profit_usd,
        params.tradeCard.plannedJournalFields.planned_risk_usd,
      )
      ?? telemetryFeatures.plannedRewardRisk
      ?? parseRewardRisk(params.tradeCard.rrMath),
    chartReviewScore: telemetryFeatures.chartReviewScore,
    volumeRatio: telemetryFeatures.volumeRatio,
    optionSpread: telemetryFeatures.optionSpread,
    marketRegime: (params.tradeCard.plannedJournalFields as { market_regime?: string | null }).market_regime ?? null,
    scanTier: params.scan.telemetry?.finalSelectionSourceTier ?? params.scan.telemetry?.winningTier ?? null,
    entryDay: chicagoNow.weekday,
    entryTime: chicagoNow.time,
  };
}

function bucketDte(dteAtEntry: number | null): string {
  if (dteAtEntry === null) {
    return "unknown";
  }
  if (dteAtEntry <= 7) {
    return "0_7";
  }
  if (dteAtEntry <= 21) {
    return "8_21";
  }
  if (dteAtEntry <= 45) {
    return "22_45";
  }
  return "46_plus";
}

function bucketRewardRisk(value: number | null): string {
  if (value === null) {
    return "unknown";
  }
  if (value < 1) {
    return "lt_1r";
  }
  if (value < 1.5) {
    return "1_1_5r";
  }
  if (value < 2) {
    return "1_5_2r";
  }
  return "2r_plus";
}

function bucketChartScore(value: number | null): string {
  if (value === null) {
    return "unknown";
  }
  if (value < 7) {
    return "weak";
  }
  if (value < 8.5) {
    return "solid";
  }
  return "strong";
}

function bucketVolume(value: number | null): string {
  if (value === null) {
    return "unknown";
  }
  if (value < 0.8) {
    return "thin";
  }
  if (value < 1.2) {
    return "normal";
  }
  if (value < 1.8) {
    return "expanded";
  }
  return "very_expanded";
}

function bucketOptionSpread(value: number | null): string {
  if (value === null) {
    return "unknown";
  }
  if (value <= 0.08) {
    return "tight";
  }
  if (value <= 0.15) {
    return "normal";
  }
  if (value <= 0.3) {
    return "wide";
  }
  return "very_wide";
}

function bucketText(value: string | null): string {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0
    ? normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    : "unknown";
}

function bucketEntryDay(value: string | null): string {
  const normalized = bucketText(value);
  if (["mon", "tue", "wed", "thu", "fri"].includes(normalized)) {
    return normalized;
  }
  return normalized === "unknown" ? "unknown" : "other";
}

function bucketEntryTime(value: string | null): string {
  if (!value) {
    return "unknown";
  }
  const [hourRaw, minuteRaw] = value.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return "unknown";
  }
  const minutes = (hour * 60) + minute;
  if (minutes < (8 * 60) + 30 || minutes >= 15 * 60) {
    return "outside_session";
  }
  if (minutes < (9 * 60) + 30) {
    return "first_hour";
  }
  if (minutes >= 14 * 60) {
    return "power_hour";
  }
  return "mid_session";
}

function buildFeatureBuckets(input: EntryRewardFeatureInput): EntryRewardFeatureBuckets {
  return {
    direction: input.direction,
    setupType: input.setupType,
    confidenceBucket: input.confidenceBucket ?? "unknown",
    dteBucket: bucketDte(input.dteAtEntry),
    rewardRiskBucket: bucketRewardRisk(input.plannedRewardRisk),
    chartScoreBucket: bucketChartScore(input.chartReviewScore),
    volumeBucket: bucketVolume(input.volumeRatio),
    optionSpreadBucket: bucketOptionSpread(input.optionSpread),
    marketRegimeBucket: bucketText(input.marketRegime),
    scanTierBucket: bucketText(input.scanTier),
    entryDayBucket: bucketEntryDay(input.entryDay),
    entryTimeBucket: bucketEntryTime(input.entryTime),
  };
}

export function buildEntryRewardFeatureSnapshot(input: EntryRewardFeatureInput): EntryRewardFeatureSnapshot {
  return {
    raw: input,
    buckets: buildFeatureBuckets(input),
  };
}

function buildEntryPolicyKeys(buckets: EntryRewardFeatureBuckets): string[] {
  return [
    [
      `direction=${buckets.direction}`,
      `setup=${buckets.setupType}`,
      `confidence=${buckets.confidenceBucket}`,
      `dte=${buckets.dteBucket}`,
      `rr=${buckets.rewardRiskBucket}`,
      `chart=${buckets.chartScoreBucket}`,
      `volume=${buckets.volumeBucket}`,
      `spread=${buckets.optionSpreadBucket}`,
      `tier=${buckets.scanTierBucket}`,
      `regime=${buckets.marketRegimeBucket}`,
      `day=${buckets.entryDayBucket}`,
      `time=${buckets.entryTimeBucket}`,
    ].join("|"),
    [
      `direction=${buckets.direction}`,
      `setup=${buckets.setupType}`,
      `confidence=${buckets.confidenceBucket}`,
      `dte=${buckets.dteBucket}`,
      `rr=${buckets.rewardRiskBucket}`,
      `chart=${buckets.chartScoreBucket}`,
      `tier=${buckets.scanTierBucket}`,
    ].join("|"),
    [
      `direction=${buckets.direction}`,
      `setup=${buckets.setupType}`,
      `dte=${buckets.dteBucket}`,
      `rr=${buckets.rewardRiskBucket}`,
      `chart=${buckets.chartScoreBucket}`,
    ].join("|"),
    [
      `direction=${buckets.direction}`,
      `setup=${buckets.setupType}`,
      `dte=${buckets.dteBucket}`,
      `rr=${buckets.rewardRiskBucket}`,
    ].join("|"),
    [
      `direction=${buckets.direction}`,
      `setup=${buckets.setupType}`,
      `rr=${buckets.rewardRiskBucket}`,
    ].join("|"),
    [
      `direction=${buckets.direction}`,
      `setup=${buckets.setupType}`,
    ].join("|"),
    `direction=${buckets.direction}`,
  ];
}

function summarizeFeatureCoverage(experiences: EntryRewardExperience[]): EntryFeatureCoverage[] {
  const features: {
    feature: string;
    read: (buckets: EntryRewardFeatureBuckets) => string;
  }[] = [
    { feature: "confidence", read: (buckets) => buckets.confidenceBucket },
    { feature: "dte", read: (buckets) => buckets.dteBucket },
    { feature: "planned_reward_risk", read: (buckets) => buckets.rewardRiskBucket },
    { feature: "chart_score", read: (buckets) => buckets.chartScoreBucket },
    { feature: "volume", read: (buckets) => buckets.volumeBucket },
    { feature: "option_spread", read: (buckets) => buckets.optionSpreadBucket },
    { feature: "scan_tier", read: (buckets) => buckets.scanTierBucket },
    { feature: "market_regime", read: (buckets) => buckets.marketRegimeBucket },
    { feature: "entry_day", read: (buckets) => buckets.entryDayBucket },
    { feature: "entry_time", read: (buckets) => buckets.entryTimeBucket },
  ];

  return features.map((feature) => {
    const unknownCount = experiences.filter((experience) => feature.read(experience.buckets) === "unknown").length;
    const knownCount = experiences.length - unknownCount;
    return {
      feature: feature.feature,
      knownCount,
      unknownCount,
      unknownPct: experiences.length > 0
        ? Number((unknownCount / experiences.length).toFixed(3))
        : 0,
    };
  });
}

function summarizeBucket(key: string, aggregate: EntryRewardAggregate): EntryRewardBucketSummary {
  return {
    key,
    count: aggregate.count,
    averageRewardR: Number((aggregate.totalRewardR / aggregate.count).toFixed(3)),
    winRate: Number((aggregate.positiveCount / aggregate.count).toFixed(3)),
    symbols: aggregate.symbols.slice(-6),
  };
}

function extractEntryRewardExperiences(trades: JournalTradeDetail[]): EntryRewardExperience[] {
  const experiences: EntryRewardExperience[] = [];

  for (const trade of trades) {
    if (trade.account_mode !== "paper" || trade.status !== "closed" || !trade.review) {
      continue;
    }

    const realizedR = asFiniteNumber(trade.review.realized_r_multiple);
    if (realizedR === null) {
      continue;
    }

    experiences.push({
      symbol: trade.symbol,
      rewardR: Number(clamp(realizedR, -ENTRY_REWARD_R_CAP, ENTRY_REWARD_R_CAP).toFixed(3)),
      buckets: buildFeatureBuckets(extractTradeEntryFeatures(trade)),
    });
  }

  return experiences;
}

export function trainEntryRewardModel(trades: JournalTradeDetail[]): EntryRewardModel {
  const experiences = extractEntryRewardExperiences(trades);
  const buckets: EntryRewardModel["buckets"] = {};

  for (const experience of experiences) {
    for (const key of buildEntryPolicyKeys(experience.buckets)) {
      const aggregate = buckets[key] ?? {
        count: 0,
        totalRewardR: 0,
        positiveCount: 0,
        symbols: [],
      };
      aggregate.count += 1;
      aggregate.totalRewardR += experience.rewardR;
      if (experience.rewardR > 0) {
        aggregate.positiveCount += 1;
      }
      aggregate.symbols = [...aggregate.symbols, experience.symbol].slice(-12);
      buckets[key] = aggregate;
    }
  }

  const rankedContexts = Object.entries(buckets)
    .map(([key, aggregate]) => summarizeBucket(key, aggregate))
    .filter((summary) => summary.count >= 2);

  return {
    generatedAt: new Date().toISOString(),
    closedTradeCount: trades.filter(
      (trade) => trade.account_mode === "paper" && trade.status === "closed" && !!trade.review,
    ).length,
    experienceCount: experiences.length,
    buckets,
    featureCoverage: summarizeFeatureCoverage(experiences),
    topContexts: [...rankedContexts]
      .sort((left, right) => right.averageRewardR - left.averageRewardR)
      .slice(0, 5),
    weakContexts: [...rankedContexts]
      .sort((left, right) => left.averageRewardR - right.averageRewardR)
      .slice(0, 5),
  };
}

export function recommendEntryPolicy(
  model: EntryRewardModel,
  input: EntryRewardFeatureInput,
): EntryPolicyRecommendation {
  const buckets = buildFeatureBuckets(input);
  const keys = buildEntryPolicyKeys(buckets);
  let sparseMatch: EntryRewardBucketSummary | null = null;

  for (const key of keys) {
    const aggregate = model.buckets[key];
    if (!aggregate) {
      continue;
    }

    const summary = summarizeBucket(key, aggregate);
    if (summary.count < MIN_ENTRY_POLICY_SAMPLE) {
      sparseMatch = sparseMatch ?? summary;
      continue;
    }

    const decision: EntryPolicyDecision =
      summary.count >= 5 && summary.averageRewardR <= -0.75 && summary.winRate <= 0.25
        ? "block"
        : summary.count >= 3 && summary.averageRewardR < 0
          ? "caution"
          : summary.count >= 3 && summary.averageRewardR >= 0.75
            ? "favor"
            : "allow";
    const decisionText =
      decision === "block"
        ? "Block this entry and let the scanner look for another candidate."
        : decision === "caution"
          ? "Allow only as a weak prior warning; current live setup must carry the decision."
          : decision === "favor"
            ? "Historically favorable entry context."
            : "No strong entry-policy edge yet.";

    return {
      decision,
      matchedKey: key,
      sampleSize: summary.count,
      averageRewardR: summary.averageRewardR,
      winRate: summary.winRate,
      summary: `Entry policy matched ${summary.count} realized-R outcome(s) at ${key}: avg ${summary.averageRewardR.toFixed(2)}R, win rate ${(summary.winRate * 100).toFixed(0)}%. ${decisionText}`,
    };
  }

  if (sparseMatch) {
    return {
      decision: "allow",
      matchedKey: sparseMatch.key,
      sampleSize: sparseMatch.count,
      averageRewardR: sparseMatch.averageRewardR,
      winRate: sparseMatch.winRate,
      summary: `Entry policy found only ${sparseMatch.count} realized-R outcome(s) at ${sparseMatch.key}: avg ${sparseMatch.averageRewardR.toFixed(2)}R, win rate ${(sparseMatch.winRate * 100).toFixed(0)}%. Sample is sparse, so allow the scanner/trade-card decision and keep learning.`,
    };
  }

  return {
    decision: "allow",
    matchedKey: null,
    sampleSize: 0,
    averageRewardR: null,
    winRate: null,
    summary: "Entry policy has no matching realized-R history yet; allow the scanner/trade-card decision and learn from the outcome.",
  };
}

export function summarizeEntryRewardModel(model: EntryRewardModel): string | null {
  if (model.experienceCount === 0) {
    return null;
  }

  const top = model.topContexts
    .slice(0, 3)
    .map((item) => `${item.key} => ${item.averageRewardR.toFixed(2)}R (${item.count})`)
    .join("\n");
  const weak = model.weakContexts
    .slice(0, 3)
    .map((item) => `${item.key} => ${item.averageRewardR.toFixed(2)}R (${item.count})`)
    .join("\n");

  return [
    `Entry reward model: ${model.experienceCount} closed paper entry outcome(s), trained on realized R only with a ${ENTRY_REWARD_R_CAP}R outlier cap.`,
    `Feature audit: ${model.featureCoverage.map((item) => `${item.feature} unknown ${(item.unknownPct * 100).toFixed(0)}%`).join(", ")}.`,
    top ? `Best contexts:\n${top}` : null,
    weak ? `Weak contexts:\n${weak}` : null,
  ].filter((value): value is string => value !== null).join("\n");
}
