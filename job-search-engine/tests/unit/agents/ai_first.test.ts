import { describe, it, expect } from "vitest";
import {
  parseGreenhouseJob,
  parseLeverPosting,
  type GreenhouseJob,
  type LeverPosting,
} from "../../../src/agents/fetch_utils.js";

// ─── Fixtures ─────────────────────────────────────────────────────

const GH_HEAD_OF_OPS: GreenhouseJob = {
  id: 1234567,
  title: "Head of Operations",
  absolute_url: "https://boards.greenhouse.io/anthropic/jobs/1234567",
  location: { name: "San Francisco, CA" },
  departments: [{ id: 1, name: "Operations" }],
  offices: [{ id: 1, name: "San Francisco" }],
  updated_at: "2024-01-15T10:00:00Z",
  content: "<p>We are looking for a Head of Operations to scale our team.</p>",
};

const GH_SOFTWARE_ENGINEER: GreenhouseJob = {
  id: 9999001,
  title: "Software Engineer",
  absolute_url: "https://boards.greenhouse.io/anthropic/jobs/9999001",
  location: { name: "San Francisco, CA" },
  updated_at: "2024-01-15T10:00:00Z",
};

const GH_REMOTE_ROLE: GreenhouseJob = {
  id: 9999002,
  title: "Chief of Staff",
  absolute_url: "https://boards.greenhouse.io/openai/jobs/9999002",
  location: { name: "Remote" },
  updated_at: "2024-02-01T00:00:00Z",
};

const LV_POLICY_ROLE: LeverPosting = {
  id: "abc-uuid-1234",
  text: "Head of Policy",
  hostedUrl: "https://jobs.lever.co/mistral/abc-uuid-1234",
  createdAt: 1700000000000,
  categories: {
    team: "Policy",
    location: "Paris or Remote",
    commitment: "Full-time",
  },
  descriptionPlain: "Lead policy engagement at Mistral.",
};

const LV_ML_ENGINEER: LeverPosting = {
  id: "abc-uuid-5678",
  text: "ML Engineer",
  hostedUrl: "https://jobs.lever.co/mistral/abc-uuid-5678",
  createdAt: 1700000000000,
  categories: { team: "Engineering", location: "Paris", commitment: "Full-time" },
  descriptionPlain: "Train large language models.",
};

// ─── Tests ────────────────────────────────────────────────────────

describe("parseGreenhouseJob", () => {
  it("parses a Greenhouse job into a well-formed JobListing", () => {
    const job = parseGreenhouseJob(GH_HEAD_OF_OPS, "Anthropic", "ai_first", false);
    expect(job).not.toBeNull();
    expect(job!.title).toBe("Head of Operations");
    expect(job!.company).toBe("Anthropic");
    expect(job!.source).toBe("ai_first");
    expect(job!.url).toBe("https://boards.greenhouse.io/anthropic/jobs/1234567");
    expect(job!.description).toContain("Head of Operations");
    expect(job!.tags).toEqual(["Operations"]);
  });

  it("detects remote from location field", () => {
    const job = parseGreenhouseJob(GH_REMOTE_ROLE, "OpenAI", "ai_first", false);
    expect(job).not.toBeNull();
    expect(job!.remote).toBe(true);
    expect(job!.location).toBe("");
  });

  it("excludes engineering-only roles when excludeEngineering=true", () => {
    const job = parseGreenhouseJob(GH_SOFTWARE_ENGINEER, "Anthropic", "ai_first", true);
    expect(job).toBeNull();
  });

  it("passes non-engineering roles through when excludeEngineering=true", () => {
    const job = parseGreenhouseJob(GH_HEAD_OF_OPS, "Anthropic", "ai_first", true);
    expect(job).not.toBeNull();
    expect(job!.title).toBe("Head of Operations");
  });

  it("returns null for a job with no title or URL", () => {
    const bad = { ...GH_HEAD_OF_OPS, title: "", absolute_url: "" };
    expect(parseGreenhouseJob(bad, "Acme", "ai_first", false)).toBeNull();
  });
});

describe("parseLeverPosting", () => {
  it("parses a Lever posting into a well-formed JobListing", () => {
    const job = parseLeverPosting(LV_POLICY_ROLE, "Mistral", "ai_first", false);
    expect(job).not.toBeNull();
    expect(job!.title).toBe("Head of Policy");
    expect(job!.company).toBe("Mistral");
    expect(job!.source).toBe("ai_first");
    expect(job!.url).toBe("https://jobs.lever.co/mistral/abc-uuid-1234");
  });

  it("excludes ML Engineer when excludeEngineering=true", () => {
    const job = parseLeverPosting(LV_ML_ENGINEER, "Mistral", "ai_first", true);
    expect(job).toBeNull();
  });

  it("sets remote=true when location contains 'Remote'", () => {
    const job = parseLeverPosting(LV_POLICY_ROLE, "Mistral", "ai_first", false);
    expect(job!.remote).toBe(true);
  });
});
