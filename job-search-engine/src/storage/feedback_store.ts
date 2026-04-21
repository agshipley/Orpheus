/**
 * FeedbackStore — SQLite persistence for the behavioral feedback loop.
 *
 * Tables (created alongside the existing job tables in the same DB file):
 *   job_feedback         — one row per user rating (-2..+2)
 *   ranker_weights       — per-(feature, identity) learned weight multipliers
 *   preference_summaries — LLM-generated summaries of rating patterns
 *
 * Weight math:
 *   Point-biserial correlation between feature-fired (bool) and normalised
 *   rating (rating/2 → -1..+1) over the last N ratings.
 *   new_weight = clamp(old_weight * (1 + r * 0.1), base*0.8, base*1.2)
 *   Requires ≥ MIN_SAMPLE_SIZE ratings per feature before adjusting.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";

// ─── Feature definitions ──────────────────────────────────────────

export const FEATURE_NAMES = [
  "title_match",
  "skill_match",
  "query_title_match",
  "salary_match",
  "remote_match",
  "recency",
  "org_adjacency",
  "legal_signals",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureWeights = Partial<Record<FeatureName, number>>;
export type IdentityWeightsMap = Record<string, FeatureWeights>;

export const MIN_SAMPLE_SIZE = 10;
export const WEIGHT_WINDOW   = 100;    // ratings to consider per feature
export const RETUNE_INTERVAL = 20;     // votes between auto-retune
export const SUMMARY_INTERVAL = 50;    // votes between auto-summary

// ─── Row types ────────────────────────────────────────────────────

export interface FeedbackRecord {
  id: string;
  jobId: string;
  rating: number; // -2..+2
  matchedIdentity: string | null;
  correctedIdentity: string | null;
  votedAt: string;
  searchQuery: string | null;
  featuresJson: string | null; // JSON: Record<FeatureName, boolean>
}

export interface RankerWeight {
  featureName: FeatureName;
  identity: string;
  weight: number;
  baseWeight: number;
  updatedAt: string;
  sampleSize: number;
  correlation: number | null;
}

export interface PreferenceSummary {
  id: string;
  generatedAt: string;
  voteWindowStart: string;
  voteWindowEnd: string;
  sampleSize: number;
  summaryJson: string;
  model: string;
}

export interface WeightAdjustment {
  featureName: FeatureName;
  identity: string;
  oldWeight: number;
  newWeight: number;
  correlation: number;
  sampleSize: number;
}

export interface FeedbackStats {
  total: number;
  distribution: Record<string, number>; // "-2".."+2" → count
  correctionCount: number;
}

// ─── Feature extraction from identityReasons strings ─────────────

export function extractFiredFeatures(
  reasons: string[]
): Record<FeatureName, boolean> {
  const joined = reasons.join("|").toLowerCase();
  return {
    title_match:       joined.includes("title match"),
    skill_match:       joined.includes("skill match"),
    query_title_match: joined.includes("query title"),
    salary_match:      joined.includes("salary"),
    remote_match:      joined.includes("remote match"),
    recency:           /posted \d+d ago/.test(joined),
    org_adjacency:     joined.includes("org adjacency"),
    legal_signals:     joined.includes("legal credential"),
  };
}

// ─── Point-biserial correlation ───────────────────────────────────

function pointBiserialCorrelation(
  pairs: Array<{ fired: boolean; rating: number }>
): number {
  const n = pairs.length;
  if (n < 2) return 0;

  const ratings = pairs.map((p) => p.rating);
  const mean = ratings.reduce((s, r) => s + r, 0) / n;
  const variance = ratings.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;

  const fired    = pairs.filter((p) => p.fired);
  const notFired = pairs.filter((p) => !p.fired);
  const n1 = fired.length;
  const n0 = notFired.length;
  if (n1 === 0 || n0 === 0) return 0;

  const m1 = fired.reduce((s, p) => s + p.rating, 0) / n1;
  const m0 = notFired.reduce((s, p) => s + p.rating, 0) / n0;

  return ((m1 - m0) / std) * Math.sqrt((n1 * n0) / (n * n));
}

// ─── FeedbackStore ────────────────────────────────────────────────

export class FeedbackStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.initializeTables();
  }

  private initializeTables(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_feedback (
        id                  TEXT PRIMARY KEY,
        job_id              TEXT NOT NULL,
        rating              INTEGER NOT NULL CHECK (rating BETWEEN -2 AND 2),
        matched_identity    TEXT,
        corrected_identity  TEXT,
        voted_at            TEXT NOT NULL,
        search_query        TEXT,
        features_json       TEXT
      );

      CREATE TABLE IF NOT EXISTS ranker_weights (
        feature_name  TEXT NOT NULL,
        identity      TEXT NOT NULL,
        weight        REAL NOT NULL DEFAULT 1.0,
        base_weight   REAL NOT NULL DEFAULT 1.0,
        updated_at    TEXT NOT NULL,
        sample_size   INTEGER NOT NULL DEFAULT 0,
        correlation   REAL,
        PRIMARY KEY (feature_name, identity)
      );

      CREATE TABLE IF NOT EXISTS preference_summaries (
        id                TEXT PRIMARY KEY,
        generated_at      TEXT NOT NULL,
        vote_window_start TEXT NOT NULL,
        vote_window_end   TEXT NOT NULL,
        sample_size       INTEGER NOT NULL,
        summary_json      TEXT NOT NULL,
        model             TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jf_voted_at   ON job_feedback(voted_at);
      CREATE INDEX IF NOT EXISTS idx_jf_identity   ON job_feedback(matched_identity);
      CREATE INDEX IF NOT EXISTS idx_jf_job_id     ON job_feedback(job_id);
    `);
  }

  // ─── Feedback recording ───────────────────────────────────────

  recordFeedback(params: {
    jobId: string;
    rating: number;
    matchedIdentity?: string;
    correctedIdentity?: string;
    searchQuery?: string;
    identityReasons?: Record<string, string[]>;
  }): string {
    const id = `fb_${nanoid(10)}`;

    // Extract fired features from the winning identity's reasons
    const reasons = params.identityReasons?.[params.matchedIdentity ?? ""] ?? [];
    const features = extractFiredFeatures(reasons);

    this.db.prepare(`
      INSERT INTO job_feedback
        (id, job_id, rating, matched_identity, corrected_identity,
         voted_at, search_query, features_json)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)
    `).run(
      id,
      params.jobId,
      params.rating,
      params.matchedIdentity ?? null,
      params.correctedIdentity ?? null,
      params.searchQuery ?? null,
      JSON.stringify(features),
    );

    return id;
  }

  getTotalRatings(): number {
    return (this.db.prepare(
      `SELECT COUNT(*) as n FROM job_feedback`
    ).get() as { n: number }).n;
  }

  getFeedbackStats(): FeedbackStats {
    const total = this.getTotalRatings();

    const rows = this.db.prepare(`
      SELECT rating, COUNT(*) as cnt FROM job_feedback GROUP BY rating
    `).all() as Array<{ rating: number; cnt: number }>;

    const distribution: Record<string, number> = {
      "-2": 0, "-1": 0, "0": 0, "1": 0, "2": 0,
    };
    for (const r of rows) {
      distribution[String(r.rating)] = r.cnt;
    }

    const correctionCount = (this.db.prepare(`
      SELECT COUNT(*) as n FROM job_feedback WHERE corrected_identity IS NOT NULL
    `).get() as { n: number }).n;

    return { total, distribution, correctionCount };
  }

  // Returns the last `limit` feedback rows for display / LLM input
  getRecentFeedback(limit = 100): FeedbackRecord[] {
    return (this.db.prepare(`
      SELECT * FROM job_feedback ORDER BY voted_at DESC LIMIT ?
    `).all(limit) as Array<{
      id: string; job_id: string; rating: number;
      matched_identity: string | null; corrected_identity: string | null;
      voted_at: string; search_query: string | null; features_json: string | null;
    }>).map((r) => ({
      id: r.id,
      jobId: r.job_id,
      rating: r.rating,
      matchedIdentity: r.matched_identity,
      correctedIdentity: r.corrected_identity,
      votedAt: r.voted_at,
      searchQuery: r.search_query,
      featuresJson: r.features_json,
    }));
  }

  // Returns feature-fired / normalised-rating pairs for correlation
  getFeaturePairs(
    featureName: FeatureName,
    identity: string,
    limit = WEIGHT_WINDOW
  ): Array<{ fired: boolean; rating: number }> {
    const rows = this.db.prepare(`
      SELECT rating, features_json
      FROM job_feedback
      WHERE matched_identity = ? AND features_json IS NOT NULL
      ORDER BY voted_at DESC
      LIMIT ?
    `).all(identity, limit) as Array<{
      rating: number; features_json: string;
    }>;

    return rows.map((r) => {
      const f = JSON.parse(r.features_json) as Record<string, boolean>;
      return { fired: Boolean(f[featureName]), rating: r.rating / 2 };
    });
  }

  // ─── Weights ─────────────────────────────────────────────────

  getWeight(featureName: FeatureName, identity: string): RankerWeight {
    const row = this.db.prepare(`
      SELECT * FROM ranker_weights WHERE feature_name = ? AND identity = ?
    `).get(featureName, identity) as {
      feature_name: string; identity: string; weight: number;
      base_weight: number; updated_at: string; sample_size: number;
      correlation: number | null;
    } | undefined;

    if (!row) {
      return {
        featureName: featureName as FeatureName,
        identity,
        weight: 1.0,
        baseWeight: 1.0,
        updatedAt: new Date().toISOString(),
        sampleSize: 0,
        correlation: null,
      };
    }
    return {
      featureName: row.feature_name as FeatureName,
      identity: row.identity,
      weight: row.weight,
      baseWeight: row.base_weight,
      updatedAt: row.updated_at,
      sampleSize: row.sample_size,
      correlation: row.correlation,
    };
  }

  getAllWeights(): RankerWeight[] {
    return (this.db.prepare(
      `SELECT * FROM ranker_weights ORDER BY identity, feature_name`
    ).all() as Array<{
      feature_name: string; identity: string; weight: number;
      base_weight: number; updated_at: string; sample_size: number;
      correlation: number | null;
    }>).map((r) => ({
      featureName: r.feature_name as FeatureName,
      identity: r.identity,
      weight: r.weight,
      baseWeight: r.base_weight,
      updatedAt: r.updated_at,
      sampleSize: r.sample_size,
      correlation: r.correlation,
    }));
  }

  // Returns nested map: identity → featureName → weight multiplier
  getWeightsMap(): IdentityWeightsMap {
    const rows = this.getAllWeights();
    const map: IdentityWeightsMap = {};
    for (const r of rows) {
      if (!map[r.identity]) map[r.identity] = {};
      map[r.identity][r.featureName] = r.weight;
    }
    return map;
  }

  upsertWeight(params: {
    featureName: FeatureName;
    identity: string;
    weight: number;
    baseWeight: number;
    sampleSize: number;
    correlation: number;
  }): void {
    this.db.prepare(`
      INSERT INTO ranker_weights
        (feature_name, identity, weight, base_weight, updated_at, sample_size, correlation)
      VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
      ON CONFLICT(feature_name, identity) DO UPDATE SET
        weight      = excluded.weight,
        updated_at  = excluded.updated_at,
        sample_size = excluded.sample_size,
        correlation = excluded.correlation
    `).run(
      params.featureName,
      params.identity,
      params.weight,
      params.baseWeight,
      params.sampleSize,
      params.correlation,
    );
  }

  resetWeight(featureName: FeatureName, identity: string): void {
    this.db.prepare(`
      DELETE FROM ranker_weights WHERE feature_name = ? AND identity = ?
    `).run(featureName, identity);
  }

  resetAllWeights(): void {
    this.db.prepare(`DELETE FROM ranker_weights`).run();
  }

  // ─── Weight adjustment (point-biserial correlation) ───────────

  retuneWeights(
    identities: string[] = ["operator", "legal", "research"]
  ): WeightAdjustment[] {
    const adjustments: WeightAdjustment[] = [];

    for (const identity of identities) {
      for (const featureName of FEATURE_NAMES) {
        const pairs = this.getFeaturePairs(featureName, identity);
        if (pairs.length < MIN_SAMPLE_SIZE) continue;

        const r = pointBiserialCorrelation(pairs);
        const current = this.getWeight(featureName, identity);
        const base = current.baseWeight;

        // Max ±20% adjustment from base weight per retune pass
        const nudge = r * 0.1;
        const rawNew = current.weight * (1 + nudge);
        const newWeight = Math.max(base * 0.8, Math.min(base * 1.2, rawNew));

        this.upsertWeight({
          featureName,
          identity,
          weight: Math.round(newWeight * 1000) / 1000,
          baseWeight: base,
          sampleSize: pairs.length,
          correlation: Math.round(r * 1000) / 1000,
        });

        adjustments.push({
          featureName,
          identity,
          oldWeight: current.weight,
          newWeight: Math.round(newWeight * 1000) / 1000,
          correlation: Math.round(r * 1000) / 1000,
          sampleSize: pairs.length,
        });
      }
    }

    return adjustments;
  }

  // ─── Preference summaries ─────────────────────────────────────

  getLatestSummary(): PreferenceSummary | null {
    const row = this.db.prepare(`
      SELECT * FROM preference_summaries ORDER BY generated_at DESC LIMIT 1
    `).get() as {
      id: string; generated_at: string; vote_window_start: string;
      vote_window_end: string; sample_size: number;
      summary_json: string; model: string;
    } | undefined;

    if (!row) return null;
    return {
      id: row.id,
      generatedAt: row.generated_at,
      voteWindowStart: row.vote_window_start,
      voteWindowEnd: row.vote_window_end,
      sampleSize: row.sample_size,
      summaryJson: row.summary_json,
      model: row.model,
    };
  }

  saveSummary(params: {
    voteWindowStart: string;
    voteWindowEnd: string;
    sampleSize: number;
    summaryJson: string;
    model: string;
  }): string {
    const id = `ps_${nanoid(10)}`;
    this.db.prepare(`
      INSERT INTO preference_summaries
        (id, generated_at, vote_window_start, vote_window_end,
         sample_size, summary_json, model)
      VALUES (?, datetime('now'), ?, ?, ?, ?, ?)
    `).run(
      id,
      params.voteWindowStart,
      params.voteWindowEnd,
      params.sampleSize,
      params.summaryJson,
      params.model,
    );
    return id;
  }

  // ─── Identity correction rules ────────────────────────────────

  getRecentCorrections(limit = 20): Array<{
    jobId: string;
    matchedIdentity: string | null;
    correctedIdentity: string | null;
    votedAt: string;
  }> {
    return (this.db.prepare(`
      SELECT job_id, matched_identity, corrected_identity, voted_at
      FROM job_feedback
      WHERE corrected_identity IS NOT NULL
      ORDER BY voted_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      job_id: string; matched_identity: string | null;
      corrected_identity: string | null; voted_at: string;
    }>).map((r) => ({
      jobId: r.job_id,
      matchedIdentity: r.matched_identity,
      correctedIdentity: r.corrected_identity,
      votedAt: r.voted_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
