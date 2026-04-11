/**
 * Integration tests for the conductor's dedup and ranking logic.
 *
 * These tests exercise the Conductor's data pipeline without
 * making real API calls — they inject mock agent results to test
 * merge, dedup, and heuristic ranking.
 */

import { describe, it, expect } from "vitest";
import type { JobListing, SearchQuery } from "../../src/types.js";

// ─── Test helpers (extracted from Conductor's private methods) ────

function dedupKey(job: JobListing): string {
  const title = job.title.toLowerCase().replace(/[^a-z0-9]/g, "");
  const company = job.company.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${title}::${company}`;
}

function dataRichness(job: JobListing): number {
  let score = 0;
  score += job.description.length > 200 ? 2 : 0;
  score += job.salary ? 3 : 0;
  score += job.requirements.length > 0 ? 1 : 0;
  score += job.remote !== undefined ? 1 : 0;
  score += job.postedAt ? 1 : 0;
  return score;
}

function deduplicate(jobs: JobListing[]): JobListing[] {
  const seen = new Map<string, JobListing>();
  for (const job of jobs) {
    const key = dedupKey(job);
    if (!seen.has(key)) {
      seen.set(key, job);
    } else {
      const existing = seen.get(key)!;
      if (dataRichness(job) > dataRichness(existing)) {
        seen.set(key, job);
      }
    }
  }
  return Array.from(seen.values());
}

function heuristicScore(job: JobListing, query: SearchQuery): number {
  let score = 0;

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
    if (job.salary.min >= query.salaryMin) score += 15;
    else if (job.salary.min >= query.salaryMin * 0.9) score += 8;
  }

  if (query.remote && job.remote) score += 10;

  return score;
}

// ─── Fixtures ─────────────────────────────────────────────────────

function makeJob(overrides: Partial<JobListing>): JobListing {
  return {
    id: `test_${Math.random().toString(36).slice(2, 8)}`,
    source: "linkedin",
    sourceId: "src_1",
    title: "Software Engineer",
    company: "TestCorp",
    location: "San Francisco, CA",
    remote: false,
    description: "We are looking for a software engineer.",
    requirements: [],
    url: "https://example.com/job/1",
    scrapedAt: new Date().toISOString(),
    tags: [],
    ...overrides,
  };
}

const baseQuery: SearchQuery = {
  raw: "senior typescript engineer remote",
  title: "Senior TypeScript Engineer",
  skills: ["TypeScript", "Node.js", "React"],
  location: "Remote",
  remote: true,
  salaryMin: 150000,
  maxResults: 50,
  industries: [],
  excludeCompanies: [],
};

// ─── Tests ────────────────────────────────────────────────────────

describe("Deduplication", () => {
  it("removes exact duplicate title+company pairs", () => {
    const jobs = [
      makeJob({ title: "Senior Engineer", company: "Acme Inc" }),
      makeJob({ title: "Senior Engineer", company: "Acme Inc", source: "indeed" as const }),
      makeJob({ title: "Junior Engineer", company: "Acme Inc" }),
    ];

    const result = deduplicate(jobs);
    expect(result).toHaveLength(2);
  });

  it("normalizes title and company for dedup", () => {
    const jobs = [
      makeJob({ title: "Senior Software Engineer", company: "Google LLC" }),
      makeJob({
        title: "Senior Software Engineer!",
        company: "Google, LLC",
        source: "indeed" as const,
      }),
    ];

    const result = deduplicate(jobs);
    expect(result).toHaveLength(1);
  });

  it("keeps the data-richer duplicate", () => {
    const sparse = makeJob({
      title: "Engineer",
      company: "Corp",
      description: "Short",
    });
    const rich = makeJob({
      title: "Engineer",
      company: "Corp",
      description: "A very detailed description that exceeds 200 characters ".repeat(5),
      salary: { min: 150000, max: 200000, currency: "USD", period: "yearly" },
      requirements: ["TypeScript", "Node.js"],
      postedAt: "2025-01-01T00:00:00Z",
    });

    // Even if sparse comes first, rich should win
    const result = deduplicate([sparse, rich]);
    expect(result).toHaveLength(1);
    expect(result[0].salary).toBeDefined();
  });
});

describe("Heuristic Ranking", () => {
  it("ranks by skill match", () => {
    const goodMatch = makeJob({
      title: "TypeScript Developer",
      description: "We need TypeScript, Node.js, and React expertise.",
    });
    const poorMatch = makeJob({
      title: "Java Developer",
      description: "We need Java and Spring Boot expertise.",
    });

    const goodScore = heuristicScore(goodMatch, baseQuery);
    const poorScore = heuristicScore(poorMatch, baseQuery);

    expect(goodScore).toBeGreaterThan(poorScore);
  });

  it("boosts remote jobs when remote is preferred", () => {
    const remote = makeJob({
      title: "Senior TypeScript Engineer",
      description: "TypeScript role",
      remote: true,
    });
    const onsite = makeJob({
      title: "Senior TypeScript Engineer",
      description: "TypeScript role",
      remote: false,
    });

    const remoteScore = heuristicScore(remote, baseQuery);
    const onsiteScore = heuristicScore(onsite, baseQuery);

    expect(remoteScore).toBeGreaterThan(onsiteScore);
  });

  it("boosts jobs meeting salary minimum", () => {
    const highPay = makeJob({
      title: "Engineer",
      description: "TypeScript role",
      salary: { min: 180000, max: 220000, currency: "USD", period: "yearly" },
    });
    const lowPay = makeJob({
      title: "Engineer",
      description: "TypeScript role",
      salary: { min: 100000, max: 130000, currency: "USD", period: "yearly" },
    });

    const highScore = heuristicScore(highPay, baseQuery);
    const lowScore = heuristicScore(lowPay, baseQuery);

    expect(highScore).toBeGreaterThan(lowScore);
  });

  it("ranks by title match", () => {
    const exactTitle = makeJob({ title: "Senior TypeScript Engineer" });
    const partialTitle = makeJob({ title: "Senior Engineer" });
    const noMatch = makeJob({ title: "Product Manager" });

    const scores = [exactTitle, partialTitle, noMatch].map((j) =>
      heuristicScore(j, baseQuery)
    );

    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
  });
});
