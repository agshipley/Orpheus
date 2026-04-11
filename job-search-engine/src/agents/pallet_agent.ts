/**
 * PalletAgent — Fetches job listings from Pallet-powered talent boards.
 *
 * Pallet hosts curated job boards for communities and networks. This agent
 * queries the Pallet public API for boards focused on operations, leadership,
 * and business functions — complementing HN (IC engineering) and Getro (VC networks).
 *
 * Boards targeted:
 *   - The Chief of Staff Network
 *   - Operators Guild
 *   - Additional ops/leadership boards
 *
 * No API key required. Node 20+ fetch used throughout.
 */

import { nanoid } from "nanoid";
import pLimit from "p-limit";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "./base_agent.js";
import { SpanBuilder } from "../observability/index.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";

// ─── Pallet API types ─────────────────────────────────────────────

interface PalletJob {
  id: string;
  title: string;
  company: {
    name: string;
    website?: string;
  };
  location?: string;
  remote?: boolean;
  url: string;
  description?: string;
  created_at?: string;
  tags?: string[];
  salary_min?: number;
  salary_max?: number;
}

interface PalletResponse {
  data: PalletJob[];
  meta?: {
    total?: number;
    page?: number;
  };
}

// ─── Board slugs ──────────────────────────────────────────────────

// Pallet board slugs for ops/leadership/biz communities
const PALLET_BOARDS = [
  "chief-of-staff-network",
  "operators-guild",
  "every-strategy",      // operators and strategists community
  "exec-roles",          // senior individual contributor / exec roles
];

// ─── Fetch helper ─────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json() as Promise<T>;
}

// ─── Agent ────────────────────────────────────────────────────────

export class PalletAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "pallet",
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
    throw new Error("PalletAgent does not use an MCP transport");
  }

  // ── Core search ─────────────────────────────────────────────────

  protected async search(
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<{ jobs: JobListing[]; toolCallCount: number; tokensUsed: number }> {
    span.addEvent("pallet.search.start", { query: query.raw });

    const keywords = this.buildKeywords(query);
    const limit = pLimit(4);
    let toolCallCount = 0;

    const boardResults = await Promise.allSettled(
      PALLET_BOARDS.map((board) =>
        limit(async () => {
          toolCallCount++;
          return this.fetchBoard(board, span);
        })
      )
    );

    const allJobs: PalletJob[] = [];
    for (const result of boardResults) {
      if (result.status === "fulfilled") {
        allJobs.push(...result.value);
      }
    }

    span.addEvent("pallet.raw.fetched", { count: allJobs.length });

    const jobs: JobListing[] = [];
    for (const raw of allJobs) {
      if (jobs.length >= query.maxResults) break;

      const searchText = `${raw.title} ${raw.description ?? ""}`.toLowerCase();

      if (keywords.length > 0 && !keywords.some((kw) => searchText.includes(kw))) {
        continue;
      }

      if (query.remote && !raw.remote) continue;

      const job = this.toJobListing(raw);
      if (job) jobs.push(job);
    }

    span.addEvent("pallet.search.done", { jobs: jobs.length });

    return { jobs, toolCallCount, tokensUsed: 0 };
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async fetchBoard(
    board: string,
    span: SpanBuilder
  ): Promise<PalletJob[]> {
    const url = `https://api.pallet.com/api/v1/boards/${board}/jobs?page=1&per_page=100`;

    try {
      const data = await fetchJson<PalletResponse>(url);
      span.addEvent("pallet.board.fetched", {
        board,
        count: data.data?.length ?? 0,
      });
      return data.data ?? [];
    } catch (err) {
      // Non-fatal: board may not exist or slug may differ
      span.addEvent("pallet.board.error", {
        board,
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

  private toJobListing(raw: PalletJob): JobListing | null {
    const company = raw.company?.name?.trim();
    const title = raw.title?.trim();
    if (!title || !company) return null;

    const url = raw.url?.trim();
    if (!url) return null;

    const listing: JobListing = {
      id: `pallet_${nanoid(10)}`,
      source: "pallet",
      sourceId: raw.id,
      title,
      company,
      location: raw.location ?? "",
      remote: raw.remote ?? false,
      description: raw.description ?? "",
      requirements: [],
      url,
      scrapedAt: new Date().toISOString(),
      tags: raw.tags ?? [],
    };

    if (raw.created_at) {
      listing.postedAt = new Date(raw.created_at).toISOString();
    }

    if (raw.salary_min !== undefined || raw.salary_max !== undefined) {
      listing.salary = {
        min: raw.salary_min,
        max: raw.salary_max,
        currency: "USD",
        period: "yearly",
      };
    }

    return listing;
  }
}
