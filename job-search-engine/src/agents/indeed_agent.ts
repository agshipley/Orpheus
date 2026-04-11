/**
 * Indeed Agent — Searches Indeed Jobs via MCP server.
 *
 * Similar structure to LinkedIn agent but with Indeed-specific
 * parameter mapping and result normalization.
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "./base_agent.js";
import { SpanBuilder } from "../observability/index.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";
import { nanoid } from "nanoid";

interface IndeedJobRaw {
  jobkey: string;
  jobtitle: string;
  company: string;
  formattedLocation: string;
  remoteWorkModel?: string;
  estimatedSalary?: { min: number; max: number; type: string };
  snippet: string;
  url: string;
  date: string;
}

export class IndeedAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "indeed",
      enabled: true,
      timeoutMs: 25000,
      maxRetries: 2,
      rateLimitRpm: 20,
      ...config,
    });
  }

  protected createTransport(): StdioClientTransport {
    return new StdioClientTransport({
      command: "node",
      args: ["./mcp-servers/indeed/index.js"],
      env: {
        ...process.env,
        INDEED_PUBLISHER_ID: this.config.credentials?.publisherId ?? "",
      },
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
    const searchParams = {
      q: query.title || query.raw,
      l: query.location ?? "",
      remotejob: query.remote ? "1" : undefined,
      salary: query.salaryMin?.toString(),
      limit: Math.min(query.maxResults, 25),
      sort: "relevance",
      fromage: 14, // last 14 days
    };

    span.addEvent("indeed.search.start", {
      query: searchParams.q,
      location: searchParams.l,
    });

    const rawResults = await this.callTool<{
      results: IndeedJobRaw[];
      totalResults: number;
    }>("search_jobs", searchParams, span);

    span.addEvent("indeed.search.results", {
      count: rawResults.results.length,
      total: rawResults.totalResults,
    });

    const jobs = rawResults.results.map((raw) => this.normalize(raw));

    return {
      jobs,
      toolCallCount: 1,
      tokensUsed: 0,
    };
  }

  private normalize(raw: IndeedJobRaw): JobListing {
    return {
      id: `in_${nanoid(10)}`,
      source: "indeed",
      sourceId: raw.jobkey,
      title: raw.jobtitle,
      company: raw.company,
      location: raw.formattedLocation,
      remote: raw.remoteWorkModel === "REMOTE",
      salary: raw.estimatedSalary
        ? {
            min: raw.estimatedSalary.min,
            max: raw.estimatedSalary.max,
            currency: "USD",
            period: raw.estimatedSalary.type === "YEARLY" ? "yearly" : "hourly",
          }
        : undefined,
      description: raw.snippet,
      requirements: [],
      url: raw.url,
      postedAt: raw.date,
      scrapedAt: new Date().toISOString(),
      tags: [],
    };
  }
}
