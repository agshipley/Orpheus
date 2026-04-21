/**
 * HN Agent — Fetches real job listings from HN "Ask HN: Who is Hiring?"
 *
 * Bypasses MCP entirely and calls the public HN APIs directly:
 *   1. Algolia API  → find the current month's "Who is Hiring?" thread ID
 *   2. Firebase API → get thread's top-level comment IDs (each is a job post)
 *   3. Firebase API → fetch each comment in parallel (p-limit concurrency)
 *   4. Parse HTML comment text → JobListing
 *   5. Filter by query keywords and return up to maxResults jobs
 *
 * No API key required. Node 20+ fetch used throughout.
 */

import pLimit from "p-limit";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "./base_agent.js";
import { SpanBuilder } from "../observability/index.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";

// ─── HN API types ─────────────────────────────────────────────────

interface HNItem {
  id: number;
  type?: string;
  by?: string;
  text?: string;       // HTML-encoded comment body
  time?: number;       // Unix timestamp
  kids?: number[];     // child comment IDs
  url?: string;
  deleted?: boolean;
  dead?: boolean;
}

interface AlgoliaHit {
  objectID: string;    // HN item ID as string
  title: string;
  created_at_i: number;
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
}

// ─── HTML helpers ─────────────────────────────────────────────────

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x60;/g, "`")
    .replace(/&nbsp;/g, " ");
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<p>/gi, "\n\n")            // HN uses <p> for paragraph breaks
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>[^<]*<\/a>/gi, "$1") // unwrap links
    .replace(/<[^>]+>/g, "")            // strip remaining tags
    .replace(/\n{3,}/g, "\n\n")         // collapse excessive blank lines
    .trim();
}

// ─── Fetch helper ─────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
}

// ─── Agent ────────────────────────────────────────────────────────

