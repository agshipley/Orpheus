/**
 * GitHub Agent — Searches GitHub-adjacent job sources via MCP.
 *
 * Covers GitHub Jobs (via third-party APIs), HN Who's Hiring,
 * and other developer-focused job boards.
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "./base_agent.js";
import { SpanBuilder } from "../observability/index.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";
import { nanoid } from "nanoid";

interface GitHubJobRaw {
  id: string;
  title: string;
  company: string;
  location: string;
  type: string;
  description: string;
  how_to_apply: string;
  url: string;
  created_at: string;
  company_url?: string;
}

export class GitHubAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "github",
      enabled: true,
      timeoutMs: 20000,
      maxRetries: 1,
      rateLimitRpm: 60,
      ...config,
    });
  }

  protected createTransport(): StdioClientTransport {
    return new StdioClientTransport({
      command: "node",
      args: ["./mcp-servers/github-jobs/index.js"],
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
    // GitHub Jobs searches are simpler — keyword + location
    const searchParams = {
      description: query.title || query.raw,
      location: query.location ?? "",
      full_time: true,
    };

    span.addEvent("github.search.start", { query: searchParams.description });

    const rawResults = await this.callTool<GitHubJobRaw[]>(
      "search_jobs",
      searchParams,
      span
    );

    span.addEvent("github.search.results", { count: rawResults.length });

    const jobs = rawResults.map((raw) => this.normalize(raw));

    return { jobs, toolCallCount: 1, tokensUsed: 0 };
  }

  private normalize(raw: GitHubJobRaw): JobListing {
    const isRemote =
      raw.location.toLowerCase().includes("remote") ||
      raw.type.toLowerCase().includes("remote");

    return {
      id: `gh_${nanoid(10)}`,
      source: "github",
      sourceId: raw.id,
      title: raw.title,
      company: raw.company,
      location: raw.location,
      remote: isRemote,
      description: raw.description,
      requirements: [],
      url: raw.url || raw.company_url || "",
      postedAt: raw.created_at,
      scrapedAt: new Date().toISOString(),
      tags: [],
    };
  }
}
