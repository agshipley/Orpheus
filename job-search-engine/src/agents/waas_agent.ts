/**
 * WaaSAgent — Fetches job listings from Work at a Startup (YC's job board).
 *
 * workatastartup.com is the primary source for this profile: YC companies are
 * the core target market (AI / developer tools / seed-stage startups).
 *
 * Approach: fetch the SSR Next.js page and extract the embedded __NEXT_DATA__
 * JSON rather than using WaaS's unpublished internal API, which is not versioned
 * or stable. If the page structure changes and we can't find a jobs array,
 * we return 0 results gracefully so Jobicy + HN still serve the search.
 *
 * No API key required. Node 20+ fetch used throughout.
 */

import { nanoid } from "nanoid";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "./base_agent.js";
import { SpanBuilder } from "../observability/index.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";

// ─── WaaS job shape ───────────────────────────────────────────────
// Defined loosely because the embedded Next.js schema is undocumented
// and may change. We normalise defensively in toJobListing().

interface WaaSJob {
  id?: string | number;
  title?: string;
  url?: string;
  applyUrl?: string;
  jobUrl?: string;
  company?: { name?: string; url?: string; slug?: string } | string;
  companyName?: string;
  location?: string | string[];
  locations?: Array<{ type?: string; country?: string; city?: string; text?: string }>;
  remote?: boolean;
  isRemote?: boolean;
  description?: string;
  postedDate?: string;
  postedAt?: string;
  createdAt?: string;
  salary?: { min?: number; max?: number; currency?: string };
  tags?: string[];
  skills?: string[];
  equity?: string;
}

// ─── Recursive jobs-array finder ─────────────────────────────────
// Walks the parsed __NEXT_DATA__ looking for the first array whose items
// look like job listings (have `title` + some URL field). This is resilient
// to schema changes since we're searching structurally rather than by key.

function findJobsArray(node: unknown, depth = 0): WaaSJob[] | null {
  if (depth > 10 || !node || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    if (node.length > 0 && typeof node[0] === "object" && node[0] !== null) {
      const sample = node[0] as Record<string, unknown>;
      const hasTitle = typeof sample.title === "string";
      const hasUrl =
        typeof sample.applyUrl === "string" ||
        typeof sample.url === "string" ||
        typeof sample.jobUrl === "string";
      if (hasTitle && hasUrl) return node as WaaSJob[];
    }
    // Search inside array elements too
    for (const item of node) {
      const found = findJobsArray(item, depth + 1);
      if (found && found.length > 0) return found;
    }
    return null;
  }

  // Search object values
  for (const val of Object.values(node as Record<string, unknown>)) {
    const found = findJobsArray(val, depth + 1);
    if (found && found.length > 0) return found;
  }
  return null;
}

// ─── Agent ────────────────────────────────────────────────────────

