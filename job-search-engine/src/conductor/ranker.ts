/**
 * Multi-identity job ranker.
 *
 * Evaluates every job against four professional identities (operator, legal,
 * research, applied_ai_operator) independently and takes the MAX score as the
 * overall match score. The winning identity drives score, badge, and
 * content-generator framing.
 *
 * Normalisation: score / MAX_RAW_SCORE (160) clamped to [0, 1].
 * Org-adjacency and legal-signal boosts can push past 160 — they clamp to 1.0,
 * so a tier-1 AI-safety org with a research title correctly shows 100%.
 *
 * github_signal boost: up to +20 per identity based on unique keyword hits
 * against the identity's aggregated company_keywords bag. Scaled linearly:
 * 1 hit = +5, 2 = +10, 3 = +15, 4+ = +20. Below targetTitles (+60) by design.
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
// Org-adjacency (+60/50/40), legal signals (+25), and github_signal (+20) can
// exceed this — they clamp at normalisation.
export const MAX_RAW_SCORE = 160;

// ─── github_signal boost ──────────────────────────────────────────

type GithubSignalEntry = NonNullable<Config["github_signal"]>[number];

/**
 * Compute the github_signal company-affinity boost for one identity.
 * Returns points (0–20) and a reason string, or null if no boost.
 */
export function computeGithubSignalBoost(
  job: JobListing,
  identityKey: IdentityKey,
  githubSignal: GithubSignalEntry[]
): { pts: number; reason: string } | null {
  if (!githubSignal || githubSignal.length === 0) return null;

  // Aggregate unique keywords from all entries that boost this identity
  const keywordBag = new Set<string>();
  for (const entry of githubSignal) {
    if (entry.identity_boosts.includes(identityKey)) {
      for (const kw of entry.company_keywords) {
        keywordBag.add(kw.toLowerCase());
      }
    }
  }
  if (keywordBag.size === 0) return null;

  const haystack = `${job.company} ${job.description}`.toLowerCase();
  const hits = [...keywordBag].filter((kw) => haystack.includes(kw));
  if (hits.length === 0) return null;

  // Linear scale: 1=+5, 2=+10, 3=+15, 4+=+20
  const pts = Math.min(20, hits.length * 5);
  const topHits = hits.slice(0, 3).join(", ");
  return { pts, reason: `GitHub signal: ${topHits}${hits.length > 3 ? ` +${hits.length - 3} more` : ""} (+${pts})` };
}

// ─── Per-identity scorer ──────────────────────────────────────────

export function scoreForIdentity(
  job: JobListing,
  identityKey: IdentityKey,
  identity: IdentityConfig,
  query: SearchQuery,
  orgAdjacency?: Config["org_adjacency"],
  featureWeights?: FeatureWeights,
  githubSignal?: GithubSignalEntry[]
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

  // ── github_signal company-affinity boost (+0..+20) ─────────────
  if (githubSignal && githubSignal.length > 0) {
    const boost = computeGithubSignalBoost(job, identityKey, githubSignal);
    if (boost) {
      score += boost.pts;
      reasons.push(boost.reason);
      console.log(`[ranker] job=${job.id} identity=${identityKey} base=${score - boost.pts} github_signal=+${boost.pts} final=${score}`);
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

// ─── Empty identity fallback ──────────────────────────────────────

const EMPTY_IDENTITY: IdentityConfig = {
  target_titles: [],
  positioning_guidance: "",
  resume_emphasis: "",
  cover_letter_emphasis: "",
  key_credentials: [],
  score_weight: 1.0,
};

// ─── Full job scorer ──────────────────────────────────────────────

export function scoreJob(
  job: JobListing,
  query: SearchQuery,
  profile: UserProfile,
  orgAdjacency: Config["org_adjacency"],
  identityWeights?: IdentityWeightsMap,
  githubSignal?: GithubSignalEntry[]
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
        operator:           { score: rawScore, reasons: ["Legacy single-profile scoring"] },
        legal:              { score: 0, reasons: [] },
        research:           { score: 0, reasons: [] },
        applied_ai_operator: { score: 0, reasons: [] },
      },
    };
  }

  const identityScores: Record<IdentityKey, IdentityScore> = {
    operator: scoreForIdentity(
      job, "operator", identities.operator, query, orgAdjacency,
      identityWeights?.operator, githubSignal
    ),
    legal: scoreForIdentity(
      job, "legal", identities.legal, query, orgAdjacency,
      identityWeights?.legal, githubSignal
    ),
    research: scoreForIdentity(
      job, "research", identities.research, query, orgAdjacency,
      identityWeights?.research, githubSignal
    ),
    applied_ai_operator: scoreForIdentity(
      job, "applied_ai_operator",
      identities.applied_ai_operator ?? EMPTY_IDENTITY,
      query, orgAdjacency,
      identityWeights?.applied_ai_operator, githubSignal
    ),
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
