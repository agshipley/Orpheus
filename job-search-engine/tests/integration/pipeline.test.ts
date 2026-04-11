/**
 * Pipeline integration tests — full Conductor flow with no API keys.
 *
 * Architecture:
 *   Test → Conductor (real) → MockAgent → mock MCP server (real subprocess)
 *                         ↘ Anthropic SDK (mocked — returns fixture responses)
 *
 * The mock MCP server runs as an actual child process over stdio, so the
 * MCP transport, tool-call serialisation, and response parsing are all
 * exercised by production code. Only external network calls are replaced:
 *   - Anthropic messages.create  →  returns a fixture SearchQuery
 *
 * Fixture corpus: 7 jobs including one duplicate pair (mock-001 / mock-003).
 * After dedup the conductor should hold 6 unique jobs.
 */

import path from "path";
import { fileURLToPath } from "url";
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "../../src/agents/base_agent.js";
import { Conductor } from "../../src/conductor/conductor.js";
import { resetTracer } from "../../src/observability/index.js";
import type { AgentConfig, JobListing, SearchQuery } from "../../src/types.js";
import type { SpanBuilder } from "../../src/observability/index.js";
import type { AgentFactory } from "../../src/conductor/conductor.js";

// ─── Paths ────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.resolve(__dirname, "../../mcp-servers/mock/index.ts");

// ─── Anthropic mock ───────────────────────────────────────────────
// vi.hoisted() initialises the variable before vi.mock() hoisting runs,
// letting us reconfigure the mock per-test with mockResolvedValue.

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

// ─── Fixture query (returned by the mocked Anthropic call) ────────

const FIXTURE_QUERY: Omit<SearchQuery, "raw"> = {
  title: "TypeScript Engineer",
  skills: ["TypeScript"],
  remote: true,
  maxResults: 25,
  industries: [],
  excludeCompanies: [],
};

function mockAnthropicQuery(overrides: Partial<SearchQuery> = {}) {
  const query = { ...FIXTURE_QUERY, raw: "typescript remote", ...overrides };
  mockCreate.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(query) }],
    usage: { input_tokens: 120, output_tokens: 60 },
  });
}

// ─── MockAgent ───────────────────────────────────────────────────
// A concrete BaseAgent that spawns mcp-servers/mock/index.ts over stdio.
// No real job board or API key required.

interface MockJobRaw {
  jobId: string;
  title: string;
  company: { name: string };
  location: string;
  remote?: boolean;
  description: string;
  skills?: string[];
  url: string;
  listedAt?: string;
  salary?: { min: number; max: number; currency: string };
}

class MockAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "custom",
      enabled: true,
      timeoutMs: 30000,
      maxRetries: 0,
      rateLimitRpm: 100,
      ...config,
    });
  }

  protected createTransport(): StdioClientTransport {
    return new StdioClientTransport({
      command: "npx",
      args: ["tsx", MOCK_SERVER],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (e): e is [string, string] => e[1] !== undefined
        )
      ),
    });
  }

  protected async search(
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<{ jobs: JobListing[]; toolCallCount: number; tokensUsed: number }> {
    const raw = await this.callTool<{ jobs: MockJobRaw[]; total: number }>(
      "search_jobs",
      { keywords: query.raw, limit: query.maxResults },
      span
    );

    const jobs: JobListing[] = raw.jobs.map((j) => ({
      id: `mock_${j.jobId}`,
      source: "custom" as const,
      sourceId: j.jobId,
      title: j.title,
      company: j.company.name,
      location: j.location,
      remote: j.remote,
      description: j.description,
      requirements: j.skills ?? [],
      url: j.url,
      postedAt: j.listedAt,
      scrapedAt: new Date().toISOString(),
      tags: j.skills ?? [],
      salary: j.salary
        ? { ...j.salary, period: "yearly" as const }
        : undefined,
    }));

    return { jobs, toolCallCount: 1, tokensUsed: 0 };
  }
}

// ─── Agent factory helpers ────────────────────────────────────────

/** Returns a factory that always gives a single fresh MockAgent. */
function mockFactory(): AgentFactory {
  return () => [new MockAgent()];
}

/** Factory that returns a MockAgent that always throws during connect. */
class AlwaysFailAgent extends MockAgent {
  async connect(): Promise<void> {
    throw new Error("Intentional test failure");
  }
}

function failingFactory(): AgentFactory {
  return () => [new AlwaysFailAgent()];
}

// ─── Minimal conductor config ─────────────────────────────────────

const TEST_CONFIG = {
  profile: {
    name: "Test User",
    skills: ["TypeScript"],
    preferences: { remote: true },
  },
  agents: { concurrency: 2, timeoutMs: 30000, sources: ["custom"] },
  observability: {
    traceSamplingRate: 1.0,
    metricsExport: "none" as const,
    decisionLogLevel: "minimal" as const,
    costTracking: false,
  },
  content: { model: "claude-sonnet-4-20250514", temperature: 0.7, maxVariants: 1 },
  storage: { dbPath: ":memory:" },
};

// ─── Tests ────────────────────────────────────────────────────────

