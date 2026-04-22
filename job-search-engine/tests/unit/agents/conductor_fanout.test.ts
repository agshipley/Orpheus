/**
 * Conductor fan-out unit tests.
 *
 * Tests the fan-out behavior when all six active agent families are registered:
 *  1. All 6 agents fire and return results (18 jobs pre-dedup).
 *  2. One agent throws — other 5 succeed and the conductor completes cleanly.
 *
 * Uses the Conductor's injectable agentFactory to supply mock agents,
 * bypassing all real network calls and the Anthropic SDK.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Conductor } from "../../../src/conductor/conductor.js";
import { resetTracer } from "../../../src/observability/index.js";
import type { JobListing, AgentSource, SearchQuery } from "../../../src/types.js";
import type { AgentResult } from "../../../src/types.js";
import type { BaseAgent } from "../../../src/agents/base_agent.js";
import type { AgentFactory } from "../../../src/conductor/conductor.js";
import type { SpanBuilder } from "../../../src/observability/index.js";

// ─── Mock Anthropic SDK ──────────────────────────────────────────
// searchWide() does NOT call the LLM but the Conductor constructor
// calls new Anthropic(), so we need the module to resolve.

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(() => ({ messages: { create: vi.fn() } })),
}));

// ─── Minimal conductor config ─────────────────────────────────────

const TEST_CONFIG = {
  profile: {
    name: "Test User",
    skills: [],
    preferences: { remote: false },
  },
  agents: { concurrency: 5, timeoutMs: 30000, sources: [] },
  observability: {
    traceSamplingRate: 1.0,
    metricsExport: "none" as const,
    decisionLogLevel: "minimal" as const,
    costTracking: false,
  },
  content: { model: "claude-sonnet-4-6", temperature: 0.7, maxVariants: 1 },
  storage: { dbPath: ":memory:" },
};

// ─── Active agent sources ─────────────────────────────────────────

const SIX_SOURCES: AgentSource[] = [
  "ycombinator",
  "ai_first",
  "vc_portfolio",
  "operator_communities",
  "foundations_policy",
  "legal_innovation",
];

// ─── Fixtures ─────────────────────────────────────────────────────

function makeJob(source: AgentSource, n: number): JobListing {
  return {
    id: `${source}_job_${n}`,
    source,
    sourceId: `${n}`,
    title: `Job ${n} from ${source}`,
    company: `Company ${n}`,
    location: "Remote",
    remote: true,
    description: `Description for job ${n} from ${source}`,
    requirements: [],
    url: `https://example.com/${source}/jobs/${n}`,
    scrapedAt: new Date().toISOString(),
    tags: [],
  };
}

function makeResult(source: AgentSource, jobCount: number): AgentResult {
  return {
    source,
    jobs: Array.from({ length: jobCount }, (_, i) => makeJob(source, i + 1)),
    metadata: {
      queryTimeMs: 50,
      toolCallCount: 1,
      tokensUsed: 0,
      errors: [],
      cached: false,
    },
  };
}

// ─── Mock agent factory helpers ───────────────────────────────────

function mockAgent(source: AgentSource, jobCount: number): BaseAgent {
  return {
    config: { source },
    executeSearch: async (_q: SearchQuery, _span: SpanBuilder) =>
      makeResult(source, jobCount),
  } as unknown as BaseAgent;
}

function throwingAgent(source: AgentSource): BaseAgent {
  return {
    config: { source },
    executeSearch: async () => {
      throw new Error(`${source} agent timed out`);
    },
  } as unknown as BaseAgent;
}

// ─── Tests ────────────────────────────────────────────────────────

describe("Conductor fan-out (all 6 agent families)", () => {
  beforeEach(() => {
    resetTracer();
  });

  it("collects results from all 6 agents — 18 jobs pre-dedup", async () => {
    const factory: AgentFactory = () =>
      SIX_SOURCES.map((s) => mockAgent(s, 3));

    const conductor = new Conductor(TEST_CONFIG as never, factory);
    const result = await conductor.searchWide("operator");

    // Each of 6 agents returned 3 unique jobs → 18 total before dedup
    expect(result.stats.totalFound).toBe(18);
    // All 6 agents reported success (no errors)
    expect(result.stats.agentsSucceeded).toBe(6);
    expect(result.stats.agentsQueried).toBe(6);
  });

  it("graceful degradation: one agent throws, five succeed", async () => {
    const factory: AgentFactory = () => [
      throwingAgent("vc_portfolio"),
      mockAgent("ycombinator", 3),
      mockAgent("ai_first", 3),
      mockAgent("operator_communities", 3),
      mockAgent("foundations_policy", 3),
      mockAgent("legal_innovation", 3),
    ];

    const conductor = new Conductor(TEST_CONFIG as never, factory);
    const result = await conductor.searchWide("operator");

    // vc_portfolio threw — only 5 agents contributed jobs
    expect(result.stats.totalFound).toBe(15);
    // 5 succeeded, 1 errored
    expect(result.stats.agentsSucceeded).toBe(5);
    expect(result.stats.agentsQueried).toBe(6);
  });

  it("returns an empty result without throwing when all agents fail", async () => {
    const factory: AgentFactory = () =>
      SIX_SOURCES.map((s) => throwingAgent(s));

    const conductor = new Conductor(TEST_CONFIG as never, factory);
    // Should NOT throw — returns empty result
    const result = await conductor.searchWide("operator");

    expect(result.stats.totalFound).toBe(0);
    expect(result.stats.agentsSucceeded).toBe(0);
    expect(result.jobs).toHaveLength(0);
  });
});
