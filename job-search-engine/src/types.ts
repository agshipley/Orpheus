/**
 * Orpheus — Core Type Definitions
 *
 * Shared types that form the contract between all subsystems:
 * Conductor, Agents, MCP layer, Content generation, and Observability.
 */

import { z } from "zod";

// ─── Job Domain Types ─────────────────────────────────────────────

export const JobListingSchema = z.object({
  id: z.string(),
  source: z.enum(["linkedin", "indeed", "github", "ycombinator", "getro", "pallet", "custom"]),
  sourceId: z.string(),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  remote: z.boolean().optional(),
  salary: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      currency: z.string().default("USD"),
      period: z.enum(["yearly", "monthly", "hourly"]).default("yearly"),
    })
    .optional(),
  description: z.string(),
  requirements: z.array(z.string()).default([]),
  url: z.string().url(),
  postedAt: z.string().datetime().optional(),
  scrapedAt: z.string().datetime(),
  tags: z.array(z.string()).default([]),
  matchScore: z.number().min(0).max(1).optional(),
  matchReasoning: z.string().optional(),
});

export type JobListing = z.infer<typeof JobListingSchema>;

export const SearchQuerySchema = z.object({
  raw: z.string(),
  title: z.string().optional(),
  skills: z.array(z.string()).default([]),
  location: z.string().optional(),
  remote: z.boolean().optional(),
  salaryMin: z.number().optional(),
  salaryMax: z.number().optional(),
  experienceLevel: z
    .enum(["entry", "mid", "senior", "staff", "principal", "executive"])
    .optional(),
  industries: z.array(z.string()).default([]),
  excludeCompanies: z.array(z.string()).default([]),
  maxResults: z.number().default(50),
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

// ─── User Profile Types ───────────────────────────────────────────

export const UserProfileSchema = z.object({
  name: z.string(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  linkedin: z.string().optional(),
  github: z.string().optional(),
  website: z.string().optional(),
  location: z.string().optional(),
  resumePath: z.string().optional(),
  resumeText: z.string().optional(),
  summary: z.string().optional(),
  skills: z.array(z.string()).default([]),
  experience: z
    .array(
      z.object({
        title: z.string(),
        company: z.string(),
        startDate: z.string(),
        endDate: z.string().optional(),
        description: z.string(),
        highlights: z.array(z.string()).default([]),
      })
    )
    .default([]),
  education: z
    .array(
      z.object({
        institution: z.string(),
        degree: z.string(),
        field: z.string().optional(),
        graduationDate: z.string().optional(),
      })
    )
    .default([]),
  preferences: z.object({
    remote: z.boolean().default(true),
    salaryMin: z.number().optional(),
    locations: z.array(z.string()).default([]),
    industries: z.array(z.string()).default([]),
    companySize: z
      .enum(["startup", "mid", "large", "enterprise", "any"])
      .default("any"),
  }),
  targetTitles: z.array(z.string()).default([]),
  voice: z.object({
    tone: z.string(),
    avoidPhrases: z.array(z.string()).default([]),
    signaturePhrases: z.array(z.string()).default([]),
  }).optional(),
  positioningGuidance: z.string().optional(),
  projects: z.array(z.object({
    name: z.string(),
    description: z.string(),
    role: z.string().optional(),
  })).default([]),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

// ─── Agent Types ──────────────────────────────────────────────────

export type AgentSource =
  | "linkedin"
  | "indeed"
  | "github"
  | "ycombinator"
  | "getro"
  | "pallet"
  | "custom";

export interface AgentConfig {
  source: AgentSource;
  enabled: boolean;
  timeoutMs: number;
  maxRetries: number;
  rateLimitRpm: number;
  credentials?: Record<string, string>;
  customEndpoint?: string;
  /** Full user profile — passed through so agents can apply profile-aware filtering. */
  profile?: UserProfile;
}

export interface AgentResult {
  source: AgentSource;
  jobs: JobListing[];
  metadata: {
    queryTimeMs: number;
    toolCallCount: number;
    tokensUsed: number;
    errors: AgentError[];
    cached: boolean;
  };
}

export interface AgentError {
  code: string;
  message: string;
  retryable: boolean;
  timestamp: string;
}

// ─── Content Generation Types ─────────────────────────────────────

export interface ContentRequest {
  type: "resume" | "cover_letter" | "outreach_email" | "follow_up";
  job: JobListing;
  profile: UserProfile;
  tone?: "formal" | "conversational" | "enthusiastic" | "concise";
  emphasis?: string[];
  maxLength?: number;
  variants?: number;
}

export interface ContentResult {
  type: ContentRequest["type"];
  variants: ContentVariant[];
  metadata: {
    model: string;
    tokensUsed: number;
    generationTimeMs: number;
    costUsd: number;
  };
}

export interface ContentVariant {
  id: string;
  content: string;
  strategy: string;
  confidence: number;
}

// ─── MCP Protocol Types ──────────────────────────────────────────

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export interface MCPResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface MCPPromptDefinition {
  name: string;
  description: string;
  arguments: Array<{
    name: string;
    description: string;
    required: boolean;
  }>;
}

// ─── Observability Types ─────────────────────────────────────────

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: "ok" | "error" | "timeout";
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
  children: Span[];
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, string | number | boolean>;
}

export interface Metric {
  name: string;
  type: "counter" | "gauge" | "histogram";
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

export interface DecisionLogEntry {
  traceId: string;
  timestamp: string;
  component: string;
  decision: string;
  reasoning: string;
  inputs: Record<string, unknown>;
  output: unknown;
  alternatives?: Array<{
    option: string;
    score: number;
    reason: string;
  }>;
}

export interface CostEntry {
  traceId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  component: string;
  timestamp: string;
}

// ─── Configuration Types ─────────────────────────────────────────

export const ConfigSchema = z.object({
  profile: UserProfileSchema,
  agents: z.object({
    concurrency: z.number().default(5),
    timeoutMs: z.number().default(30000),
    sources: z.array(z.string()).default(["ycombinator"]),
  }),
  observability: z.object({
    traceSamplingRate: z.number().min(0).max(1).default(1.0),
    metricsExport: z
      .enum(["console", "prometheus", "otlp", "none"])
      .default("console"),
    decisionLogLevel: z
      .enum(["minimal", "standard", "detailed"])
      .default("standard"),
    costTracking: z.boolean().default(true),
  }),
  content: z.object({
    model: z.string().default("claude-sonnet-4-6"),
    temperature: z.number().default(0.7),
    maxVariants: z.number().default(3),
  }),
  storage: z.object({
    dbPath: z.string().default("./data/orpheus.db"),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
