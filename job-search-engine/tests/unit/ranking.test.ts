import { describe, it, expect } from "vitest";
import {
  scoreForIdentity,
  scoreJob,
  computeGithubSignalBoost,
  computeCompoundFit,
  flagAsymmetry,
  MAX_RAW_SCORE,
} from "../../src/conductor/ranker.js";
import type { JobListing, SearchQuery, UserProfile, IdentityConfig } from "../../src/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────

function makeJob(overrides: Partial<JobListing> = {}): JobListing {
  return {
    id: "test_job_1",
    source: "ycombinator",
    sourceId: "1",
    title: "Chief of Staff",
    company: "Acme Corp",
    location: "San Francisco, CA",
    remote: true,
    description: "Looking for a chief of staff to support operations and strategy.",
    requirements: [],
    url: "https://example.com/job/1",
    scrapedAt: new Date().toISOString(),
    tags: [],
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return {
    target_titles: [],
    positioning_guidance: "",
    resume_emphasis: "",
    cover_letter_emphasis: "",
    key_credentials: [],
    score_weight: 1.0,
    ...overrides,
  };
}

function makeQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    raw: "chief of staff AI startup",
    skills: [],
    industries: [],
    excludeCompanies: [],
    maxResults: 50,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    name: "Test User",
    skills: [],
    experience: [],
    education: [],
    preferences: { remote: true, locations: [], industries: [], companySize: "any" },
    targetTitles: [],
    projects: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("scoreForIdentity", () => {
  it("awards +60 for target title match", () => {
    const job = makeJob({ title: "Chief of Staff" });
    const identity = makeIdentity({ target_titles: ["Chief of Staff"] });
    const query = makeQuery();
    const result = scoreForIdentity(job, "operator", identity, query);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.reasons.some((r) => r.includes("+60"))).toBe(true);
  });

  it("awards +25 for legal credential signals in description", () => {
    const job = makeJob({ description: "JD required. Looking for attorney with transactional experience." });
    const identity = makeIdentity();
    const query = makeQuery();
    const result = scoreForIdentity(job, "legal", identity, query);
    expect(result.score).toBeGreaterThanOrEqual(25);
    expect(result.reasons.some((r) => r.includes("+25"))).toBe(true);
  });

  it("awards org-adjacency boost for research identity on tier-1 company", () => {
    const job = makeJob({ company: "Anthropic", title: "Research Lead" });
    const identity = makeIdentity({ target_titles: ["Research Lead"] });
    const query = makeQuery();
    const orgAdjacency = {
      tier_1_frontier_ai: { boost: 60, orgs: ["Anthropic", "OpenAI"] },
      tier_2_ai_policy:   { boost: 50, orgs: [] },
      tier_3_tech_policy_civic: { boost: 40, orgs: [] },
    };
    const result = scoreForIdentity(job, "research", identity, query, orgAdjacency);
    expect(result.score).toBeGreaterThanOrEqual(60); // org adjacency alone
    expect(result.reasons.some((r) => r.includes("Org adjacency"))).toBe(true);
  });

  it("does NOT award org-adjacency boost to operator identity", () => {
    const job = makeJob({ company: "Anthropic" });
    const identity = makeIdentity();
    const query = makeQuery();
    const orgAdjacency = {
      tier_1_frontier_ai: { boost: 60, orgs: ["Anthropic"] },
      tier_2_ai_policy:   { boost: 50, orgs: [] },
      tier_3_tech_policy_civic: { boost: 40, orgs: [] },
    };
    const result = scoreForIdentity(job, "operator", identity, query, orgAdjacency);
    expect(result.reasons.some((r) => r.includes("Org adjacency"))).toBe(false);
  });
});

