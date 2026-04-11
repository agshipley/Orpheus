/**
 * GetroAgent — Fetches job listings from VC-backed talent networks via Getro.
 *
 * Getro powers talent boards for many top-tier VC firms. This agent directly
 * queries the Getro public API (no key required for basic access) for each
 * configured network slug and merges the results.
 *
 * Networks targeted:
 *   sequoia, a16z, greylock, foundersfund, benchmark, accel
 *
 * No API key required. Node 20+ fetch used throughout.
 */

import { nanoid } from "nanoid";
import pLimit from "p-limit";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "./base_agent.js";
import { SpanBuilder } from "../observability/index.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";

// ─── Getro API types ──────────────────────────────────────────────

interface GetroJob {
  id: number | string;
  title: string;
  remote: boolean;
  location?: string;
  url: string;
  published_at?: string;
  company?: {
    name?: string;
  };
  department?: string;
  description?: string;
}

interface GetroResponse {
  jobs: GetroJob[];
  meta?: {
    total?: number;
  };
}

// ─── Network slugs ────────────────────────────────────────────────

const GETRO_NETWORKS = [
  "sequoia",
  "a16z",
  "greylock",
  "foundersfund",
  "benchmark",
  "accel",
];

// Categories that are clearly non-relevant (pure sales/marketing/support)
// We keep anything ambiguous, so the conductor ranking handles final ordering.
const SKIP_DEPARTMENTS = new Set([
  "sales development representative",
  "customer support",
  "customer success representative",
  "marketing",
  "accounting",
  "finance",
  "legal",
  "recruiting",
]);

// ─── Fetch helper ─────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
}

// ─── Agent ────────────────────────────────────────────────────────

export class GetroAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "getro",
      enabled: true,
      timeoutMs: 60000,
      maxRetries: 1,
      rateLimitRpm: 30,
      ...config,
    });
  }

  // ── No MCP transport needed ──────────────────────────────────────

  override async connect(): Promise<void> {
    this.connected = true;
  }

  override async disconnect(): Promise<void> {
    this.connected = false;
  }

  protected createTransport(): StdioClientTransport {
    throw new Error("GetroAgent does not use an MCP transport");
  }

  // ── Core search ─────────────────────────────────────────────────

  protected async search(
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<{ jobs: JobListing[]; toolCallCount: number; tokensUsed: number }> {
    span.addEvent("getro.search.start", { query: query.raw });

    const keywords = this.buildKeywords(query);
    const limit = pLimit(4);
    let toolCallCount = 0;

    // Fetch from each network in parallel
    const networkResults = await Promise.allSettled(
      GETRO_NETWORKS.map((network) =>
        limit(async () => {
          toolCallCount++;
          return this.fetchNetwork(network, query, span);
        })
      )
    );

    // Flatten, ignoring failed networks
    const allJobs: GetroJob[] = [];
    for (const result of networkResults) {
      if (result.status === "fulfilled") {
        allJobs.push(...result.value);
      }
    }

    span.addEvent("getro.raw.fetched", { count: allJobs.length });

    // Filter and convert
    const jobs: JobListing[] = [];
    for (const raw of allJobs) {
      if (jobs.length >= query.maxResults) break;

      const dept = (raw.department ?? "").toLowerCase();
      if (SKIP_DEPARTMENTS.has(dept)) continue;

      const description = raw.description ?? "";
      const searchText = `${raw.title} ${description}`.toLowerCase();

      // Keyword filter
      if (keywords.length > 0 && !keywords.some((kw) => searchText.includes(kw))) {
        continue;
      }

      // Remote filter
      if (query.remote && !raw.remote) continue;

      const job = this.toJobListing(raw);
      if (job) jobs.push(job);
    }

    span.addEvent("getro.search.done", { jobs: jobs.length });

    return { jobs, toolCallCount, tokensUsed: 0 };
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async fetchNetwork(
    network: string,
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<GetroJob[]> {
    // Getro public job board API endpoint pattern
    const url = new URL(
      `https://api.getro.com/v2/networks/${network}/jobs`
    );
    url.searchParams.set("page", "1");
    url.searchParams.set("per_page", "100");

    if (query.remote) {
      url.searchParams.set("remote", "true");
    }

    try {
      const data = await fetchJson<GetroResponse>(url.toString());
      span.addEvent("getro.network.fetched", {
        network,
        count: data.jobs?.length ?? 0,
      });
      return data.jobs ?? [];
    } catch (err) {
      // Non-fatal: a network may be unavailable or renamed
      span.addEvent("getro.network.error", {
        network,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private buildKeywords(query: SearchQuery): string[] {
    const stopWords = new Set([
      "the", "and", "for", "with", "that", "this", "from",
      "are", "was", "will", "can", "our", "you", "your",
    ]);

    const raw: string[] = [];
    if (query.title) raw.push(...query.title.split(/\s+/));
    raw.push(...query.skills);
    if (raw.length === 0 && query.raw) raw.push(...query.raw.split(/\s+/));

    return [
      ...new Set(
        raw
          .map((w) => w.toLowerCase().replace(/[^a-z0-9+#.]/g, ""))
          .filter((w) => w.length >= 2 && !stopWords.has(w))
      ),
    ];
  }

  private toJobListing(raw: GetroJob): JobListing | null {
    const company = raw.company?.name ?? "Unknown";
    const title = raw.title?.trim();
    if (!title || !company) return null;

    const url = raw.url ?? "";
    if (!url) return null;

    return {
      id: `getro_${nanoid(10)}`,
      source: "getro",
      sourceId: String(raw.id),
      title,
      company,
      location: raw.location ?? "",
      remote: raw.remote ?? false,
      description: raw.description ?? "",
      requirements: [],
      url,
      postedAt: raw.published_at
        ? new Date(raw.published_at).toISOString()
        : undefined,
      scrapedAt: new Date().toISOString(),
      tags: raw.department ? [raw.department] : [],
    };
  }
}
