/**
 * Orpheus — AI-Powered Job Search Engine
 *
 * Library entry point. Re-exports all public APIs for programmatic use.
 */

// Core orchestration
export { Conductor, type SearchResult } from "./conductor/index.js";

// Search agents
export {
  BaseAgent,
  LinkedInAgent,
  IndeedAgent,
  GitHubAgent,
  createAgent,
  createAgentPool,
} from "./agents/index.js";

// Content generation
export {
  ResumeTailor,
  CoverLetterGenerator,
  EmailDrafter,
} from "./content/index.js";

// MCP server
export { createJobBoardServer, type JobBoardAdapter } from "./mcp/server.js";

// Observability
export {
  Tracer,
  SpanBuilder,
  getTracer,
  MetricsCollector,
  getMetrics,
  DecisionLog,
  getDecisionLog,
} from "./observability/index.js";

// Storage
export { JobStore } from "./storage/index.js";

// Types
export type {
  Config,
  UserProfile,
  JobListing,
  SearchQuery,
  AgentConfig,
  AgentResult,
  AgentSource,
  ContentRequest,
  ContentResult,
  ContentVariant,
  Span,
  SpanEvent,
  Metric,
  DecisionLogEntry,
  CostEntry,
} from "./types.js";
