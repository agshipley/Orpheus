import type { Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { FeedbackStore } from "../../storage/feedback_store.js";
import { JobStore } from "../../storage/job_store.js";
import { loadConfig } from "../config.js";

function getStore(): FeedbackStore {
  const config = loadConfig();
  return new FeedbackStore(config.storage.dbPath);
}

/**
 * POST /api/feedback
 * Body: { jobId, rating, matchedIdentity?, correctedIdentity?, searchQuery?, identityReasons? }
 */
export async function recordFeedbackHandler(req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const {
    jobId,
    rating,
    matchedIdentity,
    correctedIdentity,
    searchQuery,
    identityReasons,
  } = req.body as {
    jobId?: unknown;
    rating?: unknown;
    matchedIdentity?: unknown;
    correctedIdentity?: unknown;
    searchQuery?: unknown;
    identityReasons?: unknown;
  };

  if (typeof jobId !== "string" || !jobId.trim()) {
    res.status(400).json({ error: "jobId must be a non-empty string" });
    return;
  }
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < -2 || rating > 2) {
    res.status(400).json({ error: "rating must be an integer between -2 and 2" });
    return;
  }

  const store = new FeedbackStore(config.storage.dbPath);
  try {
    const id = store.recordFeedback({
      jobId: jobId.trim(),
      rating,
      matchedIdentity: typeof matchedIdentity === "string" ? matchedIdentity : undefined,
      correctedIdentity: typeof correctedIdentity === "string" ? correctedIdentity : undefined,
      searchQuery: typeof searchQuery === "string" ? searchQuery : undefined,
      identityReasons: typeof identityReasons === "object" && identityReasons !== null
        ? identityReasons as Record<string, string[]>
        : undefined,
    });

    const total = store.getTotalRatings();
    const shouldRetune = total % 20 === 0 && total > 0;
    const shouldSummarize = total % 50 === 0 && total > 0;

    if (shouldRetune) {
      store.retuneWeights();
    }

    if (shouldSummarize) {
      await generatePreferenceSummary(store, config.content?.model ?? "claude-sonnet-4-6");
    }

    res.json({ id, total, autoRetuned: shouldRetune, autoSummarized: shouldSummarize });
  } finally {
    store.close();
  }
}

/**
 * POST /api/feedback/retune-weights
 */
export async function retuneWeightsHandler(_req: Request, res: Response): Promise<void> {
  const store = getStore();
  try {
    const adjustments = store.retuneWeights();
    res.json({ adjustments });
  } finally {
    store.close();
  }
}

/**
 * POST /api/feedback/regenerate-summary
 */
export async function regenerateSummaryHandler(_req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const store = new FeedbackStore(config.storage.dbPath);
  try {
    const summary = await generatePreferenceSummary(
      store,
      config.content?.model ?? "claude-sonnet-4-6"
    );
    if (!summary) {
      res.status(400).json({ error: "Not enough feedback data to generate summary (need ≥10 ratings)" });
      return;
    }
    res.json({ summary });
  } finally {
    store.close();
  }
}

/**
 * GET /api/feedback/status
 */
export async function feedbackStatusHandler(_req: Request, res: Response): Promise<void> {
  const config = loadConfig();
  const feedbackStore = new FeedbackStore(config.storage.dbPath);
  const jobStore = new JobStore(config.storage.dbPath);

  try {
    const stats = feedbackStore.getFeedbackStats();
    const weights = feedbackStore.getAllWeights();
    const latestSummary = feedbackStore.getLatestSummary();
    const recentCorrections = feedbackStore.getRecentCorrections(10);
    const recentFeedback = feedbackStore.getRecentFeedback(20);

    // Enrich recent feedback with job titles
    const enriched = recentFeedback.map((f) => {
      const job = jobStore.getById(f.jobId);
      return {
        ...f,
        jobTitle: job?.title ?? null,
        jobCompany: job?.company ?? null,
      };
    });

    res.json({
      stats,
      weights,
      latestSummary,
      recentCorrections,
      recentFeedback: enriched,
    });
  } finally {
    feedbackStore.close();
    jobStore.close();
  }
}

// ─── Internal: LLM preference summary generation ──────────────────

async function generatePreferenceSummary(
  store: FeedbackStore,
  model: string
): Promise<object | null> {
  const feedback = store.getRecentFeedback(100);
  if (feedback.length < 10) return null;

  const client = new Anthropic();

  const feedbackText = feedback
    .map((f) => `rating=${f.rating} identity=${f.matchedIdentity ?? "?"} features=${f.featuresJson ?? "{}"}`)
    .join("\n");

  const response = await client.messages.create({
    model,
    max_tokens: 1000,
    system: `You are an AI preference analyst. Given a log of job ratings from a user, identify patterns in what they like and dislike. Return a JSON object with exactly these keys:
{
  "strong_likes": string[],       // patterns consistently rated +1 or +2
  "strong_dislikes": string[],    // patterns consistently rated -1 or -2
  "weak_or_ambiguous": string[],  // mixed signals, unclear patterns
  "divergence_from_stated": string[]  // cases where the user rated against apparent stated preferences
}
JSON only, no markdown fences.`,
    messages: [
      {
        role: "user",
        content: `Analyze these ${feedback.length} job ratings:\n${feedbackText}`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const summaryJson = text.replace(/```json|```/g, "").trim();

  const windowStart = feedback[feedback.length - 1].votedAt;
  const windowEnd = feedback[0].votedAt;

  store.saveSummary({
    voteWindowStart: windowStart,
    voteWindowEnd: windowEnd,
    sampleSize: feedback.length,
    summaryJson,
    model,
  });

  return JSON.parse(summaryJson);
}
