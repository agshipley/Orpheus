/**
 * Multi-identity job ranker.
 *
 * Evaluates every job against three professional identities (operator, legal,
 * research) independently and takes the MAX score as the overall match score.
 * The winning identity drives score, badge, and content-generator framing.
 *
 * Normalisation: score / MAX_RAW_SCORE (160) clamped to [0, 1].
 * Org-adjacency and legal-signal boosts can push past 160 — they clamp to 1.0,
 * so a tier-1 AI-safety org with a research title correctly shows 100%.
 */

import type { JobListing, SearchQuery, UserProfile, IdentityConfig, IdentityKey, Config } from "../types.js";
import type { FeatureWeights, IdentityWeightsMap } from "../storage/feedback_store.js";

export type { IdentityKey };

export interface IdentityScore {
  score: number;
  reasons: string[];
}

export interface JobScore {
  score: number;                              // normalised [0, 1]
  rawScore: number;                           // raw points before normalisation
  matchedIdentity: IdentityKey;
  identityScores: Record<IdentityKey, IdentityScore>;
}

// The theoretical maximum for base signals: 60+40+30+15+10+5 = 160.
// Org-adjacency (+60/50/40) and legal signals (+25) can exceed this — they clamp.
export const MAX_RAW_SCORE = 160;

// ─── Per-identity scorer ──────────────────────────────────────────

export function scoreForIdentity(
  job: JobListing,
  identityKey: IdentityKey,
  identity: IdentityConfig,
  query: SearchQuery,
  orgAdjacency?: Config["org_adjacency"],
  featureWeights?: FeatureWeights
): IdentityScore {
  let score = 0;
  const reasons: string[] = [];
  const w = featureWeights ?? {};

  // ── +60 target title match ─────────────────────────────────────
  if (identity.target_titles.length > 0) {
    const jobTitleLower = job.title.toLowerCase();
    const matched = identity.target_titles.find((t) =>
      jobTitleLower.includes(t.toLowerCase())
    );
    if (matched) {
      const pts = Math.round(60 * (w.title_match ?? 1.0));
      score += pts;
      reasons.push(`Title match: "${matched}" (+${pts})`);
    }
  }

  // ── +40 skill match ────────────────────────────────────────────
  if (query.skills.length > 0) {
    const descLower = job.description.toLowerCase();
    const matchCount = query.skills.filter((s) =>
      descLower.includes(s.toLowerCase())
    ).length;
    const pts = Math.round((matchCount / query.skills.length) * 40 * (w.skill_match ?? 1.0));
    if (pts > 0) {
      score += pts;
      reasons.push(`Skill match: ${matchCount}/${query.skills.length} (+${pts})`);
    }
  }

  // ── +30 query title word match ─────────────────────────────────
  if (query.title) {
    const titleWords = query.title.toLowerCase().split(/\s+/);
    const jobTitleLower = job.title.toLowerCase();
    const matched = titleWords.filter((w) => jobTitleLower.includes(w)).length;
    const pts = Math.round((matched / titleWords.length) * 30 * (w.query_title_match ?? 1.0));
    if (pts > 0) {
      score += pts;
      reasons.push(`Query title: ${matched}/${titleWords.length} words (+${pts})`);
    }
  }

  // ── +15/+8 salary ──────────────────────────────────────────────
  if (query.salaryMin && job.salary?.min) {
    const salaryW = w.salary_match ?? 1.0;
    if (job.salary.min >= query.salaryMin) {
      const pts = Math.round(15 * salaryW);
      score += pts;
      reasons.push(`Salary ≥ min: $${Math.round(job.salary.min / 1000)}k (+${pts})`);
    } else if (job.salary.min >= query.salaryMin * 0.9) {
      const pts = Math.round(8 * salaryW);
      score += pts;
      reasons.push(`Salary near min: $${Math.round(job.salary.min / 1000)}k (+${pts})`);
    }
  }

  // ── +10 remote ─────────────────────────────────────────────────
  if (query.remote && job.remote) {
    const pts = Math.round(10 * (w.remote_match ?? 1.0));
    score += pts;
    reasons.push(`Remote match (+${pts})`);
  }

  // ── +5/3/1 recency ─────────────────────────────────────────────
  if (job.postedAt) {
    const daysAgo =
      (Date.now() - new Date(job.postedAt).getTime()) / (1000 * 60 * 60 * 24);
    const recencyW = w.recency ?? 1.0;
    if (daysAgo < 3) {
      const pts = Math.round(5 * recencyW);
      score += pts;
      reasons.push(`Posted ${Math.round(daysAgo)}d ago (+${pts})`);
    } else if (daysAgo < 7) {
      const pts = Math.round(3 * recencyW);
      score += pts;
      reasons.push(`Posted ${Math.round(daysAgo)}d ago (+${pts})`);
    } else if (daysAgo < 14) {
      const pts = Math.round(1 * recencyW);
      score += pts;
      reasons.push(`Posted ${Math.round(daysAgo)}d ago (+${pts})`);
    }
  }

  // ── Research only: org adjacency boost ────────────────────────
  // Tiers are already ordered by boost size (tier_1 highest); apply the
  // first match so a tier-1 org doesn't stack with lower tiers.
  if (identityKey === "research" && orgAdjacency) {
    const companyLower = job.company.toLowerCase();
    const orgW = w.org_adjacency ?? 1.0;
    const tiers = [
      { label: "tier_1 (frontier AI)", tier: orgAdjacency.tier_1_frontier_ai },
      { label: "tier_2 (AI policy)",   tier: orgAdjacency.tier_2_ai_policy },
      { label: "tier_3 (tech/civic)",  tier: orgAdjacency.tier_3_tech_policy_civic },
    ];

    for (const { label, tier } of tiers) {
      if (!tier) continue;
      const match = tier.orgs.find((org) =>
        companyLower.includes(org.toLowerCase())
      );
      if (match) {
        const pts = Math.round(tier.boost * orgW);
        score += pts;
        reasons.push(`Org adjacency ${label}: "${match}" (+${pts})`);
        break;
      }
    }
  }

  // ── Legal only: credential signals in description (+25) ────────
  if (identityKey === "legal") {
    const legalSignals = [
      "jd",
      "law degree",
      "legal background",
      "attorney",
      "counsel",
      "deal experience",
      "transactional",
    ];
    const descLower = job.description.toLowerCase();
    const hits = legalSignals.filter((s) => descLower.includes(s));
    if (hits.length > 0) {
      const pts = Math.round(25 * (w.legal_signals ?? 1.0));
      score += pts;
      reasons.push(`Legal credential signals: ${hits.join(", ")} (+${pts})`);
    }
  }

  // ── score_weight multiplier (default 1.0 → no-op) ─────────────
  const weight = identity.score_weight ?? 1.0;
  if (weight !== 1.0) {
    score = Math.round(score * weight);
    reasons.push(`Weight ×${weight}`);
  }

  return { score, reasons };
}

