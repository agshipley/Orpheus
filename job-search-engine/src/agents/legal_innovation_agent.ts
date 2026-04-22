/**
 * LegalInnovationAgent — Fetches legal / GC / compliance roles at legal-tech
 * companies and AI companies with active legal hiring.
 *
 * Targets: Harvey, Relativity, Everlaw, Ironclad, and other legal-tech ATS
 * boards (Greenhouse / Lever) plus cheerio scraping for job aggregators.
 *
 * Filter: role title must contain a legal/compliance/governance keyword,
 * OR the company is a legal-tech company (all roles pass).
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
  fetchLeverPostings,
  parseGreenhouseJob,
  parseLeverPosting,
  isLegalOrComplianceRole,
  withAgentTimeout,
} from "./fetch_utils.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";
import type { SpanBuilder } from "../observability/index.js";
import { nanoid } from "nanoid";

// ─── Company registry ─────────────────────────────────────────────

type ApiType = "greenhouse" | "lever" | "scrape";

interface CompanyEntry {
  name: string;
  api: ApiType;
  slug?: string;
  careersUrl?: string;
  /** If true, all roles pass title filter (it's a legal-tech company) */
  isLegalTech?: boolean;
}

const COMPANIES: CompanyEntry[] = [
  // Legal-tech companies — all roles pass (not just legal titles)
  { name: "Harvey",     api: "greenhouse", slug: "harveyai",   isLegalTech: true  },
  { name: "Ironclad",   api: "greenhouse", slug: "ironclad",   isLegalTech: true  },
  { name: "Everlaw",    api: "greenhouse", slug: "everlaw",    isLegalTech: true  },
  { name: "Relativity", api: "greenhouse", slug: "relativity", isLegalTech: true  },
  { name: "Clio",       api: "greenhouse", slug: "clio",       isLegalTech: true  },
  { name: "Lexion",     api: "lever",      slug: "lexion",     isLegalTech: true  },
  { name: "Juro",       api: "lever",      slug: "juro",       isLegalTech: true  },

  // Broader tech companies — only legal/GC/compliance roles
  { name: "Stripe",     api: "greenhouse", slug: "stripe",     isLegalTech: false },
  { name: "Rippling",   api: "lever",      slug: "rippling",   isLegalTech: false },
  { name: "Brex",       api: "greenhouse", slug: "brex",       isLegalTech: false },

  // Aggregator scrape
  {
    name: "LawNext Jobs",
    api: "scrape",
    careersUrl: "https://www.lawnext.com/jobs",
    isLegalTech: true,
  },
];

// ─── Agent ────────────────────────────────────────────────────────

export class LegalInnovationAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "legal_innovation",
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
    throw new Error("LegalInnovationAgent does not use MCP");
  }

  protected async search(
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<{ jobs: JobListing[]; toolCallCount: number; tokensUsed: number }> {
    span.addEvent("legal_innovation.search.start", { query: query.raw });

    const limit = pLimit(4);
    let toolCallCount = 0;

    const results = await Promise.allSettled(
      COMPANIES.map((co) =>
        limit(async () => {
          toolCallCount++;
          try {
            const jobs = await withAgentTimeout(this.fetchCompany(co), co.name);
            span.addEvent("legal_innovation.source.ok", { company: co.name, count: jobs.length });
            return jobs;
          } catch (err) {
            span.addEvent("legal_innovation.source.error", {
              company: co.name,
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
    span.addEvent("legal_innovation.search.done", { raw: jobs.length, filtered: filtered.length });

    return { jobs: filtered.slice(0, query.maxResults), toolCallCount, tokensUsed: 0 };
  }

  private async fetchCompany(co: CompanyEntry): Promise<JobListing[]> {
    if (co.api === "greenhouse" && co.slug) {
      const raw = await fetchGreenhouseJobs(co.slug);
      return raw
        .map((j) => {
          // Legal-tech companies: pass all roles. Others: only legal titles.
          if (!co.isLegalTech && !isLegalOrComplianceRole(j.title)) return null;
          return parseGreenhouseJob(j, co.name, "legal_innovation", false);
        })
        .filter((j): j is JobListing => j !== null);
    }

    if (co.api === "lever" && co.slug) {
      const raw = await fetchLeverPostings(co.slug);
      return raw
        .map((p) => {
          if (!co.isLegalTech && !isLegalOrComplianceRole(p.text)) return null;
          return parseLeverPosting(p, co.name, "legal_innovation", false);
        })
        .filter((j): j is JobListing => j !== null);
    }

    if (co.api === "scrape" && co.careersUrl) {
      return this.scrapeJobPage(co.name, co.careersUrl);
    }

    return [];
  }

  parseScrapedJobs(html: string, orgName: string, baseUrl: string): JobListing[] {
    const $ = cheerio.load(html);
    const jobs: JobListing[] = [];

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const text = $(el).text().trim();

      if (!text || text.length < 5 || text.length > 200) return;
      if (!isLegalOrComplianceRole(text)) return;

      const isJobLink =
        /\/(job|position|opening|posting|career|opportunity|role)s?\//.test(href) ||
        /\/(apply|join)/.test(href);
      if (!isJobLink) return;

      const url = href.startsWith("http") ? href : `${new URL(baseUrl).origin}${href}`;

      jobs.push({
        id: `legal_innovation_sc_${nanoid(10)}`,
        source: "legal_innovation",
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

    const seen = new Set<string>();
    return jobs.filter((j) => {
      if (seen.has(j.url)) return false;
      seen.add(j.url);
      return true;
    });
  }

  private async scrapeJobPage(orgName: string, url: string): Promise<JobListing[]> {
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