export class WaaSAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "waas",
      enabled: true,
      timeoutMs: 30000,
      maxRetries: 1,
      rateLimitRpm: 20,
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
    throw new Error("WaaSAgent does not use an MCP transport");
  }

  // ── Core search ─────────────────────────────────────────────────

  protected async search(
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<{ jobs: JobListing[]; toolCallCount: number; tokensUsed: number }> {
    span.addEvent("waas.search.start", { query: query.raw });

    // Build URL — role=other covers non-engineering (ops/CoS/leadership/PM)
    const url = new URL("https://www.workatastartup.com/jobs");
    url.searchParams.set("remote", "true");
    url.searchParams.set("role", "other");
    if (query.title) {
      url.searchParams.set("query", query.title);
    }

    let rawJobs: WaaSJob[] = [];
    try {
      const html = await this.fetchPage(url.toString());
      rawJobs = this.extractJobs(html, span);
    } catch (err) {
      // Non-fatal: page unavailable or structure changed — return 0 results
      span.addEvent("waas.page.error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { jobs: [], toolCallCount: 1, tokensUsed: 0 };
    }

    span.addEvent("waas.raw.fetched", { count: rawJobs.length });

    // Build keywords from query + profile targetTitles
    const keywords = this.buildKeywords(query);

    // Filter and convert
    const jobs: JobListing[] = [];
    for (const raw of rawJobs) {
      if (jobs.length >= query.maxResults) break;

      const searchText = `${raw.title ?? ""} ${raw.description ?? ""}`.toLowerCase();
      if (keywords.length > 0 && !keywords.some((kw) => searchText.includes(kw))) {
        continue;
      }

      const job = this.toJobListing(raw);
      if (job) jobs.push(job);
    }

    span.addEvent("waas.search.done", { jobs: jobs.length });

    return { jobs, toolCallCount: 1, tokensUsed: 0 };
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async fetchPage(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from workatastartup.com`);
    return res.text();
  }

  private extractJobs(html: string, span: SpanBuilder): WaaSJob[] {
    // Extract the Next.js embedded page data
    const match = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/
    );
    if (!match) {
      span.addEvent("waas.extract.no_next_data");
      return [];
    }

    let nextData: unknown;
    try {
      nextData = JSON.parse(match[1]);
    } catch {
      span.addEvent("waas.extract.parse_error");
      return [];
    }

    const jobs = findJobsArray(nextData);
    if (!jobs) {
      span.addEvent("waas.extract.no_jobs_array");
      return [];
    }

    return jobs;
  }

  private buildKeywords(query: SearchQuery): string[] {
    const stopWords = new Set([
      "the", "and", "for", "with", "that", "this", "from",
      "are", "was", "will", "can", "our", "you", "your",
    ]);

    const raw: string[] = [];
    if (query.title) raw.push(...query.title.split(/\s+/));
    raw.push(...query.skills);

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

  private toJobListing(raw: WaaSJob): JobListing | null {
    const title = raw.title?.trim();
    if (!title) return null;

    // Company — field may be an object or a plain string
    const company =
      typeof raw.company === "string"
        ? raw.company
        : (raw.company?.name ?? raw.companyName ?? "");
    if (!company) return null;

    // URL — prefer the apply URL, fall back to job page URL
    const url = raw.applyUrl ?? raw.url ?? raw.jobUrl ?? "";
    if (!url) return null;

    // Remote — explicit flag or check locations array
    const isRemote =
      raw.remote ??
      raw.isRemote ??
      (raw.locations ?? []).some(
        (l) => l.type === "remote" || l.text?.toLowerCase().includes("remote")
      ) ??
      false;

    // Location — flatten locations to a string
    let location = "";
    if (typeof raw.location === "string") {
      location = raw.location;
    } else if (Array.isArray(raw.location)) {
      location = raw.location.join(", ");
    } else if (raw.locations?.length) {
      location = raw.locations
        .map((l) => l.text ?? l.city ?? l.country ?? "")
        .filter(Boolean)
        .join(", ");
    }

    // Salary
    const salary = raw.salary?.min || raw.salary?.max
      ? {
          min: raw.salary.min,
          max: raw.salary.max,
          currency: raw.salary.currency ?? "USD",
          period: "yearly" as const,
        }
      : undefined;

    // Posted date
    const dateStr = raw.postedAt ?? raw.postedDate ?? raw.createdAt;
    let postedAt: string | undefined;
    if (dateStr) {
      try {
        postedAt = new Date(dateStr).toISOString();
      } catch {
        // ignore
      }
    }

    return {
      id: `waas_${nanoid(10)}`,
      source: "waas",
      sourceId: String(raw.id ?? nanoid(8)),
      title,
      company,
      location,
      remote: isRemote,
      salary,
      description: raw.description ?? "",
      requirements: [],
      url,
      postedAt,
      scrapedAt: new Date().toISOString(),
      tags: raw.tags ?? raw.skills ?? [],
    };
  }
}
