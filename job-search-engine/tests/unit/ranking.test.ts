import { describe, it, expect } from "vitest";
import {
  scoreForIdentity,
  scoreJob,
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
});
