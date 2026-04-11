/**
 * HN Agent — Searches Hacker News "Who's Hiring" via MCP.
 *
 * Spawns the hn-jobs MCP server as a subprocess and queries it
 * with the standardized search_jobs tool. No API key required —
 * results come directly from the public HN Firebase API.
 */

import path from "path";
import { fileURLToPath } from "url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "./base_agent.js";
import { SpanBuilder } from "../observability/index.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";
import { nanoid } from "nanoid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve the MCP server path relative to this file at runtime
const SERVER_PATH = path.resolve(
  __dirname,
  "../../mcp-servers/hn-jobs/index.ts"
);

interface HNJobRaw {
  jobId: string;
  title: string;
  company: { name: string };
  location: string;
  remote?: boolean;
  description: string;
  skills?: string[];
  url: string;
  listedAt?: string;
}

export class HNAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "ycombinator",
      enabled: true,
      timeoutMs: 60000, // HN scraping can take a moment on first call
      maxRetries: 1,
      rateLimitRpm: 10,
      ...config,
    });
  }

  protected createTransport(): StdioClientTransport {
    return new StdioClientTransport({
      command: "npx",
      args: ["tsx", SERVER_PATH],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (e): e is [string, string] => e[1] !== undefined
        )
      ),
    });
  }

  protected async search(
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<{
    jobs: JobListing[];
    toolCallCount: number;
    tokensUsed: number;
  }> {
    span.addEvent("hn.search.start", { query: query.raw });

    const params: Record<string, unknown> = {
      keywords: query.title || query.raw,
      limit: Math.min(query.maxResults, 50),
    };

    if (query.remote) params.remoteFilter = "remote";
    if (query.location) params.location = query.location;

    const rawResults = await this.callTool<{
      jobs: HNJobRaw[];
      total: number;
    }>("search_jobs", params, span);

    span.addEvent("hn.search.results", {
      count: rawResults.jobs.length,
      total: rawResults.total,
    });

    const jobs = rawResults.jobs.map((raw) => this.normalize(raw));

    // Apply skill filter client-side if requested
    let filtered = jobs;
    if (query.skills.length > 0) {
      filtered = jobs.filter((job) => {
        const text = job.description.toLowerCase();
        return query.skills.some((s) => text.includes(s.toLowerCase()));
      });
      span.addEvent("hn.search.skill_filtered", {
        before: jobs.length,
        after: filtered.length,
      });
    }

    return { jobs: filtered, toolCallCount: 1, tokensUsed: 0 };
  }

  private normalize(raw: HNJobRaw): JobListing {
    let url = raw.url;
    try {
      new URL(url);
    } catch {
      url = `https://news.ycombinator.com/item?id=${raw.jobId}`;
    }

    return {
      id: `hn_${nanoid(10)}`,
      source: "ycombinator",
      sourceId: raw.jobId,
      title: raw.title,
      company: raw.company.name,
      location: raw.location,
      remote: raw.remote,
      description: raw.description,
      requirements: raw.skills ?? [],
      url,
      postedAt: raw.listedAt,
      scrapedAt: new Date().toISOString(),
      tags: raw.skills ?? [],
    };
  }
}
