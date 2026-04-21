/**
 * Conductor — The orchestration brain of Orpheus.
 *
 * Responsibilities:
 * 1. Parse natural language queries into structured SearchQuery objects
 * 2. Fan out search to N agents in parallel (bounded concurrency)
 * 3. Merge, deduplicate, and rank results
 * 4. Coordinate content generation for selected jobs
 * 5. Maintain the full trace of every operation
 *
 * The Conductor never calls LLMs directly for search — that's the
 * agents' job. It DOES use LLMs for query planning and result ranking.
 */

import Anthropic from "@anthropic-ai/sdk";
import pLimit from "p-limit";
import { getTracer, getMetrics, getDecisionLog } from "../observability/index.js";
import { createAgentPool } from "../agents/index.js";
import type { BaseAgent } from "../agents/base_agent.js";
import type {
  Config,
  SearchQuery,
  JobListing,
  AgentResult,
  AgentSource,
  AgentConfig,
  UserProfile,
} from "../types.js";

export type AgentFactory = (
  sources: AgentSource[],
  config?: Partial<AgentConfig>
) => BaseAgent[];

export interface SearchResult {
  traceId: string;
  query: SearchQuery;
  jobs: JobListing[];
  agentResults: AgentResult[];
  stats: {
    totalFound: number;
    afterDedup: number;
    durationMs: number;
    agentsQueried: number;
    agentsSucceeded: number;
    totalTokensUsed: number;
    estimatedCostUsd: number;
  };
}

export class Conductor {
  private client: Anthropic;
  private config: Config;
  private agentFactory: AgentFactory;
  private tracer = getTracer();
  private metrics = getMetrics();
  private decisionLog = getDecisionLog();

  constructor(config: Config, agentFactory: AgentFactory = createAgentPool) {
    this.config = config;
    this.client = new Anthropic();
    this.agentFactory = agentFactory;
  }

  /**
   * Execute a full search pipeline:
   * parse → fan-out → merge → rank → return
   */
  async search(rawQuery: string): Promise<SearchResult> {
    const rootSpan = this.tracer.startTrace("conductor.search");
    rootSpan.setAttribute("query.raw", rawQuery);

    const startTime = performance.now();

    try {
      // ── Step 1: Parse the natural language query ──────────────
      const query = await this.tracer.traced(
        "conductor.parse_query",
        rootSpan,
        async (span) => {
          const parsed = await this.parseQuery(rawQuery);
          span.setAttributes({
            "query.title": parsed.title ?? "none",
            "query.skills": parsed.skills.join(", "),
            "query.location": parsed.location ?? "any",
            "query.remote": parsed.remote ?? false,
          });
          return parsed;
        }
      );

      // ── Step 2: Fan out to agents in parallel ─────────────────
      const agentResults = await this.tracer.traced(
        "conductor.fan_out",
        rootSpan,
        async (span) => {
          const sources = this.config.agents.sources as AgentSource[];
          span.setAttribute("agents.count", sources.length);
          return this.fanOutSearch(query, sources, span, this.config.profile);
        }
      );

      // ── Step 3: Merge and deduplicate ─────────────────────────
      const mergedJobs = await this.tracer.traced(
        "conductor.merge",
        rootSpan,
        async (span) => {
          const allJobs = agentResults.flatMap((r) => r.jobs);
          span.setAttribute("jobs.before_dedup", allJobs.length);

          const deduped = this.deduplicate(allJobs);
          span.setAttribute("jobs.after_dedup", deduped.length);

          this.metrics.increment(
            "orpheus_jobs_deduplicated_total",
            {},
            allJobs.length - deduped.length
          );

          return deduped;
        }
      );

      // ── Step 4: Rank results ──────────────────────────────────
      const rankedJobs = await this.tracer.traced(
        "conductor.rank",
        rootSpan,
        async (span) => {
          const ranked = await this.rankJobs(mergedJobs, query);
          span.setAttribute("jobs.ranked", ranked.length);
          return ranked;
        }
      );

      const durationMs = Math.round(performance.now() - startTime);
      rootSpan.setAttribute("duration_ms", durationMs);
      rootSpan.end();

      // ── Emit final metrics ────────────────────────────────────
      this.metrics.increment("orpheus_searches_total");
      this.metrics.observe("orpheus_search_latency_ms", durationMs);

      const totalTokens = agentResults.reduce(
        (sum, r) => sum + r.metadata.tokensUsed,
        0
      );

      return {
        traceId: rootSpan.traceId,
        query,
        jobs: rankedJobs,
        agentResults,
        stats: {
          totalFound: agentResults.reduce((sum, r) => sum + r.jobs.length, 0),
          afterDedup: rankedJobs.length,
          durationMs,
          agentsQueried: agentResults.length,
          agentsSucceeded: agentResults.filter(
            (r) => r.metadata.errors.length === 0
          ).length,
          totalTokensUsed: totalTokens,
          estimatedCostUsd: this.estimateCost(totalTokens),
        },
      };
    } catch (error) {
      rootSpan.setError(error instanceof Error ? error.message : String(error));
      rootSpan.end();
      throw error;
    }
  }

