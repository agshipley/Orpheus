/**
 * BaseAgent — Abstract agent with MCP client session management.
 *
 * Each agent wraps an MCP client that connects to a source-specific
 * MCP server. The base class handles:
 *  - Connection lifecycle (connect, reconnect, disconnect)
 *  - Tool call routing with automatic tracing
 *  - Retry logic with exponential backoff
 *  - Error classification (retryable vs fatal)
 *  - Metrics emission per tool call
 *
 * Concrete agents (LinkedInAgent, IndeedAgent, etc.) implement
 * the abstract `search()` and `getDetail()` methods.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getTracer, getMetrics, SpanBuilder } from "../observability/index.js";
import type {
  AgentConfig,
  AgentResult,
  AgentError,
  JobListing,
  SearchQuery,
} from "../types.js";

export abstract class BaseAgent {
  protected client: Client;
  protected config: AgentConfig;
  protected connected = false;
  private tracer = getTracer();
  private metrics = getMetrics();

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = new Client(
      { name: `orpheus-${config.source}`, version: "0.1.0" },
      { capabilities: {} }
    );
  }

  /**
   * Connect to the MCP server for this agent's source.
   * Each concrete agent provides its own transport configuration.
   */
  async connect(): Promise<void> {
    const span = this.tracer.startTrace(`agent.${this.config.source}.connect`);

    try {
      const transport = this.createTransport();
      await this.client.connect(transport);
      this.connected = true;
      span.setAttribute("status", "connected");
      span.end();
    } catch (error) {
      span.setError(error instanceof Error ? error.message : String(error));
      span.end();
      throw error;
    }
  }

  /**
   * Execute a search across this agent's source.
   * Automatically wrapped in tracing and metrics.
   * Auto-connects if not already connected.
   */
  async executeSearch(
    query: SearchQuery,
    parentSpan?: SpanBuilder
  ): Promise<AgentResult> {
    if (!this.connected) {
      await this.connect();
    }

    const span = parentSpan
      ? parentSpan.startChild(`agent.${this.config.source}.search`)
      : this.tracer.startTrace(`agent.${this.config.source}.search`);

    span.setAttributes({
      "agent.source": this.config.source,
      "query.raw": query.raw,
      "query.location": query.location ?? "any",
      "query.remote": query.remote ?? false,
    });

    const startTime = performance.now();
    const errors: AgentError[] = [];
    let jobs: JobListing[] = [];
    let toolCallCount = 0;
    let tokensUsed = 0;

    try {
      const result = await this.withRetry(
        () => this.search(query, span),
        this.config.maxRetries
      );

      jobs = result.jobs;
      toolCallCount = result.toolCallCount;
      tokensUsed = result.tokensUsed;

      span.setAttributes({
        "results.count": jobs.length,
        "tool_calls": toolCallCount,
        "tokens_used": tokensUsed,
      });
    } catch (error) {
      const agentError = this.classifyError(error);
      errors.push(agentError);
      span.setError(agentError.message);

      this.metrics.increment("orpheus_agent_errors_total", {
        source: this.config.source,
        code: agentError.code,
      });
    }

    const durationMs = Math.round(performance.now() - startTime);
    span.setAttribute("duration_ms", durationMs);
    span.end();

    // Emit metrics
    this.metrics.increment("orpheus_agent_calls_total", {
      source: this.config.source,
    });
    this.metrics.observe("orpheus_agent_latency_ms", durationMs, {
      source: this.config.source,
    });
    this.metrics.increment("orpheus_jobs_found_total", {
      source: this.config.source,
    }, jobs.length);
    this.metrics.increment("orpheus_tool_calls_total", {
      source: this.config.source,
    }, toolCallCount);

    // Disconnect after each search — agents are created fresh per conductor call
    await this.disconnect();

    return {
      source: this.config.source,
      jobs,
      metadata: {
        queryTimeMs: durationMs,
        toolCallCount,
        tokensUsed,
        errors,
        cached: false,
      },
    };
  }

  /**
   * Call an MCP tool with automatic tracing.
   */
  protected async callTool<T>(
    toolName: string,
    args: Record<string, unknown>,
    parentSpan: SpanBuilder
  ): Promise<T> {
    const span = parentSpan.startChild(`mcp.tool.${toolName}`);
    span.setAttributes({
      "tool.name": toolName,
      "tool.source": this.config.source,
    });

    try {
      const result = await this.client.callTool({
        name: toolName,
        arguments: args,
      });

      span.setAttribute("tool.success", true);
      span.end();

      this.metrics.increment("orpheus_tool_calls_total", {
        source: this.config.source,
        tool: toolName,
      });

      // Parse the tool result content
      const content = result.content as Array<{ type: string; text?: string }>;
      const textContent = content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");

      return JSON.parse(textContent) as T;
    } catch (error) {
      span.setError(error instanceof Error ? error.message : String(error));
      span.end();
      throw error;
    }
  }

  /**
   * Disconnect from the MCP server.
   */
  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  // ─── Abstract Methods ───────────────────────────────────────────

  /**
   * Create the transport for connecting to this agent's MCP server.
   */
  protected abstract createTransport(): StdioClientTransport;

  /**
   * Execute a search against this source. Implemented by each concrete agent.
   */
  protected abstract search(
    query: SearchQuery,
    span: SpanBuilder
  ): Promise<{
    jobs: JobListing[];
    toolCallCount: number;
    tokensUsed: number;
  }>;

  // ─── Private Helpers ────────────────────────────────────────────

  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const agentError = this.classifyError(error);

        if (!agentError.retryable || attempt === maxRetries) {
          throw lastError;
        }

        // Exponential backoff: 1s, 2s, 4s, 8s...
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  private classifyError(error: unknown): AgentError {
    const message =
      error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();

    // Rate limiting
    if (message.includes("429") || message.includes("rate limit")) {
      return {
        code: "RATE_LIMITED",
        message,
        retryable: true,
        timestamp: now,
      };
    }

    // Network errors
    if (
      message.includes("ECONNREFUSED") ||
      message.includes("ETIMEDOUT") ||
      message.includes("fetch failed")
    ) {
      return {
        code: "NETWORK_ERROR",
        message,
        retryable: true,
        timestamp: now,
      };
    }

    // Auth errors
    if (message.includes("401") || message.includes("403")) {
      return {
        code: "AUTH_ERROR",
        message,
        retryable: false,
        timestamp: now,
      };
    }

    // Server errors
    if (message.includes("500") || message.includes("502") || message.includes("503")) {
      return {
        code: "SERVER_ERROR",
        message,
        retryable: true,
        timestamp: now,
      };
    }

    return {
      code: "UNKNOWN",
      message,
      retryable: false,
      timestamp: now,
    };
  }
}
