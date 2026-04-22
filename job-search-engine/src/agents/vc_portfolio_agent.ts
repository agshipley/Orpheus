/**
 * VcPortfolioAgent — Fetches non-engineering roles from top-tier VC portfolio job boards.
 *
 * Most major VC firms use Getro to power their portfolio job boards. This agent
 * tries each firm's likely Getro API endpoint and falls back gracefully on
 * 403 / 404 / non-Getro boards.
 *
 * Filter: removes IC-engineering titles so only operator / CoS / BizOps /
 * CorpDev / Head-of-AI roles surface.
 *
 * Per-fetch timeout: 10s. Per-agent ceiling: 20s.
 */

import pLimit from "p-limit";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "./base_agent.js";
import {
  fetchJsonCached,
  parseGetroJob,
  withAgentTimeout,
} from "./fetch_utils.js";
import type { GetroJob, GetroResponse } from "./fetch_utils.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";
import type { SpanBuilder } from "../observability/index.js";

// ─── Firm registry ────────────────────────────────────────────────

interface FirmEntry {
  name: string;
  /** Primary Getro-style API URL to try */
  apiUrl: string;
  /** Alternate URL to try if primary fails */
  altUrl?: string;
}

const FIRMS: FirmEntry[] = [
  {
    name: "Sequoia",
    apiUrl: "https://jobs.sequoiacap.com/api/v1/jobs",
    altUrl: "https://sequoia.getro.com/api/v1/jobs",
  },
  {
    name: "a16z",
    apiUrl: "https://jobs.a16z.com/api/v1/jobs",
    altUrl: "https://a16z.getro.com/api/v1/jobs",
  },
  {
    name: "Benchmark",
    apiUrl: "https://benchmark.getro.com/api/v1/jobs",
  },
  {
    name: "Founders Fund",
    apiUrl: "https://foundersfund.getro.com/api/v1/jobs",
  },
  {
    name: "Greylock",
    apiUrl: "https://jobs.greylock.com/api/v1/jobs",
    altUrl: "https://greylock.getro.com/api/v1/jobs",
  },
  {
    name: "Accel",
    apiUrl: "https://accel.getro.com/api/v1/jobs",
  },
  {
    name: "Kleiner Perkins",
    apiUrl: "https://kpcb.getro.com/api/v1/jobs",
    altUrl: "https://kleinerperkins.getro.com/api/v1/jobs",
  },
  {
    name: "Index Ventures",
    apiUrl: "https://indexventures.getro.com/api/v1/jobs",
  },
];

// ─── Agent ────────────────────────────────────────────────────────

export class VcPortfolioAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "vc_portfolio",
      enabled: true,
      timeoutMs: 20000,
      maxRetries: 0,
      rateLimitRpm: 20,
      ...config,
    });
  }

  override async connect(): Promise<void> { this.connected = true; }
  override async disconnect(): Promise<void> { this.connected = false; }
  protected createTransport(): StdioClientTransport {
    throw new Error("VcPortfolioAgent does not use MCP");
  }

  protected async search(
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<{ jobs: JobListing[]; toolCallCount: number; tokensUsed: number }> {
    span.addEvent("vc_portfolio.search.start", { query: query.raw });

    const limit = pLimit(3);
    let toolCallCount = 0;

    const results = await Promise.allSettled(
      FIRMS.map((firm) =>
        limit(async () => {
          toolCallCount++;
          try {
            const jobs = await withAgentTimeout(this.fetchFirm(firm), firm.name);
            span.addEvent("vc_portfolio.source.ok", { firm: firm.name, count: jobs.length });
            return jobs;
          } catch (err) {
            span.addEvent("vc_portfolio.source.error", {
              firm: firm.name,
              error: err instanceof Error ? err.message : String(err),
            });
            return [];
          }
        })
      )
    );

    const jobs: JobListing[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") jobs.push(...r.value);
    }

    const filtered = this.keywordFilter(jobs, query);
    span.addEvent("vc_portfolio.search.done", { raw: jobs.length, filtered: filtered.length });

    return { jobs: filtered.slice(0, query.maxResults), toolCallCount, tokensUsed: 0 };
  }

  private async fetchFirm(firm: FirmEntry): Promise<JobListing[]> {
    let raw: GetroJob[] | null = null;

    // Try primary URL
    try {
      const data = await fetchJsonCached<GetroResponse>(firm.apiUrl);
      raw = data.jobs ?? data.data ?? null;
    } catch {
      // Try alternate if available
      if (firm.altUrl) {
        const data = await fetchJsonCached<GetroResponse>(firm.altUrl);
        raw = data.jobs ?? data.data ?? null;
      }
    }

    if (!raw) return [];

    return raw
      .map((j) => parseGetroJob(j, "vc_portfolio", true))
      .filter((j): j is JobListing => j !== null);
  }

  private keywordFilter(jobs: JobListing[], query: SearchQuery): JobListing[] {
    if (!query.title && query.skills.length === 0) return jobs;
    const keywords = [
      ...(query.title ? [query.title.toLowerCase()] : []),
      ...query.skills.map((s) => s.toLowerCase()),
    ];
    return jobs.filter((j) => {
      const haystack = `${j.title} ${j.description}`.toLowerCase();
      return keywords.some((kw) => haystack.includes(kw));
    });
  }
}

// Re-export for tests
export { parseGetroJob } from "./fetch_utils.js";