export class HNAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "ycombinator",
      enabled: true,
      timeoutMs: 90000,
      maxRetries: 1,
      rateLimitRpm: 60,
      ...config,
    });
  }

  // ── No MCP transport needed ──────────────────────────────────────

  /** Override to skip MCP connection entirely. */
  override async connect(): Promise<void> {
    this.connected = true;
  }

  /** Override to avoid calling client.close() on a never-connected client. */
  override async disconnect(): Promise<void> {
    this.connected = false;
  }

  /** Never called — satisfies BaseAgent's abstract signature. */
  protected createTransport(): StdioClientTransport {
    throw new Error("HNAgent does not use an MCP transport");
  }

  // ── Core search ─────────────────────────────────────────────────

  protected async search(
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<{ jobs: JobListing[]; toolCallCount: number; tokensUsed: number }> {
    span.addEvent("hn.search.start", { query: query.raw });

    // 1. Find the current "Who is Hiring?" thread via Algolia
    const threadId = await this.findHiringThread(span);

    // 2. Fetch thread to get top-level comment IDs
    const thread = await fetchJson<HNItem>(
      `https://hacker-news.firebaseio.com/v0/item/${threadId}.json`
    );
    const kids = thread.kids ?? [];
    span.addEvent("hn.thread.fetched", {
      threadId: String(threadId),
      commentCount: kids.length,
    });

    // 3. Fetch all top-level comments in parallel (Who is Hiring threads ~600-800)
    const fetchLimit = pLimit(20);
    const toFetch = kids;

    const comments = (
      await Promise.all(
        toFetch.map((id) =>
          fetchLimit(async () => {
            try {
              return await fetchJson<HNItem>(
                `https://hacker-news.firebaseio.com/v0/item/${id}.json`
              );
            } catch {
              return null;
            }
          })
        )
      )
    ).filter(
      (c): c is HNItem => c !== null && !c.deleted && !c.dead && !!c.text
    );

    span.addEvent("hn.comments.fetched", { fetched: comments.length });

    // 4. Build keyword list from the query (includes profile targetTitles as phrases)
    const { phrases, words } = this.buildKeywords(query);

    // Determine if profile indicates a non-engineering / ops / leadership focus
    const profile = this.config.profile;
    const skipPureEngineering = profile
      ? this.isNonEngineeringProfile(profile)
      : false;

    // 5. Parse, filter, cap at maxResults
    const jobs: JobListing[] = [];

    for (const comment of comments) {
      if (jobs.length >= query.maxResults) break;

      const text = htmlToText(comment.text!);
      if (!text) continue;

      // Keyword filter:
      // - When phrases are available (query title + all profile targetTitles), use
      //   phrase-only matching for precision. Any phrase hit = include.
      // - Fall back to any-word matching only when no phrases are defined.
      if (phrases.length > 0 || words.length > 0) {
        const lower = text.toLowerCase();
        if (phrases.length > 0) {
          if (!phrases.some((ph) => lower.includes(ph))) continue;
        } else {
          if (!words.some((w) => lower.includes(w))) continue;
        }
      }

      // Remote filter from query
      if (query.remote) {
        const lower = text.toLowerCase();
        if (!lower.includes("remote") && !lower.includes("distributed")) continue;
      }

      const job = this.parseComment(comment, text);
      if (!job) continue;

      // Profile filter: skip pure IC engineering postings when user is non-engineering
      if (skipPureEngineering && this.isPureEngineeringPost(text)) continue;

      jobs.push(job);
    }

    span.addEvent("hn.search.done", { jobs: jobs.length });

    return {
      jobs,
      toolCallCount: toFetch.length + 2,
      tokensUsed: 0,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async findHiringThread(span: SpanBuilder): Promise<number> {
    // Algolia filtered to the official whoishiring account, sorted by date
    const url =
      "https://hn.algolia.com/api/v1/search_by_date" +
      "?query=Ask+HN%3A+Who+is+hiring%3F" +
      "&tags=story%2Cauthor_whoishiring" +
      "&hitsPerPage=1";

    const data = await fetchJson<AlgoliaResponse>(url);

    if (!data.hits.length) {
      throw new Error("Could not locate 'Ask HN: Who is Hiring?' thread via Algolia");
    }

    const hit = data.hits[0];
    const id = parseInt(hit.objectID, 10);
    span.addEvent("hn.thread.found", { title: hit.title, id: String(id) });
    return id;
  }

  /**
   * Returns true when the user's profile signals a non-engineering / ops /
   * leadership focus — used to filter out pure IC engineering postings.
   */
  private isNonEngineeringProfile(
    profile: import("../types.js").UserProfile
  ): boolean {
    const guidance = (profile.positioningGuidance ?? "").toLowerCase();
    const nonEngineeringSignals = [
      "not a software engineer",
      "non-engineer",
      "operations",
      "chief of staff",
      "program manager",
      "product manager",
      "strategy",
      "business development",
      "sales",
      "marketing",
    ];
    if (nonEngineeringSignals.some((s) => guidance.includes(s))) return true;

    // If targetTitles contains zero engineering-flavoured words, treat as non-engineering
    const engineeringTitleRx =
      /engineer|developer|\bdev\b|fullstack|frontend|backend|ios|android|ml\b|ai\b|sre\b|devops|data scientist/i;
    if (
      (profile.targetTitles ?? []).length > 0 &&
      !(profile.targetTitles ?? []).some((t) => engineeringTitleRx.test(t))
    ) {
      return true;
    }

    return false;
  }

  /**
   * Returns true when the HN comment looks like a pure IC engineering hire
   * (e.g. "Software Engineer | …" with no leadership / ops context).
   */
  private isPureEngineeringPost(text: string): boolean {
    const firstLine = text.split("\n")[0].toLowerCase();
    const isEngineeringTitle =
      /\b(software engineer|backend engineer|frontend engineer|fullstack engineer|ml engineer|data engineer|staff engineer|principal engineer|sre|devops engineer|platform engineer|infrastructure engineer)\b/.test(
        firstLine
      );
    const hasLeadershipSignal =
      /\b(chief of staff|head of|vp\b|director|program manager|product manager|operations|strategy|biz ops)\b/.test(
        text.toLowerCase()
      );
    return isEngineeringTitle && !hasLeadershipSignal;
  }

  /**
   * Build a deduplicated keyword list for matching HN comments.
   *
   * phrases: full multi-word strings checked via substring match (high-precision)
   * words: individual tokens, any-one match (broad recall)
   *
   * Profile targetTitles are added as phrases so a search for "chief of staff"
   * also surfaces posts matching "head of operations", "biz ops", etc.
   */
  private buildKeywords(query: SearchQuery): { phrases: string[]; words: string[] } {
    const stopWords = new Set([
      "the", "and", "for", "with", "that", "this", "from", "have",
      "are", "was", "will", "can", "our", "you", "your", "but", "not",
      "of", "in", "at", "to", "by", "an", "a", "is", "it", "be", "or",
      "as", "on", "up", "we", "us", "if",
    ]);

    const phrases: string[] = [];

    // Primary phrase: the full query title (e.g. "chief of staff")
    if (query.title && query.title.trim().split(/\s+/).length >= 2) {
      phrases.push(query.title.toLowerCase().trim());
    }

    // Also include profile targetTitles as phrases so adjacent roles surface
    const profile = this.config.profile;
    for (const t of profile?.targetTitles ?? []) {
      const tl = t.toLowerCase().trim();
      if (tl.length >= 3 && !phrases.includes(tl)) phrases.push(tl);
    }

    // Individual words for broad any-one fallback
    const wordSources: string[] = [];
    if (query.title) wordSources.push(...query.title.split(/\s+/));
    wordSources.push(...query.skills);
    if (wordSources.length === 0 && query.raw) {
      wordSources.push(...query.raw.split(/\s+/));
    }

    const words = [
      ...new Set(
        wordSources
          .map((w) => w.toLowerCase().replace(/[^a-z0-9+#.]/g, ""))
          .filter((w) => w.length >= 4 && !stopWords.has(w))
      ),
    ];

    return { phrases, words };
  }

  /**
   * Parse a raw HN comment into a JobListing.
   *
   * The most common HN job post formats:
   *   Company | Location | Remote | Role description
   *   Company | Role | Location | Remote | Salary
   *
   * We parse the pipe-separated first line and scan the full text
   * for remote/location signals.
   */
  private parseComment(item: HNItem, text: string): JobListing | null {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;

    const firstLine = lines[0];
    const parts = firstLine.split("|").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;

    const company = parts[0];

    // Remote — scan full text
    const textLower = text.toLowerCase();
    const remote =
      textLower.includes("remote") || textLower.includes("distributed");

    // Title extraction order:
    // 1. Pipe segment that matches a profile targetTitle phrase (highest priority)
    // 2. Pipe segment that matches general role keywords
    // 3. Full first line if it looks like a role description
    // 4. "Hiring at Company"
    const roleRx =
      /engineer|developer|\bdev\b|designer|manager|product|data|ml\b|ai\b|devops|fullstack|full.?stack|frontend|front.?end|backend|back.?end|ios\b|android|mobile|\bqa\b|\bsre\b|reliability|cto|vp\b|director|\blead\b|scientist|analyst|architect|researcher|chief of staff|operations|strategy|bizops|biz ops|founding/i;

    const profileTargets = (this.config.profile?.targetTitles ?? []).map(t => t.toLowerCase());
    const targetPart = parts.slice(1).find((p) =>
      profileTargets.some((tt) => p.toLowerCase().includes(tt))
    );
    const rolePart = targetPart ?? parts.slice(1).find((p) => roleRx.test(p));
    const title = rolePart
      ? `${rolePart.trim()} at ${company}`
      : roleRx.test(firstLine)
      ? firstLine.slice(0, 120)
      : `Hiring at ${company}`;

    // Location — first pipe segment that looks like a place, not a role or keyword
    const locationStops = new Set([
      "remote", "onsite", "on-site", "hybrid", "full-time", "fulltime",
      "part-time", "parttime", "contract", "freelance", "intern", "internship",
      "visa", "h1b", "equity", "benefits",
    ]);
    const location =
      parts.slice(1).find((p) => {
        const pl = p.toLowerCase();
        return (
          !locationStops.has(pl) &&
          !/remote/i.test(p) &&
          !roleRx.test(p) &&
          p.length >= 2 &&
          p.length <= 60 &&
          !/^https?:\/\//.test(p) &&
          !/\$/.test(p)
        );
      }) ?? "";

    // Salary — parse common patterns: $150k, $100k-$150k, $100,000, etc.
    const salaryRx =
      /\$\s*(\d{2,3})[kK](?:\s*[-–]\s*\$?\s*(\d{2,3})[kK])?|\$\s*(\d{3,6})(?:\s*[-–]\s*\$?\s*(\d{3,6}))?/;
    const salaryMatch = text.match(salaryRx);
    let salary: JobListing["salary"] | undefined;
    if (salaryMatch) {
      const parseVal = (s: string | undefined): number | undefined => {
        if (!s) return undefined;
        const n = parseInt(s.replace(/,/g, ""), 10);
        return n < 1000 ? n * 1000 : n;
      };
      if (salaryMatch[1]) {
        salary = {
          min: parseVal(salaryMatch[1]),
          max: parseVal(salaryMatch[2]),
          currency: "USD",
          period: "yearly",
        };
      } else if (salaryMatch[3]) {
        salary = {
          min: parseVal(salaryMatch[3]),
          max: parseVal(salaryMatch[4]),
          currency: "USD",
          period: "yearly",
        };
      }
    }

    // URL — first https link in text, or HN item permalink
    const urlMatch = text.match(/https?:\/\/[^\s<>"']+/);
    const url = urlMatch
      ? urlMatch[0].replace(/[.,;)]+$/, "")
      : `https://news.ycombinator.com/item?id=${item.id}`;

    return {
      id: `hn_${item.id}`,
      source: "ycombinator",
      sourceId: String(item.id),
      title,
      company,
      location,
      remote,
      salary,
      description: text,
      requirements: [],
      url,
      postedAt: item.time
        ? new Date(item.time * 1000).toISOString()
        : undefined,
      scrapedAt: new Date().toISOString(),
      tags: [],
    };
  }
}
