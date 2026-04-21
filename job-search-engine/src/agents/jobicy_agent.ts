/**
 * JobicyAgent — Fetches remote job listings from Jobicy's public API.
 *
 * Jobicy is a curated remote jobs board with a free public REST API.
 * We fan-out across multiple relevant tags to maximize coverage for
 * operations / leadership / strategy roles.
 *
 * API endpoint: https://jobicy.com/api/v2/remote-jobs
 * No API key required. Node 20+ fetch used throughout.
 */

import { nanoid } from "nanoid";
import pLimit from "p-limit";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "./base_agent.js";
import { SpanBuilder } from "../observability/index.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";

// ─── Jobicy API types ─────────────────────────────────────────────

interface JobicyJob {
  id: number | string;
  slug?: string;
  url: string;
  jobTitle: string;
  companyName: string;
  companyLogo?: string;
  jobIndustry?: string[];
  jobType?: string[];
  jobGeo?: string;          // "Worldwide", "USA Only", "Anywhere", etc.
  jobLevel?: string;        // "Senior", "Manager", etc.
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;         // "2025-01-15 10:00:00"
  annualSalaryMin?: number;
  annualSalaryMax?: number;
  salaryCurrency?: string;
}

interface JobicyResponse {
  status: boolean;
  statusCode?: number;
  jobs: JobicyJob[];
}

// ─── Tags to query ────────────────────────────────────────────────
// Fan out across multiple tags so we catch ops/leadership/strategy
// roles even if they're categorised differently on the board.

const JOBICY_TAGS = ["operations", "management"];

// ─── Fetch helper ─────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
}

// ─── Agent ────────────────────────────────────────────────────────

export class JobicyAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "jobicy",
      enabled: true,
      timeoutMs: 30000,
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
    throw new Error("JobicyAgent does not use an MCP transport");
  }

  // ── Core search ─────────────────────────────────────────────────

  protected async search(
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<{ jobs: JobListing[]; toolCallCount: number; tokensUsed: number }> {
    span.addEvent("jobicy.search.start", { query: query.raw });

    const keywords = this.buildKeywords(query);
    const limit = pLimit(3);
    let toolCallCount = 0;

    // Fan out across tags in parallel
    const tagResults = await Promise.allSettled(
      JOBICY_TAGS.map((tag) =>
        limit(async () => {
          toolCallCount++;
          return this.fetchTag(tag, span);
        })
      )
    );

    // Flatten, dedup by ID across tags
    const seen = new Set<string>();
    const allJobs: JobicyJob[] = [];
    for (const result of tagResults) {
      if (result.status === "fulfilled") {
        for (const job of result.value) {
          const key = String(job.id);
          if (!seen.has(key)) {
            seen.add(key);
            allJobs.push(job);
          }
        }
      }
    }

    span.addEvent("jobicy.raw.fetched", { count: allJobs.length });

    // Keyword filter then convert
    const jobs: JobListing[] = [];
    for (const raw of allJobs) {
      if (jobs.length >= query.maxResults) break;

      const searchText = `${raw.jobTitle} ${raw.jobDescription ?? ""} ${raw.jobExcerpt ?? ""}`.toLowerCase();
      if (keywords.length > 0 && !keywords.some((kw) => searchText.includes(kw))) {
        continue;
      }

      const job = this.toJobListing(raw);
      if (job) jobs.push(job);
    }

    span.addEvent("jobicy.search.done", { jobs: jobs.length });

    return { jobs, toolCallCount, tokensUsed: 0 };
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async fetchTag(tag: string, span: SpanBuilder): Promise<JobicyJob[]> {
    const url = new URL("https://jobicy.com/api/v2/remote-jobs");
    url.searchParams.set("count", "25");
    url.searchParams.set("tag", tag);

    try {
      const data = await fetchJson<JobicyResponse>(url.toString());
      span.addEvent("jobicy.tag.fetched", {
        tag,
        count: data.jobs?.length ?? 0,
      });
      return data.jobs ?? [];
    } catch (err) {
      span.addEvent("jobicy.tag.error", {
        tag,
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

    // Profile targetTitles expand the keyword set so adjacent roles surface
    const profile = this.config.profile;
    for (const t of profile?.targetTitles ?? []) {
      raw.push(...t.split(/\s+/));
    }

    if (raw.length === 0 && query.raw) raw.push(...query.raw.split(/\s+/));

    return [
      ...new Set(
        raw
          .map((w) => w.toLowerCase().replace(/[^a-z0-9+#.]/g, ""))
          .filter((w) => w.length >= 3 && !stopWords.has(w))
      ),
    ];
  }

  private toJobListing(raw: JobicyJob): JobListing | null {
    const title = raw.jobTitle?.trim();
    const company = raw.companyName?.trim();
    if (!title || !company || !raw.url) return null;

    // pubDate format from Jobicy: "2025-01-15 10:00:00"
    let postedAt: string | undefined;
    if (raw.pubDate) {
      try {
        postedAt = new Date(raw.pubDate.replace(" ", "T") + "Z").toISOString();
      } catch {
        // ignore unparseable date
      }
    }

    const geo = (raw.jobGeo ?? "").toLowerCase();
    const isRemote =
      geo.includes("worldwide") ||
      geo.includes("remote") ||
      geo.includes("anywhere") ||
      geo.includes("global");

    const salary =
      raw.annualSalaryMin || raw.annualSalaryMax
        ? {
            min: raw.annualSalaryMin,
            max: raw.annualSalaryMax,
            currency: raw.salaryCurrency ?? "USD",
            period: "yearly" as const,
          }
        : undefined;

    return {
      id: `jobicy_${nanoid(10)}`,
      source: "jobicy",
      sourceId: String(raw.id),
      title,
      company,
      location: raw.jobGeo ?? "",
      remote: isRemote,
      salary,
      description: raw.jobDescription ?? raw.jobExcerpt ?? "",
      requirements: [],
      url: raw.url,
      postedAt,
      scrapedAt: new Date().toISOString(),
      tags: [...(raw.jobIndustry ?? []), ...(raw.jobType ?? [])],
    };
  }
}
