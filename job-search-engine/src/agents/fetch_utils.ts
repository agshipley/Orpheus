/**
 * Shared fetch utilities for direct-fetch agents.
 *
 * - 1-hour in-memory response cache (per URL)
 * - Configurable per-fetch timeout (default 10s)
 * - Shared Greenhouse and Lever API types + parsers
 * - Engineering title exclusion filter
 * - Legal/compliance title inclusion filter
 */

import { nanoid } from "nanoid";
import type { AgentSource, JobListing } from "../types.js";

// ─── Cache ────────────────────────────────────────────────────────

interface CacheEntry {
  text: string;
  expiresAt: number;
}

const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function clearFetchCache(): void {
  CACHE.clear();
}

// ─── Fetch with timeout + cache ───────────────────────────────────

export async function fetchCached(url: string, timeoutMs = 10_000): Promise<string> {
  const hit = CACHE.get(url);
  if (hit && hit.expiresAt > Date.now()) return hit.text;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "OrpheusJobSearch/1.0 (personal job search tool)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    CACHE.set(url, { text, expiresAt: Date.now() + CACHE_TTL_MS });
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJsonCached<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const text = await fetchCached(url, timeoutMs);
  return JSON.parse(text) as T;
}

// ─── Title filters ────────────────────────────────────────────────

// IC engineering roles to suppress globally. Leadership / PM / EM titles intentionally
// excluded from this pattern — "Engineering Manager", "Director of Engineering",
// "Product Manager", "Technical Program Manager" all pass through.
const ENG_EXCLUDE_RX =
  /\b(software engineer|swe\b|sde\b|frontend engineer|back.?end engineer|full.?stack engineer|ml engineer|machine learning engineer|ai engineer|data engineer|data scientist|devops engineer|sre\b|platform engineer|principal engineer|staff engineer|infrastructure engineer|site reliability engineer|member of technical staff|research scientist|research engineer|security engineer|cloud engineer|network engineer|ios engineer|android engineer|mobile engineer|qa engineer|test engineer|embedded engineer|firmware engineer|hardware engineer|systems engineer)\b/i;

// Leadership/PM roles that must always pass through even if the broader title
// happens to contain an engineering word (e.g. "Technical Engineering Lead").
const ENG_LEADERSHIP_RX =
  /\b(engineering manager|director of engineering|vp.*engineer|head of engineer|product manager|program manager|technical program manager|tpm\b|chief.*engineer|cto\b)\b/i;

export function isExcludedEngineeringRole(title: string): boolean {
  if (ENG_LEADERSHIP_RX.test(title)) return false;
  return ENG_EXCLUDE_RX.test(title);
}

const LEGAL_INCLUDE_RX =
  /\b(counsel|legal|compliance|governance|privacy|policy|business affairs|corporate development|corp dev|corporate affairs|general counsel|associate general counsel|chief legal)\b/i;

export function isLegalOrComplianceRole(title: string): boolean {
  return LEGAL_INCLUDE_RX.test(title);
}

// ─── Greenhouse API ───────────────────────────────────────────────

export interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location: { name: string };
  departments?: Array<{ id: number; name: string }>;
  offices?: Array<{ id: number; name: string }>;
  updated_at?: string;
  content?: string; // HTML, present when ?content=true
}

export interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

export async function fetchGreenhouseJobs(slug: string): Promise<GreenhouseJob[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  const data = await fetchJsonCached<GreenhouseResponse>(url);
  return data.jobs ?? [];
}

export function parseGreenhouseJob(
  job: GreenhouseJob,
  companyName: string,
  source: AgentSource,
  excludeEngineering = false
): JobListing | null {
  if (!job.title || !job.absolute_url) return null;
  if (excludeEngineering && isExcludedEngineeringRole(job.title)) return null;

  const location = job.location?.name ?? "";
  const remote = /remote/i.test(location);
  const description = job.content
    ? job.content.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim()
    : `${job.title} at ${companyName}`;

  return {
    id: `${source}_gh_${job.id}`,
    source,
    sourceId: String(job.id),
    title: job.title,
    company: companyName,
    location: remote ? "" : location,
    remote,
    description,
    requirements: [],
    url: job.absolute_url,
    postedAt: job.updated_at,
    scrapedAt: new Date().toISOString(),
    tags: (job.departments ?? []).map((d) => d.name),
  };
}

// ─── Lever API ────────────────────────────────────────────────────

export interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt: number;
  categories?: {
    team?: string;
    location?: string;
    commitment?: string;
    department?: string;
  };
  description?: string;
  descriptionPlain?: string;
}

export async function fetchLeverPostings(slug: string): Promise<LeverPosting[]> {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const data = await fetchJsonCached<LeverPosting[]>(url);
  return Array.isArray(data) ? data : [];
}

export function parseLeverPosting(
  posting: LeverPosting,
  companyName: string,
  source: AgentSource,
  excludeEngineering = false
): JobListing | null {
  if (!posting.text || !posting.hostedUrl) return null;
  if (excludeEngineering && isExcludedEngineeringRole(posting.text)) return null;

  const location = posting.categories?.location ?? "";
  const remote = /remote/i.test(location);
  const description = posting.descriptionPlain ?? posting.description?.replace(/<[^>]+>/g, " ").trim() ?? posting.text;

  return {
    id: `${source}_lv_${posting.id.slice(0, 12)}`,
    source,
    sourceId: posting.id,
    title: posting.text,
    company: companyName,
    location: remote ? "" : location,
    remote,
    description,
    requirements: [],
    url: posting.hostedUrl,
    postedAt: posting.createdAt ? new Date(posting.createdAt).toISOString() : undefined,
    scrapedAt: new Date().toISOString(),
    tags: [posting.categories?.team ?? "", posting.categories?.department ?? ""].filter(Boolean),
  };
}

// ─── Getro API ────────────────────────────────────────────────────

export interface GetroJob {
  id: number | string;
  title: string;
  company?: { name?: string; id?: number };
  company_name?: string;
  location?: string;
  remote?: boolean;
  job_url?: string;
  url?: string;
  apply_url?: string;
  description?: string;
  category?: string;
  categories?: string[];
  posted_at?: string;
}

export interface GetroResponse {
  jobs?: GetroJob[];
  data?: GetroJob[];
}

export function parseGetroJob(
  job: GetroJob,
  source: AgentSource,
  excludeEngineering = false
): JobListing | null {
  const title = job.title?.trim();
  const company = job.company?.name ?? job.company_name ?? "";
  const url = job.job_url ?? job.url ?? job.apply_url ?? "";

  if (!title || !company || !url) return null;
  if (excludeEngineering && isExcludedEngineeringRole(title)) return null;

  const location = job.location ?? "";
  const remote = job.remote ?? /remote/i.test(location);

  return {
    id: `${source}_gt_${nanoid(10)}`,
    source,
    sourceId: String(job.id),
    title,
    company,
    location: remote ? "" : location,
    remote,
    description: job.description ?? `${title} at ${company}`,
    requirements: [],
    url,
    postedAt: job.posted_at,
    scrapedAt: new Date().toISOString(),
    tags: job.categories ?? (job.category ? [job.category] : []),
  };
}

// ─── Agent timeout wrapper ────────────────────────────────────────

export async function withAgentTimeout<T>(
  promise: Promise<T>,
  agentSource: string,
  ceilingMs = 20_000
): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${agentSource} agent exceeded ${ceilingMs}ms ceiling`)), ceilingMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
