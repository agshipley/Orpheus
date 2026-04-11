import type {
  SearchResult,
  JobsResponse,
  JobListing,
  ApplyResult,
  Span,
  MetricSnapshot,
  DecisionLogEntry,
  CostSummary,
  CostEntry,
} from "../types";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ─── Search ───────────────────────────────────────────────────────

export const search = (query: string): Promise<SearchResult> =>
  req("/search", json({ query }));

// ─── Jobs ─────────────────────────────────────────────────────────

export const listJobs = (opts: {
  page?: number;
  limit?: number;
  source?: string;
  remote?: boolean;
} = {}): Promise<JobsResponse> =>
  req(`/jobs${qs(opts as Record<string, string | number | boolean | undefined>)}`);

export const getJob = (id: string): Promise<JobListing> =>
  req(`/jobs/${id}`);

// ─── Apply ────────────────────────────────────────────────────────

export const apply = (
  jobId: string,
  types: ("resume" | "cover_letter" | "email")[],
  opts: { tone?: string; variants?: number } = {}
): Promise<ApplyResult> =>
  req("/apply", json({ jobId, types, ...opts }));

// ─── Observability ────────────────────────────────────────────────

export const getTraces = (limit = 20): Promise<{ traces: Span[]; count: number }> =>
  req(`/traces${qs({ limit })}`);

export const getMetrics = (): Promise<{ metrics: MetricSnapshot[]; capturedAt: string }> =>
  req("/metrics");

export const getDecisions = (opts: {
  limit?: number;
  component?: string;
} = {}): Promise<{
  entries: DecisionLogEntry[];
  costSummary: CostSummary;
  costEntries: CostEntry[];
  count: number;
}> =>
  req(`/decisions${qs(opts as Record<string, string | number | boolean | undefined>)}`);

// ─── Profile ──────────────────────────────────────────────────────

export const getProfile = (): Promise<{
  name: string;
  location: string | null;
  skills: string[];
  targetTitles: string[];
}> => req("/config/profile");