  // ─── Query Parsing ──────────────────────────────────────────────

  private async parseQuery(rawQuery: string): Promise<SearchQuery> {
    const response = await this.client.messages.create({
      model: this.config.content.model,
      max_tokens: 1000,
      system: `You are a query parser for a job search engine. Extract structured search parameters from natural language queries. Respond with JSON only, no markdown fences.

Schema:
{
  "raw": string,       // original query
  "title": string?,    // job title/role
  "skills": string[],  // required skills
  "location": string?, // location preference
  "remote": boolean?,  // remote preference
  "salaryMin": number?, // minimum salary
  "experienceLevel": "entry"|"mid"|"senior"|"staff"|"principal"|"executive"?,
  "industries": string[],
  "excludeCompanies": string[],
  "maxResults": number  // default 50
}`,
      messages: [
        {
          role: "user",
          content: rawQuery,
        },
      ],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    parsed.raw = rawQuery;

    this.decisionLog.logDecision({
      traceId: "parse",
      component: "conductor.query_parser",
      decision: "Parsed natural language query",
      reasoning: `Extracted structured query from: "${rawQuery}"`,
      inputs: { rawQuery },
      output: parsed,
    });

    // Track token usage
    this.metrics.increment(
      "orpheus_llm_tokens_total",
      { component: "query_parser" },
      (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0)
    );

    this.decisionLog.logCost({
      traceId: "parse",
      model: this.config.content.model,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      costUsd: this.estimateCost(
        (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0)
      ),
      component: "conductor.query_parser",
      timestamp: new Date().toISOString(),
    });

    return parsed as SearchQuery;
  }

  // ─── Parallel Fan-Out ───────────────────────────────────────────

  private async fanOutSearch(
    query: SearchQuery,
    sources: AgentSource[],
    parentSpan: ReturnType<typeof this.tracer.startTrace>,
    profile?: UserProfile
  ): Promise<AgentResult[]> {
    const limit = pLimit(this.config.agents.concurrency);
    const agents = this.agentFactory(sources, profile ? { profile } : undefined);

    console.log(`[conductor] fanOutSearch: sources=${sources.join(", ")} agents=${agents.length}`);

    const promises = agents.map((agent) =>
      limit(async () => {
        const agentSource = (agent as unknown as { config: { source: AgentSource } }).config.source;
        try {
          // Each agent gets its own child span
          const result = await agent.executeSearch(query, parentSpan);
          console.log(`[conductor] agent=${agentSource} jobs=${result.jobs.length} errors=${result.metadata.errors.length > 0 ? JSON.stringify(result.metadata.errors) : "none"}`);
          return result;
        } catch (error) {
          // Agent failures are non-fatal — return empty result
          const source = agentSource;
          console.log(`[conductor] agent=${source} FAILED: ${error instanceof Error ? error.message : String(error)}`);

          this.decisionLog.logDecision({
            traceId: parentSpan.traceId,
            component: `agent.${source}`,
            decision: "Agent search failed — continuing with other agents",
            reasoning: error instanceof Error ? error.message : String(error),
            inputs: { query: query.raw, source },
            output: null,
          });

          return {
            source,
            jobs: [],
            metadata: {
              queryTimeMs: 0,
              toolCallCount: 0,
              tokensUsed: 0,
              errors: [
                {
                  code: "AGENT_FAILURE",
                  message: error instanceof Error ? error.message : String(error),
                  retryable: false,
                  timestamp: new Date().toISOString(),
                },
              ],
              cached: false,
            },
          } satisfies AgentResult;
        }
      })
    );

    // Wait for all agents (with timeout)
    const results = await Promise.allSettled(promises);

    return results
      .filter(
        (r): r is PromiseFulfilledResult<AgentResult> => r.status === "fulfilled"
      )
      .map((r) => r.value);
  }

  // ─── Deduplication ──────────────────────────────────────────────

  private deduplicate(jobs: JobListing[]): JobListing[] {
    const seen = new Map<string, JobListing>();

    for (const job of jobs) {
      // Build a dedup key from normalized title + company
      const key = this.dedupKey(job);

      if (!seen.has(key)) {
        seen.set(key, job);
      } else {
        // Keep the one with more data (longer description, has salary, etc.)
        const existing = seen.get(key)!;
        if (this.dataRichness(job) > this.dataRichness(existing)) {
          seen.set(key, job);
        }
      }
    }

    return Array.from(seen.values());
  }

  private dedupKey(job: JobListing): string {
    const title = job.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    const company = job.company.toLowerCase().replace(/[^a-z0-9]/g, "");
    return `${title}::${company}`;
  }

  private dataRichness(job: JobListing): number {
    let score = 0;
    score += job.description.length > 200 ? 2 : 0;
    score += job.salary ? 3 : 0;
    score += job.requirements.length > 0 ? 1 : 0;
    score += job.remote !== undefined ? 1 : 0;
    score += job.postedAt ? 1 : 0;
    return score;
  }

  // ─── Ranking ────────────────────────────────────────────────────

  private async rankJobs(
    jobs: JobListing[],
    query: SearchQuery
  ): Promise<JobListing[]> {
    if (jobs.length === 0) return [];

    // For small result sets, use heuristic ranking (no LLM call needed)
    if (jobs.length <= 10) {
      return this.heuristicRank(jobs, query);
    }

    // For larger sets, use LLM-assisted ranking on the top candidates
    // First, heuristic rank to get top 20, then LLM-refine
    const heuristicRanked = this.heuristicRank(jobs, query);
    const topCandidates = heuristicRanked.slice(0, 20);
    const rest = heuristicRanked.slice(20);

    try {
      const response = await this.client.messages.create({
        model: this.config.content.model,
        max_tokens: 2000,
        system: `You are a job ranking assistant. Given a search query and a list of jobs, rank them by relevance. Consider: skill match, salary alignment, location preference, company quality, and role seniority match. Return a JSON array of job IDs in order of best match. JSON only, no fences.`,
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              query: {
                title: query.title,
                skills: query.skills,
                location: query.location,
                remote: query.remote,
                salaryMin: query.salaryMin,
                level: query.experienceLevel,
              },
              jobs: topCandidates.map((j) => ({
                id: j.id,
                title: j.title,
                company: j.company,
                location: j.location,
                remote: j.remote,
                salary: j.salary,
                skills: j.requirements.slice(0, 10),
              })),
            }),
          },
        ],
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const rankedIds: string[] = JSON.parse(
        text.replace(/```json|```/g, "").trim()
      );

      // Reorder top candidates by LLM ranking
      const idToJob = new Map(topCandidates.map((j) => [j.id, j]));
      const reranked = rankedIds
        .map((id) => idToJob.get(id))
        .filter((j): j is JobListing => j !== undefined);

      // Add any that the LLM missed
      const rerankedIds = new Set(reranked.map((j) => j.id));
      for (const job of topCandidates) {
        if (!rerankedIds.has(job.id)) {
          reranked.push(job);
        }
      }

      this.decisionLog.logDecision({
        traceId: "rank",
        component: "conductor.ranker",
        decision: "LLM-assisted ranking of top candidates",
        reasoning: `Reranked ${topCandidates.length} candidates using ${this.config.content.model}`,
        inputs: { candidateCount: topCandidates.length },
        output: { topJob: reranked[0]?.title ?? "none" },
      });

      return [...reranked, ...rest];
    } catch {
      // Fallback to heuristic if LLM ranking fails
      return heuristicRanked;
    }
  }

