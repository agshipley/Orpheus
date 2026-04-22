/**
 * OperatorCommunitiesAgent — Fetches operator-track roles from community job boards.
 *
 * Targets Chief of Staff Network, Operators Guild, On Deck, and First Round
 * Capital's talent network. These boards are Pallet-backed or have their own
 * JSON endpoints. Falls back gracefully on 403 / 404 / auth-gated boards.
 *
 * No title filter — these boards are already operator-targeted by design.
 *
 * Per-fetch timeout: 10s. Per-agent ceiling: 20s.
 */

import pLimit from "p-limit";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "./base_agent.js";
import {
  fetchJsonCached,
  fetchGreenhouseJobs,
  parseGreenhouseJob,
  withAgentTimeout,
} from "./fetch_utils.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";
import type { SpanBuilder } from "../observability/index.js";
import { nanoid } from "nanoid";

// ─── Pallet job shape ─────────────────────────────────────────────

interface PalletJob {
  id?: string | number;
  title?: string;
  position?: string;
  company?: string | { name?: string };
  organization?: string | { name?: string };
  location?: string;
  remote?: boolean;
  url?: string;
  apply_url?: string;
  job_url?: string;
  description?: string;
  created_at?: string;
  published_at?: string;
}

// ─── Board registry ───────────────────────────────────────────────

type BoardType = "pallet" | "greenhouse";

interface BoardEntry {
  name: string;
  type: BoardType;
  /** For pallet: JSON API URL(s) to attempt */
  urls?: string[];
  /** For greenhouse: slug */
  slug?: string;
}

const BOARDS: BoardEntry[] = [
  {
    name: "Chief of Staff Network",
    type: "pallet",
    urls: [
      "https://chiefofstaffnetwork.com/api/jobs",
      "https://chiefofstaffnetwork.com/jobs.json",
      "https://jobs.chiefofstaffnetwork.com/api/jobs",
    ],
  },
  {
    name: "Operators Guild",
    type: "pallet",
    urls: [
      "https://www.operatorsguild.org/api/jobs",
      "https://jobs.operatorsguild.org/api/jobs",
    ],
  },
  {
    name: "On Deck",
    type: "pallet",
    urls: [
      "https://beondeck.com/api/jobs",
      "https://jobs.beondeck.com/api/jobs",
    ],
  },
  {
    // First Round Capital's talent network uses Greenhouse internally
    name: "First Round Capital",
    type: "greenhouse",
    slug: "firstround",
  },
];

// ─── Agent ────────────────────────────────────────────────────────

export class OperatorCommunitiesAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "operator_communities",
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
    throw new Error("OperatorCommunitiesAgent does not use MCP");
  }

  protected async search(
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<{ jobs: JobListing[]; toolCallCount: number; tokensUsed: number }> {
    span.addEvent("operator_communities.search.start", { query: query.raw });

    const limit = pLimit(3);
    let toolCallCount = 0;

    const results = await Promise.allSettled(
      BOARDS.map((board) =>
        limit(async () => {
          toolCallCount++;
          try {
            const jobs = await withAgentTimeout(this.fetchBoard(board), board.name);
            span.addEvent("operator_communities.source.ok", { board: board.name, count: jobs.length });
            return jobs;
          } catch (err) {
            span.addEvent("operator_communities.source.error", {
              board: board.name,
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
    span.addEvent("operator_communities.search.done", { raw: jobs.length, filtered: filtered.length });

    return { jobs: filtered.slice(0, query.maxResults), toolCallCount, tokensUsed: 0 };
  }

  private async fetchBoard(board: BoardEntry): Promise<JobListing[]> {
    if (board.type === "greenhouse" && board.slug) {
      const raw = await fetchGreenhouseJobs(board.slug);
      return raw
        .map((j) => parseGreenhouseJob(j, board.name, "operator_communities", false))
        .filter((j): j is JobListing => j !== null);
    }

    // Pallet: try each URL until one succeeds
    for (const url of board.urls ?? []) {
      try {
        const data = await fetchJsonCached<PalletJob[] | { jobs: PalletJob[] }>(url);
        const raw = Array.isArray(data) ? data : data.jobs ?? [];
        return raw
          .map((j) => this.parsePalletJob(j, board.name))
          .filter((j): j is JobListing => j !== null);
      } catch {
        // try next URL
      }
    }
    return [];
  }

  parsePalletJob(j: PalletJob, boardName: string): JobListing | null {
    const title = j.title ?? j.position;
    const companyRaw = j.company ?? j.organization;
    const company =
      typeof companyRaw === "string"
        ? companyRaw
        : companyRaw?.name ?? boardName;
    const url = j.url ?? j.apply_url ?? j.job_url ?? "";

    if (!title || !url) return null;

    const location = j.location ?? "";
    const remote = j.remote ?? /remote/i.test(location);

    return {
      id: `operator_communities_pl_${nanoid(10)}`,
      source: "operator_communities",
      sourceId: String(j.id ?? nanoid(6)),
      title,
      company,
      location: remote ? "" : location,
      remote,
      description: j.description ?? `${title} at ${company}`,
      requirements: [],
      url,
      postedAt: j.created_at ?? j.published_at,
      scrapedAt: new Date().toISOString(),
      tags: [],
    };
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