describe("Conductor pipeline (mock MCP server)", () => {
  beforeAll(() => {
    // Suppress stderr from MCP server subprocess in test output
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    resetTracer();
    mockCreate.mockReset();
  });

  // ── 1. End-to-end happy path ──────────────────────────────────

  it("returns results through the full pipeline", async () => {
    mockAnthropicQuery();

    const conductor = new Conductor(TEST_CONFIG as never, mockFactory());
    const result = await conductor.search("typescript remote");

    // We got jobs back
    expect(result.jobs.length).toBeGreaterThan(0);

    // The conductor ran and produced a trace
    expect(result.traceId).toMatch(/^orp_/);

    // Stats are populated
    expect(result.stats.agentsQueried).toBe(1);
    expect(result.stats.agentsSucceeded).toBe(1);
    expect(result.stats.durationMs).toBeGreaterThan(0);
  }, 60_000);

  // ── 2. Deduplication ─────────────────────────────────────────

  it("deduplicates jobs with the same title+company", async () => {
    // The mock server returns 7 jobs, 2 of which share the same
    // title ("Senior TypeScript Engineer") and company ("AlphaCorp").
    // After dedup: 6 unique jobs.
    // "engineer developer" hits all 7 fixtures (some titles have "Developer",
    // others have "Engineer" — the mock's keyword filter uses OR matching).
    mockAnthropicQuery({ raw: "engineer developer" }); // broad keyword → all 7 return

    const conductor = new Conductor(TEST_CONFIG as never, mockFactory());
    const result = await conductor.search("engineer");

    expect(result.stats.totalFound).toBe(7);
    expect(result.stats.afterDedup).toBe(6);
  }, 60_000);

  it("keeps the data-richer copy of a duplicate", async () => {
    // mock-001 has a long description + salary; mock-003 is sparse.
    // After dedup, the richer AlphaCorp entry (with salary) should survive.
    mockAnthropicQuery({ raw: "engineer" });

    const conductor = new Conductor(TEST_CONFIG as never, mockFactory());
    const result = await conductor.search("engineer");

    const alphaCorp = result.jobs.filter((j) => j.company === "AlphaCorp");
    expect(alphaCorp).toHaveLength(1);
    expect(alphaCorp[0].salary).toBeDefined();
    expect(alphaCorp[0].salary!.min).toBe(160000);
  }, 60_000);

  // ── 3. Ranking ────────────────────────────────────────────────

  it("ranks TypeScript jobs above Python jobs for a TypeScript query", async () => {
    mockAnthropicQuery({
      raw: "typescript engineer",
      skills: ["TypeScript"],
      title: "TypeScript Engineer",
    });

    const conductor = new Conductor(TEST_CONFIG as never, mockFactory());
    const result = await conductor.search("typescript engineer");

    const titles = result.jobs.map((j) => j.title);
    const firstPython = titles.findIndex((t) => t.includes("Python"));
    const lastTypescript = titles.map((t, i) => t.includes("TypeScript") ? i : -1)
      .filter((i) => i >= 0)
      .at(-1) ?? -1;

    // All TypeScript jobs should appear before the Python job
    // (firstPython === -1 means it was filtered out entirely — also fine)
    if (firstPython !== -1 && lastTypescript !== -1) {
      expect(lastTypescript).toBeLessThan(firstPython);
    }
  }, 60_000);

  it("surfaces remote jobs when remote is preferred", async () => {
    mockAnthropicQuery({ remote: true, raw: "engineer" });

    const conductor = new Conductor(TEST_CONFIG as never, mockFactory());
    const result = await conductor.search("engineer");

    // Top job should be remote
    expect(result.jobs[0].remote).toBe(true);
  }, 60_000);

  // ── 4. Fault tolerance ───────────────────────────────────────

  it("does not crash when an agent fails to connect", async () => {
    mockAnthropicQuery();

    const conductor = new Conductor(TEST_CONFIG as never, failingFactory());
    const result = await conductor.search("typescript remote");

    // No jobs, but the conductor returns gracefully
    expect(result.jobs).toHaveLength(0);
    expect(result.stats.agentsQueried).toBe(1);
    expect(result.stats.agentsSucceeded).toBe(0);

    // The failure was recorded in agent results
    const errors = result.agentResults.flatMap((r) => r.metadata.errors);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].code).toBe("AGENT_FAILURE");
  }, 30_000);

  // ── 5. MCP tool passthrough ───────────────────────────────────

  it("query parsing uses the Anthropic response", async () => {
    // Verify the conductor actually called Anthropic and used the result
    mockAnthropicQuery({
      raw: "typescript remote",
      skills: ["TypeScript", "React"],
      remote: true,
    });

    const conductor = new Conductor(TEST_CONFIG as never, mockFactory());
    const result = await conductor.search("typescript remote");

    // Anthropic was called exactly once (for parseQuery)
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // The parsed query was used for ranking — remote jobs should dominate
    const topJob = result.jobs[0];
    expect(topJob).toBeDefined();
    // A TypeScript + remote job should score high
    const topText = `${topJob.title} ${topJob.description}`.toLowerCase();
    expect(topText).toMatch(/typescript|react/i);
  }, 60_000);

  // ── 6. Multiple agents ────────────────────────────────────────

  it("aggregates results from multiple agents and deduplicates across them", async () => {
    mockAnthropicQuery({ raw: "engineer developer" });

    // Two agents both return the full fixture set (7 jobs each).
    // After fan-out + dedup: still 6 unique jobs (not 14).
    const twoAgents: AgentFactory = () => [new MockAgent(), new MockAgent()];
    const conductor = new Conductor(TEST_CONFIG as never, twoAgents);
    const result = await conductor.search("engineer developer");

    expect(result.stats.agentsQueried).toBe(2);
    expect(result.stats.agentsSucceeded).toBe(2);
    expect(result.stats.totalFound).toBe(14); // 7 × 2 raw
    expect(result.stats.afterDedup).toBe(6);  // dedup collapses back to 6
  }, 60_000);
});
