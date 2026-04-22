/**
 * AiFirstAgent — Fetches jobs from frontier AI companies directly.
 *
 * Uses Greenhouse and Lever public APIs where available — no API key required.
 * Falls back gracefully (logs + 0 jobs) if a company's endpoint returns
 * 403 / 404 / malformed data or times out.
 *
 * Filter: removes IC-engineering and pure-research roles so only
 * operations / legal / policy / strategy / programs / applied-AI roles surface.
 *
 * Per-fetch timeout: 10s. Per-agent ceiling: 20s.
 */

import pLimit from "p-limit";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "./base_agent.js";
import {
  fetchGreenhouseJobs,
  fetchLeverPostings,
  parseGreenhouseJob,
  parseLeverPosting,
  withAgentTimeout,
} from "./fetch_utils.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";
import type { SpanBuilder } from "../observability/index.js";

// ─── Company registry ─────────────────────────────────────────────

type ApiType = "greenhouse" | "lever";

interface CompanyEntry {
  name: string;
  api: ApiType;
  slug: string;
}

const COMPANIES: CompanyEntry[] = [
  { name: "Anthropic",      api: "greenhouse", slug: "anthropic"       },
  { name: "OpenAI",         api: "greenhouse", slug: "openai"          },
  { name: "Scale AI",       api: "greenhouse", slug: "scaleai"         },
  { name: "Cohere",         api: "greenhouse", slug: "cohere"          },
  { name: "Hugging Face",   api: "greenhouse", slug: "huggingface"     },
  { name: "Perplexity",     api: "greenhouse", slug: "perplexityai"    },
  { name: "Character.AI",   api: "greenhouse", slug: "characterai"     },
  { name: "Mistral",        api: "lever",      slug: "mistral"         },
  { name: "Inflection",     api: "lever",      slug: "inflection-ai"   },
  { name: "Google DeepMind",api: "greenhouse", slug: "deepmind"        },
];

// ─── Agent ────────────────────────────────────────────────────────

export class AiFirstAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "ai_first",
      enabled: true,
      timeoutMs: 20000,
      maxRetries: 0,
      rateLimitRpm: 30,
      ...config,
    });
  }

  override async connect(): Promise<void> { this.connected = true; }
  override async disconnect(): Promise<void> { this.connected = false; }
  protected createTransport(): StdioClientTransport {
    throw new Error("AiFirstAgent does not use MCP");
  }

  protected async search(
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<{ jobs: JobListing[]; toolCallCount: number; tokensUsed: number }> {
    span.addEvent("ai_first.search.start", { query: query.raw });

    const limit = pLimit(4);
    let toolCallCount = 0;

    const perCompanyResults = await Promise.allSettled(
      COMPANIES.map((co) =>
        limit(async () => {
          toolCallCount++;
          try {
            const jobs = co.api === "greenhouse"
              ? await this.fetchGreenhouse(co)
              : await this.fetchLever(co);
            span.addEvent("ai_first.source.ok", { company: co.name, count: jobs.length });
            return jobs;
          } catch (err) {
            span.addEvent("ai_first.source.error", {
              company: co.name,
              error: err instanceof Error ? err.message : String(err),
            });
            return [];
          }
        })
      )
    );

    const jobs: JobListing[] = [];
    for (const r of perCompanyResults) {
      if (r.status === "fulfilled") jobs.push(...r.value);
    }

    // Keyword filter: surface roles relevant to this query
    const filtered = this.keywordFilter(jobs, query);
    span.addEvent("ai_first.search.done", { raw: jobs.length, filtered: filtered.length });

    return { jobs: filtered.slice(0, query.maxResults), toolCallCount, tokensUsed: 0 };
  }

  private async fetchGreenhouse(co: CompanyEntry): Promise<JobListing[]> {
    const raw = await withAgentTimeout(fetchGreenhouseJobs(co.slug), co.name);
    return raw
      .map((j) => parseGreenhouseJob(j, co.name, "ai_first", true))
      .filter((j): j is JobListing => j !== null);
  }

  private async fetchLever(co: CompanyEntry): Promise<JobListing[]> {
    const raw = await withAgentTimeout(fetchLeverPostings(co.slug), co.name);
    return raw
      .map((p) => parseLeverPosting(p, co.name, "ai_first", true))
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