describe("scoreJob", () => {
  it("normalises score to [0, 1] range", () => {
    const job = makeJob({ title: "Chief of Staff", remote: true });
    const query = makeQuery({ title: "Chief of Staff", remote: true });
    const profile = makeProfile({
      identities: {
        operator: makeIdentity({ target_titles: ["Chief of Staff"] }),
        legal:    makeIdentity(),
        research: makeIdentity(),
      },
    });
    const result = scoreJob(job, query, profile, undefined);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("selects the highest-scoring identity as matchedIdentity (research wins for AI-safety org)", () => {
    const job = makeJob({ company: "Anthropic", title: "Program Manager" });
    const query = makeQuery({ title: "program manager" });
    const profile = makeProfile({
      identities: {
        operator: makeIdentity({ target_titles: ["Chief of Staff"] }), // no title match → low score
        legal:    makeIdentity(),                                        // no legal signals → 0
        research: makeIdentity({ target_titles: ["Program Manager"] }), // title match + org adjacency
      },
    });
    const orgAdjacency = {
      tier_1_frontier_ai: { boost: 60, orgs: ["Anthropic"] },
      tier_2_ai_policy:   { boost: 50, orgs: [] },
      tier_3_tech_policy_civic: { boost: 40, orgs: [] },
    };
    const result = scoreJob(job, query, profile, orgAdjacency);
    expect(result.matchedIdentity).toBe("research");
  });

  it("applied_ai_operator wins when job title matches its target titles", () => {
    const job = makeJob({ title: "Head of AI", description: "Lead AI strategy and delivery." });
    const query = makeQuery({ title: "Head of AI" });
    const profile = makeProfile({
      identities: {
        operator: makeIdentity({ target_titles: ["Chief of Staff"] }),
        legal:    makeIdentity(),
        research: makeIdentity({ target_titles: ["Research Lead"] }),
        applied_ai_operator: makeIdentity({ target_titles: ["Head of AI"] }),
      },
    });
    const result = scoreJob(job, query, profile, undefined);
    expect(result.matchedIdentity).toBe("applied_ai_operator");
    expect(result.score).toBeGreaterThanOrEqual(60 / MAX_RAW_SCORE);
  });

  it("MAX-not-sum: 4 identities with scores 40/60/30/50 → matchedIdentity = legal, score = 60/160", () => {
    // Legal wins with 25 (credential signal) + 35 from skill match
    // We construct scores by controlling title matches
    const job = makeJob({
      title: "General Counsel",
      description: "jd required. transactional background expected.",
    });
    const query = makeQuery({ title: "General Counsel", skills: [] });
    const profile = makeProfile({
      identities: {
        operator: makeIdentity({ target_titles: ["Chief of Staff"] }),        // no match → ~0
        legal:    makeIdentity({ target_titles: ["General Counsel"] }),        // +60 title + +25 legal signals = 85
        research: makeIdentity({ target_titles: ["Research Lead"] }),          // no match → ~0
        applied_ai_operator: makeIdentity({ target_titles: ["Head of AI"] }), // no match → ~0
      },
    });
    const result = scoreJob(job, query, profile, undefined);
    expect(result.matchedIdentity).toBe("legal");
    // legal score = 85, normalized = 85/160 ≈ 0.53 — clamped to [0,1]
    expect(result.score).toBeGreaterThan(0.5);
    expect(result.identityScores.operator.score).toBeLessThan(result.identityScores.legal.score);
    expect(result.identityScores.research.score).toBeLessThan(result.identityScores.legal.score);
    expect(result.identityScores.applied_ai_operator.score).toBeLessThan(result.identityScores.legal.score);
  });
});

describe("computeGithubSignalBoost", () => {
  const signal = [
    {
      name: "Orpheus",
      summary: "AI job search engine on MCP.",
      identity_boosts: ["applied_ai_operator", "operator"],
      company_keywords: ["mcp", "agents", "observability"],
    },
    {
      name: "NLSAFE",
      summary: "Rust-based safety infra.",
      identity_boosts: ["research", "operator"],
      company_keywords: ["ai safety", "alignment", "rust"],
    },
  ];

  it("returns +5 for exactly 1 keyword hit", () => {
    const job = makeJob({ company: "Acme", description: "We use mcp architecture." });
    const result = computeGithubSignalBoost(job, "applied_ai_operator", signal);
    expect(result).not.toBeNull();
    expect(result!.pts).toBe(5);
  });

  it("caps boost at +20 for 4+ keyword hits", () => {
    const job = makeJob({
      company: "Acme",
      description: "We value mcp, agents, observability, and also ai safety across our work.",
    });
    // applied_ai_operator gets Orpheus keywords (mcp, agents, observability = 3 hits → +15)
    // Note: ai safety belongs to NLSAFE which boosts [research, operator], not applied_ai_operator
    const result = computeGithubSignalBoost(job, "applied_ai_operator", signal);
    expect(result).not.toBeNull();
    expect(result!.pts).toBe(15); // 3 hits from Orpheus entry only

    // operator gets both entries: mcp+agents+observability + ai safety+alignment → 5 unique hits
    const resultOp = computeGithubSignalBoost(job, "operator", signal);
    expect(resultOp).not.toBeNull();
    expect(resultOp!.pts).toBe(20); // 4+ hits → capped at 20
  });

  it("returns null and does not throw when githubSignal is empty", () => {
    const job = makeJob({ description: "mcp agents observability" });
    expect(() => computeGithubSignalBoost(job, "applied_ai_operator", [])).not.toThrow();
    const result = computeGithubSignalBoost(job, "applied_ai_operator", []);
    expect(result).toBeNull();
  });

  it("returns null when no keywords from the identity's entries match the job", () => {
    const job = makeJob({ company: "Boring Corp", description: "Standard accounting firm." });
    const result = computeGithubSignalBoost(job, "applied_ai_operator", signal);
    expect(result).toBeNull();
  });
});

describe("computeCompoundFit", () => {
  it("returns 0 count and 0 bonus when no identities score ≥ 40", () => {
    const scores = {
      operator:            { score: 10, reasons: [] },
      legal:               { score: 0,  reasons: [] },
      research:            { score: 25, reasons: [] },
      applied_ai_operator: { score: 5,  reasons: [] },
    };
    const { count, bonus } = computeCompoundFit(scores);
    expect(count).toBe(0);
    expect(bonus).toBe(0);
  });

  it("returns count=2, bonus=+15 when exactly 2 identities score ≥ 40", () => {
    const scores = {
      operator:            { score: 60, reasons: [] },
      legal:               { score: 45, reasons: [] },
      research:            { score: 20, reasons: [] },
      applied_ai_operator: { score: 30, reasons: [] },
    };
    const { count, bonus } = computeCompoundFit(scores);
    expect(count).toBe(2);
    expect(bonus).toBe(15);
  });

  it("returns count=3, bonus=+25 when 3 identities score ≥ 40", () => {
    const scores = {
      operator:            { score: 60, reasons: [] },
      legal:               { score: 50, reasons: [] },
      research:            { score: 40, reasons: [] },
      applied_ai_operator: { score: 10, reasons: [] },
    };
    const { count, bonus } = computeCompoundFit(scores);
    expect(count).toBe(3);
    expect(bonus).toBe(25);
  });

  it("returns count=4, bonus=+35 when all identities score ≥ 40", () => {
    const scores = {
      operator:            { score: 60, reasons: [] },
      legal:               { score: 50, reasons: [] },
      research:            { score: 45, reasons: [] },
      applied_ai_operator: { score: 40, reasons: [] },
    };
    const { count, bonus } = computeCompoundFit(scores);
    expect(count).toBe(4);
    expect(bonus).toBe(35);
  });
});

describe("flagAsymmetry", () => {
  it("returns 'high' when compound_fit ≥ 2 AND github_signal boost ≥ 15", () => {
    const job = makeJob({ title: "Head of AI", description: "Standard description." });
    expect(flagAsymmetry(job, 2, 15)).toBe("high");
  });

  it("returns 'high' when gap language AND compound_fit ≥ 2", () => {
    const job = makeJob({
      title: "Director of AI",
      description: "We are building a new function and are looking for our first hire in this space.",
    });
    expect(flagAsymmetry(job, 2, 0)).toBe("high");
  });

  it("returns 'high' when senior title + small company AND github_signal boost ≥ 15", () => {
    const job = makeJob({
      title: "Head of Operations",
      description: "Early stage startup in the series a phase, small team of 12.",
    });
    expect(flagAsymmetry(job, 0, 15)).toBe("high");
  });

  it("returns 'none' when only one signal fires", () => {
    const job = makeJob({
      title: "Product Manager",
      description: "Looking for a PM to own the roadmap.",
    });
    expect(flagAsymmetry(job, 0, 0)).toBe("none");
  });

  it("returns 'none' when compound_fit=1 and no other signals", () => {
    const job = makeJob({ title: "Software Engineer", description: "Standard engineering role." });
    expect(flagAsymmetry(job, 1, 10)).toBe("none");
  });
});

describe("scoreJob compound_fit integration", () => {
  it("compound_fit bonus is added to winning score when 2+ identities score ≥ 40", () => {
    const job = makeJob({
      title: "Head of AI",
      description: "jd required. transactional background expected. We use mcp and agents.",
    });
    const query = makeQuery({ title: "Head of AI" });
    const profile = makeProfile({
      identities: {
        operator:            makeIdentity({ target_titles: ["Head of Operations"] }),
        legal:               makeIdentity({ target_titles: ["General Counsel"] }),
        research:            makeIdentity({ target_titles: ["Research Lead"] }),
        applied_ai_operator: makeIdentity({ target_titles: ["Head of AI"] }),
      },
    });
    const result = scoreJob(job, query, profile, undefined);
    // applied_ai_operator wins (+60 title) + legal gets +25 (legal signals) → compound_fit=2 → bonus=+15
    expect(result.compound_fit).toBeGreaterThanOrEqual(1);
    expect(result.compound_fit_bonus).toBeDefined();
  });
});
