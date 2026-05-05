import {
  supabaseInsertAndSelectOne,
  supabaseSelect,
} from "../supabase/serverClient.js";
import {
  buildEntryRewardFeatureSnapshot,
  type EntryPolicyRecommendation,
  type EntryRewardFeatureInput,
} from "./entryRewardModel.js";

export type PaperEntryCandidateRecord = {
  id: string;
  created_at: string;
  scan_run_id: string | null;
  source: "paper_trader";
  dry_run: boolean;
  symbol: string | null;
  decision: string;
  decision_reason: string | null;
  paper_trade_id: string | null;
  order_id: string | null;
  direction: string | null;
  setup_type: string | null;
  confidence_bucket: string | null;
  dte_at_entry: number | null;
  planned_reward_risk: string | null;
  chart_review_score: string | null;
  volume_ratio: string | null;
  option_spread: string | null;
  market_regime: string | null;
  scan_tier: string | null;
  entry_day: string | null;
  entry_time_bucket: string | null;
  entry_policy_decision: string | null;
  entry_policy_sample_size: number | null;
  entry_policy_average_reward_r: string | null;
  entry_policy_win_rate: string | null;
  entry_policy_matched_key: string | null;
  entry_policy_summary: string | null;
  feature_json: Record<string, unknown>;
  scan_json: Record<string, unknown> | null;
  trade_card_json: Record<string, unknown> | null;
};

export type PaperEntryCandidateCreateInput = {
  scanRunId: string;
  dryRun: boolean;
  symbol: string | null;
  decision: string;
  decisionReason: string | null;
  paperTradeId?: string | null;
  orderId?: string | null;
  features?: EntryRewardFeatureInput | null;
  entryPolicy?: EntryPolicyRecommendation | null;
  scan?: Record<string, unknown> | null;
  tradeCard?: Record<string, unknown> | null;
};

export type PaperEntryCandidateHistoryResult = {
  candidates: PaperEntryCandidateRecord[];
  migrationRequired: boolean;
  migrationMessage: string | null;
};

function isPaperEntryCandidatesTableMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("PGRST205")
    && message.includes("paper_entry_candidates")
  ) || (
    message.toLowerCase().includes("could not find the table")
    && message.includes("paper_entry_candidates")
  );
}

function numericOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function recordPaperEntryCandidate(
  input: PaperEntryCandidateCreateInput,
): Promise<PaperEntryCandidateRecord | null> {
  const featureSnapshot = input.features
    ? buildEntryRewardFeatureSnapshot(input.features)
    : null;
  const raw = featureSnapshot?.raw ?? null;
  const buckets = featureSnapshot?.buckets ?? null;

  try {
    return await supabaseInsertAndSelectOne<PaperEntryCandidateRecord>({
      table: "paper_entry_candidates",
      values: {
        scan_run_id: input.scanRunId,
        source: "paper_trader",
        dry_run: input.dryRun,
        symbol: input.symbol,
        decision: input.decision,
        decision_reason: input.decisionReason,
        paper_trade_id: input.paperTradeId ?? null,
        order_id: input.orderId ?? null,
        direction: raw?.direction ?? null,
        setup_type: raw?.setupType ?? null,
        confidence_bucket: raw?.confidenceBucket ?? null,
        dte_at_entry: numericOrNull(raw?.dteAtEntry),
        planned_reward_risk: numericOrNull(raw?.plannedRewardRisk),
        chart_review_score: numericOrNull(raw?.chartReviewScore),
        volume_ratio: numericOrNull(raw?.volumeRatio),
        option_spread: numericOrNull(raw?.optionSpread),
        market_regime: raw?.marketRegime ?? null,
        scan_tier: raw?.scanTier ?? null,
        entry_day: raw?.entryDay ?? null,
        entry_time_bucket: buckets?.entryTimeBucket ?? null,
        entry_policy_decision: input.entryPolicy?.decision ?? null,
        entry_policy_sample_size: input.entryPolicy?.sampleSize ?? null,
        entry_policy_average_reward_r: numericOrNull(input.entryPolicy?.averageRewardR),
        entry_policy_win_rate: numericOrNull(input.entryPolicy?.winRate),
        entry_policy_matched_key: input.entryPolicy?.matchedKey ?? null,
        entry_policy_summary: input.entryPolicy?.summary ?? null,
        feature_json: featureSnapshot ?? {},
        scan_json: null,
        trade_card_json: null,
      },
    });
  } catch (error) {
    if (isPaperEntryCandidatesTableMissing(error)) {
      return null;
    }
    throw error;
  }
}

export async function listRecentPaperEntryCandidates(
  limit = 50,
): Promise<PaperEntryCandidateHistoryResult> {
  try {
    const candidates = await supabaseSelect<PaperEntryCandidateRecord>({
      table: "paper_entry_candidates",
      select: [
        "id",
        "created_at",
        "scan_run_id",
        "source",
        "dry_run",
        "symbol",
        "decision",
        "decision_reason",
        "paper_trade_id",
        "order_id",
        "direction",
        "setup_type",
        "confidence_bucket",
        "dte_at_entry",
        "planned_reward_risk",
        "chart_review_score",
        "volume_ratio",
        "option_spread",
        "market_regime",
        "scan_tier",
        "entry_day",
        "entry_time_bucket",
        "entry_policy_decision",
        "entry_policy_sample_size",
        "entry_policy_average_reward_r",
        "entry_policy_win_rate",
        "entry_policy_matched_key",
        "entry_policy_summary",
      ].join(","),
      order: ["created_at.desc"],
      limit,
    });

    return {
      candidates: candidates.map((candidate) => ({
        ...candidate,
        feature_json: {},
        scan_json: null,
        trade_card_json: null,
      })),
      migrationRequired: false,
      migrationMessage: null,
    };
  } catch (error) {
    if (!isPaperEntryCandidatesTableMissing(error)) {
      throw error;
    }

    return {
      candidates: [],
      migrationRequired: true,
      migrationMessage:
        "Supabase is missing the paper_entry_candidates table. Apply supabase/migrations/202604300001_paper_entry_candidates.sql to show entry candidate audit history in the app.",
    };
  }
}
