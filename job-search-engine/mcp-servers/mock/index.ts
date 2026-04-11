/**
 * Mock MCP Server — Returns deterministic fixture data for all 4 tools.
 *
 * Used exclusively in integration tests. No network calls, no API keys.
 * Implements the same JobBoardAdapter interface as the real servers so
 * the test exercises the actual MCP transport and tool-call path.
 *
 * Fixture corpus: 7 jobs (including 1 duplicate pair) across TypeScript,
 * React, and Python roles — enough to exercise dedup and ranking.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJobBoardServer } from "../../src/mcp/server.js";

// ─── Fixture Data ────────────────────────────────────────────────

const LONG_DESC = (role: string, skills: string) =>
  `We are seeking a talented software engineer to join our ${role} team and work with ${skills}. ` +
  `You will design, implement, and ship production features used by thousands of engineers. ` +
  `Our stack is modern, our team is small, and our impact is large. We offer competitive ` +
  `compensation, full remote flexibility, and meaningful equity. Apply via our careers page.`;

interface FixtureJob {
  jobId: string;
  title: string;
  company: { name: string };
  location: string;
  remote: boolean;
  description: string;
  skills: string[];
  url: string;
  listedAt: string;
  salary?: { min: number; max: number; currency: string };
}

const FIXTURE_JOBS: FixtureJob[] = [
  {
    // job-001: rich TypeScript role — wins dedup over job-003
    jobId: "mock-001",
    title: "Senior TypeScript Engineer",
    company: { name: "AlphaCorp" },
    location: "Remote",
    remote: true,
    description: LONG_DESC("platform", "TypeScript, React, Node.js, and PostgreSQL"),
    skills: ["TypeScript", "React", "Node.js", "PostgreSQL"],
    url: "https://alphacorp.example.com/jobs/001",
    listedAt: "2025-01-15T00:00:00.000Z",
    salary: { min: 160000, max: 200000, currency: "USD" },
  },
  {
    jobId: "mock-002",
    title: "TypeScript Developer",
    company: { name: "BetaTech" },
    location: "Remote",
    remote: true,
    description: LONG_DESC("product", "TypeScript, Node.js, and GraphQL"),
    skills: ["TypeScript", "Node.js", "GraphQL"],
    url: "https://betatech.example.com/jobs/002",
    listedAt: "2025-01-14T00:00:00.000Z",
    salary: { min: 140000, max: 180000, currency: "USD" },
  },
  {
    // job-003: sparse duplicate of job-001 — same title+company, no salary
    // The conductor's dedup should discard this in favour of job-001.
    jobId: "mock-003",
    title: "Senior TypeScript Engineer",
    company: { name: "AlphaCorp" },
    location: "Remote",
    remote: true,
    description: "TypeScript role at AlphaCorp.", // short — loses richness test
    skills: ["TypeScript"],
    url: "https://alphacorp.example.com/jobs/001",
    listedAt: "2025-01-15T00:00:00.000Z",
    // no salary
  },
  {
    jobId: "mock-004",
    title: "React Developer",
    company: { name: "GammaLabs" },
    location: "Remote",
    remote: true,
    description: LONG_DESC("frontend", "React, TypeScript, and Next.js"),
    skills: ["React", "TypeScript", "Next.js"],
    url: "https://gammalabs.example.com/jobs/004",
    listedAt: "2025-01-13T00:00:00.000Z",
    salary: { min: 150000, max: 190000, currency: "USD" },
  },
  {
    jobId: "mock-005",
    title: "Full Stack Engineer",
    company: { name: "DeltaCorp" },
    location: "New York, NY",
    remote: false,
    description: LONG_DESC("product", "React, Node.js, and AWS"),
    skills: ["React", "Node.js", "AWS"],
    url: "https://deltacorp.example.com/jobs/005",
    listedAt: "2025-01-12T00:00:00.000Z",
    salary: { min: 120000, max: 150000, currency: "USD" },
  },
  {
    jobId: "mock-006",
    title: "Python Backend Engineer",
    company: { name: "EpsilonInc" },
    location: "Remote",
    remote: true,
    description: LONG_DESC("data", "Python, Django, and PostgreSQL"),
    skills: ["Python", "Django", "PostgreSQL"],
    url: "https://epsiloninc.example.com/jobs/006",
    listedAt: "2025-01-11T00:00:00.000Z",
    salary: { min: 130000, max: 160000, currency: "USD" },
  },
  {
    jobId: "mock-007",
    title: "TypeScript Platform Engineer",
    company: { name: "ZetaSystems" },
    location: "Remote",
    remote: true,
    description: LONG_DESC("infrastructure", "TypeScript, Kubernetes, and Terraform"),
    skills: ["TypeScript", "Kubernetes", "Terraform"],
    url: "https://zetasystems.example.com/jobs/007",
    listedAt: "2025-01-10T00:00:00.000Z",
    salary: { min: 170000, max: 220000, currency: "USD" },
  },
];

const JOB_MAP = new Map(FIXTURE_JOBS.map((j) => [j.jobId, j]));

// ─── Adapter ─────────────────────────────────────────────────────

const server = createJobBoardServer({
  source: "custom",

  async searchJobs(params) {
    // Simple keyword filter so the tool behaves realistically.
    // The test controls keywords and can match all jobs by passing "engineer".
    const kw = (params.keywords ?? "").toLowerCase().split(/\s+/).filter(Boolean);

    let results = kw.length === 0
      ? FIXTURE_JOBS
      : FIXTURE_JOBS.filter((j) => {
          const hay = `${j.title} ${j.company.name} ${j.description} ${j.skills.join(" ")}`.toLowerCase();
          return kw.some((k) => hay.includes(k));
        });

    if (params.remoteFilter === "remote") {
      results = results.filter((j) => j.remote);
    }

    results = results.slice(0, params.limit ?? 25);

    return {
      jobs: results,
      total: results.length,
    };
  },

  async getJobDetail({ jobId }) {
    const job = JOB_MAP.get(jobId);
    if (!job) throw new Error(`Mock: job ${jobId} not found`);
    return job;
  },

  async checkSalary({ jobId }) {
    const job = JOB_MAP.get(jobId);
    if (!job || !job.salary) {
      return { note: "No salary information available" };
    }
    return {
      min: job.salary.min,
      max: job.salary.max,
      currency: job.salary.currency,
      source: "fixture",
    };
  },

  async submitApplication({ jobId }) {
    const job = JOB_MAP.get(jobId);
    return {
      success: true,
      message: `Mock application submitted for ${job?.title ?? jobId}`,
      confirmationId: `MOCK-${Date.now()}`,
    };
  },
});

const transport = new StdioServerTransport();
await server.connect(transport);
