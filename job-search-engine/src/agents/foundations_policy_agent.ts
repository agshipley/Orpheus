/**
 * FoundationsPolicyAgent — Fetches program-officer, research-manager, and policy
 * roles from AI-adjacent foundations and policy organizations.
 *
 * Uses Greenhouse where orgs have adopted it (openphilanthropy, mozilla),
 * falls back to cheerio HTML scraping for others. All sources fail gracefully.
 *
 * Unlocks the research identity: program officer, senior fellow, research manager,
 * policy fellow roles that the HN / Jobicy corpus never contained.
 *
 * Per-fetch timeout: 10s. Per-agent ceiling: 20s.
 */

import pLimit from "p-limit";
import * as cheerio from "cheerio";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "./base_agent.js";
import {
  fetchCached,
  fetchGreenhouseJobs,
  parseGreenhouseJob,
  withAgentTimeout,
} from "./fetch_utils.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";
import type { SpanBuilder } from "../observability/index.js";
import { nanoid } from "nanoid";

// ─── Source registry ──────────────────────────────────────────────

type SourceType = "greenhouse" | "scrape";

interface SourceEntry {
  name: string;
  type: SourceType;
  slug?: string;          // for greenhouse
  careersUrl?: string;    // for scrape
}

const SOURCES: SourceEntry[] = [
  { name: "Open Philanthropy", type: "greenhouse", slug: "openphilanthropy" },
  { name: "Mozilla Foundation", type: "greenhouse", slug: "mozilla" },
  { name: "Knight Foundation",  type: "greenhouse", slug: "knightfoundation" },
  {
    name: "RAND Corporation",
    type: "scrape",
    careersUrl: "https://www.rand.org/jobs.html",
  },
  {
    name: "CSET Georgetown",
    type: "scrape",
    careersUrl: "https://cset.georgetown.edu/about-us/careers/",
  },
  {
    name: "GovAI",
    type: "scrape",
    careersUrl: "https://www.governance.ai/opportunities",
  },
  {
    name: "Ford Foundation",
    type: "greenhouse",
    slug: "fordfoundation",
  },
  {
    name: "Philanthropy News Digest",
    type: "scrape",
    careersUrl: "https://pndblog.typepad.com/pndblog/jobs/",
  },
];

// ─── Agent ────────────────────────────────────────────────────────

export class FoundationsPolicyAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "foundations_policy",
      enabled: true,
      timeoutMs: 20000,
      maxRetries: 0,
      rateLimitRpm: 10,
      ...config,
    });
  }

  override async connect(): Promise<void> { this.connected = true; }
  override async disconnect(): Promise<void> { this.connected = false; }
  protected createTransport(): StdioClientTransport {
    throw new Error("FoundationsPolicyAgent does not use MCP");
  }

  protected async search(
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<{ jobs: JobListing[]; toolCallCount: number; tokensUsed: number }> {
    span.addEvent("foundations_policy.search.start", { query: query.raw });

    const limit = pLimit(3);
    let toolCallCount = 0;

    const results = await Promise.allSettled(
      SOURCES.map((src) =>
        limit(async () => {
          toolCallCount++;
          try {
            const jobs = await withAgentTimeout(this.fetchSource(src), src.name);
            span.addEvent("foundations_policy.source.ok", { source: src.name, count: jobs.length });
            return jobs;
          } catch (err) {
            span.addEvent("foundations_policy.source.error", {
              source: src.name,
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
    span.addEvent("foundations_policy.search.done", { raw: jobs.length, filtered: filtered.length });

    return { jobs: filtered.slice(0, query.maxResults), toolCallCount, tokensUsed: 0 };
  }

  private async fetchSource(src: SourceEntry): Promise<JobListing[]> {
    if (src.type === "greenhouse" && src.slug) {
      const raw = await fetchGreenhouseJobs(src.slug);
      return raw
        .map((j) => parseGreenhouseJob(j, src.name, "foundations_policy", false))
        .filter((j): j is JobListing => j !== null);
    }

    if (src.type === "scrape" && src.careersUrl) {
      return this.scrapeCareerPage(src.name, src.careersUrl);
    }

    return [];
  }

  parseScrapedJobs(html: string, orgName: string, baseUrl: string): JobListing[] {
    const $ = cheerio.load(html);
    const jobs: JobListing[] = [];

    // Common patterns: <a> tags with job-like text near /job/ or /career/ or /position/ paths
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const text = $(el).text().trim();

      if (!text || text.length < 5 || text.length > 200) return;

      // Only follow links that look like individual job postings
      const isJobLink =
        /\/(job|position|opening|posting|career|opportunity|role)s?\//.test(href) ||
        /\/(apply|join|work-with-us)/.test(href);

      if (!isJobLink) return;

      const url = href.startsWith("http") ? href : `${new URL(baseUrl).origin}${href}`;

      jobs.push({
        id: `foundations_policy_sc_${nanoid(10)}`,
        source: "foundations_policy",
        sourceId: nanoid(8),
        title: text,
        company: orgName,
        location: "",
        remote: false,
        description: `${text} at ${orgName}`,
        requirements: [],
        url,
        scrapedAt: new Date().toISOString(),
        tags: [],
      });
    });

    // Dedupe by URL
    const seen = new Set<string>();
    return jobs.filter((j) => {
      if (seen.has(j.url)) return false;
      seen.add(j.url);
      return true;
    });
  }

  private async scrapeCareerPage(orgName: string, url: string): Promise<JobListing[]> {
    const html = await fetchCached(url);
    return this.parseScrapedJobs(html, orgName, url);
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
