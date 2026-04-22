// ─── Job types ────────────────────────────────────────────────────

export interface Salary {
  min?: number;
  max?: number;
  currency: string;
  period: string;
}

export interface JobListing {
  id: string;
  source: string;
  sourceId: string;
  title: string;
  company: string;
  location: string;
  remote: boolean;
  salary?: Salary;
  description: string;
  requirements: string[];
  url: string;
  postedAt?: string;
  scrapedAt: string;
  tags: string[];
  matchScore?: number;
  matchReasoning?: string;
  matchedIdentity?: "operator" | "legal" | "research" | "applied_ai_operator";
  identityReasons?: Record<string, string[]>;
  compound_fit?: number;
  asymmetry_fit?: "high" | "none";
}

export interface SearchStats {
  totalFound: number;
  afterDedup: number;
  durationMs: number;
  agentsQueried: number;
  agentsSucceeded: number;
  totalTokensUsed: number;
  estimatedCostUsd: number;
}

export interface SearchResult {
  traceId: string;
  query: { raw: string };
  jobs: JobListing[];
  stats: SearchStats;
}

export interface JobsResponse {
  jobs: JobListing[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

// ─── Observability types ──────────────────────────────────────────

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, string | number | boolean>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  durationMs?: number;
  status: "ok" | "error" | "timeout";
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
  children: Span[];
}

export interface MetricSeries {
  labels: Record<string, string>;
  value: number;
}

export interface MetricPercentiles {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  count: number;
  min: number;
  max: number;
}

export interface MetricSnapshot {
  name: string;
  type: "counter" | "gauge" | "histogram";
  help: string;
  series: MetricSeries[];
  percentiles?: MetricPercentiles;
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

export interface CostSummary {
  totalUsd: number;
  byModel: Record<string, number>;
  byComponent: Record<string, number>;
  entryCount: number;
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

// ─── Content generation types ─────────────────────────────────────

export interface ContentVariant {
  strategy: string;
  confidence: number;
  content: string;
}

export interface GeneratedContent {
  variants: ContentVariant[];
}

export interface ApplyResult {
  jobId: string;
  job: JobListing;
  resume?: GeneratedContent;
  coverLetter?: GeneratedContent;
  email?: GeneratedContent;
}

// ─── Feedback / tuning types ─────────────────────────────────────

export type IdentityKey = "operator" | "legal" | "research" | "applied_ai_operator";

export interface FeedbackStats {
  total: number;
  distribution: Record<string, number>; // "-2".."+2" → count
  correctionCount: number;
}

export interface RankerWeight {
  featureName: string;
  identity: string;
  weight: number;
  baseWeight: number;
  updatedAt: string;
  sampleSize: number;
  correlation: number | null;
}

export interface PreferenceSummary {
  id: string;
  generatedAt: string;
  voteWindowStart: string;
  voteWindowEnd: string;
  sampleSize: number;
  summaryJson: string;
  model: string;
}

export interface FeedbackRecord {
  id: string;
  jobId: string;
  jobTitle?: string | null;
  jobCompany?: string | null;
  rating: number;
  matchedIdentity: string | null;
  correctedIdentity: string | null;
  votedAt: string;
  searchQuery: string | null;
  featuresJson: string | null;
}

export interface FeedbackStatus {
  stats: FeedbackStats;
  weights: RankerWeight[];
  latestSummary: PreferenceSummary | null;
  recentCorrections: Array<{
    jobId: string;
    matchedIdentity: string | null;
    correctedIdentity: string | null;
    votedAt: string;
  }>;
  recentFeedback: FeedbackRecord[];
}

export interface SubmitFeedbackResponse {
  id: string;
  total: number;
  autoRetuned: boolean;
  autoSummarized: boolean;
}

// ─── Tracker / Kanban types ───────────────────────────────────────

export type KanbanStatus = "saved" | "applied" | "interview" | "offer" | "rejected";

export interface KanbanColumnDef {
  id: KanbanStatus;
  label: string;
  accent: string;
}

export const KANBAN_COLUMNS: KanbanColumnDef[] = [
  { id: "saved",     label: "Saved",     accent: "#6b7280" },
  { id: "applied",   label: "Applied",   accent: "#3b82f6" },
  { id: "interview", label: "Interview", accent: "#f59e0b" },
  { id: "offer",     label: "Offer",     accent: "#22c55e" },
  { id: "rejected",  label: "Rejected",  accent: "#ef4444" },
];