// ─── Full job scorer ──────────────────────────────────────────────

export function scoreJob(
  job: JobListing,
  query: SearchQuery,
  profile: UserProfile,
  orgAdjacency: Config["org_adjacency"],
  identityWeights?: IdentityWeightsMap
): JobScore {
  const identities = profile.identities;

  // Legacy fallback: no identities block defined in profile
  if (!identities) {
    const rawScore = legacyScore(job, query, profile);
    return {
      score: Math.min(1, rawScore / MAX_RAW_SCORE),
      rawScore,
      matchedIdentity: "operator",
      identityScores: {
        operator: { score: rawScore, reasons: ["Legacy single-profile scoring"] },
        legal:    { score: 0, reasons: [] },
        research: { score: 0, reasons: [] },
      },
    };
  }

  const identityScores: Record<IdentityKey, IdentityScore> = {
    operator: scoreForIdentity(job, "operator", identities.operator, query, orgAdjacency, identityWeights?.operator),
    legal:    scoreForIdentity(job, "legal",    identities.legal,    query, orgAdjacency, identityWeights?.legal),
    research: scoreForIdentity(job, "research", identities.research, query, orgAdjacency, identityWeights?.research),
  };

  // MAX wins — take the highest-scoring identity
  const entries = (Object.entries(identityScores) as [IdentityKey, IdentityScore][]);
  entries.sort((a, b) => b[1].score - a[1].score);
  const [matchedIdentity, winner] = entries[0];

  return {
    score: Math.min(1, winner.score / MAX_RAW_SCORE),
    rawScore: winner.score,
    matchedIdentity,
    identityScores,
  };
}

// ─── Legacy single-profile scorer (profile without identities block) ──

function legacyScore(
  job: JobListing,
  query: SearchQuery,
  profile: UserProfile
): number {
  let score = 0;

  if ((profile.targetTitles ?? []).length > 0) {
    const jobTitleLower = job.title.toLowerCase();
    if ((profile.targetTitles ?? []).some((t) => jobTitleLower.includes(t.toLowerCase()))) {
      score += 60;
    }
  }

  if (query.skills.length > 0) {
    const descLower = job.description.toLowerCase();
    const matchCount = query.skills.filter((s) =>
      descLower.includes(s.toLowerCase())
    ).length;
    score += (matchCount / query.skills.length) * 40;
  }

  if (query.title) {
    const titleWords = query.title.toLowerCase().split(/\s+/);
    const jobTitleLower = job.title.toLowerCase();
    const titleMatch = titleWords.filter((w) =>
      jobTitleLower.includes(w)
    ).length;
    score += (titleMatch / titleWords.length) * 30;
  }

  if (query.salaryMin && job.salary?.min) {
    if (job.salary.min >= query.salaryMin)           score += 15;
    else if (job.salary.min >= query.salaryMin * 0.9) score += 8;
  }

  if (query.remote && job.remote) score += 10;

  if (job.postedAt) {
    const daysAgo =
      (Date.now() - new Date(job.postedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysAgo < 3)       score += 5;
    else if (daysAgo < 7)  score += 3;
    else if (daysAgo < 14) score += 1;
  }

  return score;
}
