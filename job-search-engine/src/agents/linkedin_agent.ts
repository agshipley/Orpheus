/**
 * LinkedIn Agent — Searches LinkedIn Jobs via MCP server.
 *
 * Connects to a LinkedIn MCP server that wraps the LinkedIn Jobs API
 * (or a scraper endpoint). Translates Orpheus SearchQuery into
 * LinkedIn-specific parameters and normalizes results back.
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BaseAgent } from "./base_agent.js";
import { SpanBuilder } from "../observability/index.js";
import type { AgentConfig, JobListing, SearchQuery } from "../types.js";
import { nanoid } from "nanoid";

interface LinkedInJobRaw {
  jobId: string;
  title: string;
  company: { name: string };
  location: string;
  remote?: boolean;
  salary?: { min?: number; max?: number; currency?: string };
  description: string;
  skills?: string[];
  url: string;
  listedAt?: string;
}

export class LinkedInAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      source: "linkedin",
      enabled: true,
      timeoutMs: 30000,
      maxRetries: 2,
      rateLimitRpm: 30,
      ...config,
    });
  }

  protected createTransport(): StdioClientTransport {
    return new StdioClientTransport({
      command: "node",
      args: ["./mcp-servers/linkedin/index.js"],
      env: {
        ...process.env,
        LINKEDIN_API_KEY: this.config.credentials?.apiKey ?? "",
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
    span.addEvent("linkedin.search.start", {
      query: query.raw,
      location: query.location ?? "any",
    });

    // Build LinkedIn-specific search parameters
    const searchParams = this.buildSearchParams(query);

    span.addEvent("linkedin.search.params_built", {
      keywords: searchParams.keywords,
      locationId: searchParams.locationId ?? "none",
    });

    // Call the MCP search_jobs tool
    const rawResults = await this.callTool<{ jobs: LinkedInJobRaw[]; total: number }>(
      "search_jobs",
      searchParams,
      span
    );

    span.addEvent("linkedin.search.raw_results", {
      count: rawResults.jobs.length,
      total: rawResults.total,
    });

    // Normalize to Orpheus JobListing format
    const jobs = rawResults.jobs.map((raw) => this.normalize(raw));

    // If we have specific skill requirements, do a relevance filter
    let filteredJobs = jobs;
    if (query.skills.length > 0) {
      filteredJobs = jobs.filter((job) => {
        const descLower = job.description.toLowerCase();
        return query.skills.some((skill) =>
          descLower.includes(skill.toLowerCase())
        );
      });

      span.addEvent("linkedin.search.filtered", {
        before: jobs.length,
        after: filteredJobs.length,
        skills: query.skills.join(", "),
      });
    }

    return {
      jobs: filteredJobs,
      toolCallCount: 1,
      tokensUsed: 0, // No LLM calls in this agent
    };
  }

  private buildSearchParams(
    query: SearchQuery
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {
      keywords: query.title || query.raw,
      limit: Math.min(query.maxResults, 50),
    };

    if (query.location) {
      params.location = query.location;
    }
    if (query.remote) {
      params.remoteFilter = "remote";
    }
    if (query.experienceLevel) {
      params.experienceLevel = this.mapExperienceLevel(query.experienceLevel);
    }
    if (query.salaryMin) {
      params.salary = query.salaryMin;
    }

    return params;
  }

  private normalize(raw: LinkedInJobRaw): JobListing {
    return {
      id: `li_${nanoid(10)}`,
      source: "linkedin",
      sourceId: raw.jobId,
      title: raw.title,
      company: raw.company.name,
      location: raw.location,
      remote: raw.remote,
      salary: raw.salary
        ? {
            min: raw.salary.min,
            max: raw.salary.max,
            currency: raw.salary.currency ?? "USD",
            period: "yearly",
          }
        : undefined,
      description: raw.description,
      requirements: raw.skills ?? [],
      url: raw.url,
      postedAt: raw.listedAt,
      scrapedAt: new Date().toISOString(),
      tags: raw.skills ?? [],
    };
  }

  private mapExperienceLevel(
    level: string
  ): string {
    const map: Record<string, string> = {
      entry: "1",
      mid: "2",
      senior: "3",
      staff: "4",
      principal: "4",
      executive: "5",
    };
    return map[level] ?? "2";
  }
}