  private heuristicRank(jobs: JobListing[], query: SearchQuery): JobListing[] {
    const profile = this.config.profile;
    return [...jobs].sort((a, b) => {
      const scoreA = this.heuristicScore(a, query, profile);
      const scoreB = this.heuristicScore(b, query, profile);
      return scoreB - scoreA;
    });
  }

  private heuristicScore(
    job: JobListing,
    query: SearchQuery,
    profile: UserProfile
  ): number {
    let score = 0;

    // ── Dominant signal: profile target title match (+60) ──────────
    // Any phrase from targetTitles found in the job title → strong boost.
    // This is the highest-weighted single signal so profile-aligned roles
    // always surface above keyword-matched-but-wrong-level results.
    if ((profile.targetTitles ?? []).length > 0) {
      const jobTitleLower = job.title.toLowerCase();
      const matches = (profile.targetTitles ?? []).some((t) =>
        jobTitleLower.includes(t.toLowerCase())
      );
      if (matches) score += 60;
    }

    // ── Skill match (up to 40) ─────────────────────────────────────
    if (query.skills.length > 0) {
      const descLower = job.description.toLowerCase();
      const matchCount = query.skills.filter((s) =>
        descLower.includes(s.toLowerCase())
      ).length;
      score += (matchCount / query.skills.length) * 40;
    }

    // ── Query title match (up to 30) ──────────────────────────────
    if (query.title) {
      const titleWords = query.title.toLowerCase().split(/\s+/);
      const jobTitleLower = job.title.toLowerCase();
      const titleMatch = titleWords.filter((w) =>
        jobTitleLower.includes(w)
      ).length;
      score += (titleMatch / titleWords.length) * 30;
    }

    // ── Salary match ───────────────────────────────────────────────
    if (query.salaryMin && job.salary?.min) {
      if (job.salary.min >= query.salaryMin) {
        score += 15;
      } else if (job.salary.min >= query.salaryMin * 0.9) {
        score += 8;
      }
    }

    // ── Remote preference ─────────────────────────────────────────
    if (query.remote && job.remote) {
      score += 10;
    }

    // ── Recency bonus ──────────────────────────────────────────────
    if (job.postedAt) {
      const daysAgo =
        (Date.now() - new Date(job.postedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysAgo < 3) score += 5;
      else if (daysAgo < 7) score += 3;
      else if (daysAgo < 14) score += 1;
    }

    return score;
  }

  private estimateCost(tokens: number): number {
    // Approximate cost for Claude Sonnet
    return (tokens / 1_000_000) * 3.0;
  }
}
