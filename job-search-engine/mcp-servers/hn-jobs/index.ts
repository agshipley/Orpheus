/**
 * HN Jobs MCP Server — Scrapes the current Hacker News "Who's Hiring" thread.
 *
 * Uses the public HN Firebase API (no auth required):
 *   https://hacker-news.firebaseio.com/v0/
 *
 * The server fetches the current monthly thread from the `whoishiring` HN
 * account, parses the top-level comments as job postings, and exposes them
 * via the standard Orpheus MCP search_jobs interface.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJobBoardServer } from "../../src/mcp/server.js";

const HN_API = "https://hacker-news.firebaseio.com/v0";

// ─── HN API Types ────────────────────────────────────────────────

interface HNUser {
  id: string;
  submitted: number[];
}

interface HNItem {
  id: number;
  type: string;
  by?: string;
  title?: string;
  text?: string;
  time: number;
  kids?: number[];
  url?: string;
  dead?: boolean;
  deleted?: boolean;
}

// ─── HN API Helpers ──────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HN API ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

/**
 * Find the current "Ask HN: Who is hiring?" thread.
 * The `whoishiring` account posts it on the first weekday of each month.
 */
async function getHiringThread(): Promise<HNItem> {
  const user = await fetchJson<HNUser>(`${HN_API}/user/whoishiring.json`);

  // The current thread is almost always the first or second submitted item.
  // Check the 8 most recent to be safe.
  for (const id of user.submitted.slice(0, 8)) {
    const item = await fetchJson<HNItem>(`${HN_API}/item/${id}.json`);
    if (
      item.type === "story" &&
      item.title?.includes("Who is hiring?")
    ) {
      return item;
    }
  }

  throw new Error("Could not find the current HN Who's Hiring thread");
}

// ─── HTML Decoding ───────────────────────────────────────────────

function decodeHtml(html: string): string {
  return html
    .replace(/<p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

// ─── Job Parsing ─────────────────────────────────────────────────

interface ParsedHNJob {
  hnId: string;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  description: string;
  applyUrl: string;
  postedAt: string;
}

/**
 * Parse a single HN comment into a structured job posting.
 *
 * Most HN job comments follow a loose convention:
 *   Company | Role | Location | (Remote/Onsite) | Salary range
 *   <description>
 *
 * We extract what we can from the first pipe-delimited line and
 * use the full decoded text as the description.
 */
function parseJobComment(item: HNItem): ParsedHNJob | null {
  if (!item.text || !item.by || item.dead || item.deleted) return null;

  const text = decodeHtml(item.text);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const firstLine = lines[0];
  const parts = firstLine.split("|").map((s) => s.trim());

  const company = parts[0] || item.by;
  // If only one pipe-part, the whole first line is probably the company name
  const title = parts[1] || "Engineer";
  const locationRaw = parts[2] || "";

  const remote =
    /\bremote\b/i.test(text) ||
    /\bremote\b/i.test(locationRaw);

  const location = locationRaw || (remote ? "Remote" : "Unknown");

  // Prefer a URL from the posting body; fall back to the HN thread comment
  const urlMatch = text.match(/https?:\/\/[^\s)>\]"]+/);
  let applyUrl = urlMatch ? urlMatch[0].replace(/[.,;]+$/, "") : "";
  // Validate it's a real URL
  try {
    new URL(applyUrl);
  } catch {
    applyUrl = `https://news.ycombinator.com/item?id=${item.id}`;
  }

  return {
    hnId: String(item.id),
    company,
    title,
    location,
    remote,
    description: text,
    applyUrl,
    postedAt: new Date(item.time * 1000).toISOString(),
  };
}

// ─── Thread Scraping ────────────────────────────────────────────

const CONCURRENCY = 12;

async function fetchJobsFromThread(
  thread: HNItem,
  maxComments: number
): Promise<ParsedHNJob[]> {
  const ids = (thread.kids ?? []).slice(0, maxComments);
  const jobs: ParsedHNJob[] = [];

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    const items = await Promise.all(
      chunk.map((id) =>
        fetchJson<HNItem>(`${HN_API}/item/${id}.json`).catch(() => null)
      )
    );
    for (const item of items) {
      if (!item) continue;
      const job = parseJobComment(item);
      if (job) jobs.push(job);
    }
  }

  return jobs;
}

// ─── In-Process Cache ────────────────────────────────────────────

// Cache jobs for the lifetime of the server process so repeated
// tool calls within a single agent session don't re-scrape HN.
let jobCache: ParsedHNJob[] | null = null;

async function getJobs(maxComments = 400): Promise<ParsedHNJob[]> {
  if (jobCache) return jobCache;
  const thread = await getHiringThread();
  jobCache = await fetchJobsFromThread(thread, maxComments);
  return jobCache;
}

// ─── MCP Server ──────────────────────────────────────────────────

const server = createJobBoardServer({
  source: "ycombinator",

  async searchJobs(params) {
    const jobs = await getJobs();
    const keywords = params.keywords
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    let filtered = jobs.filter((job) => {
      const haystack =
        `${job.title} ${job.company} ${job.description}`.toLowerCase();
      return keywords.some((kw) => haystack.includes(kw));
    });

    if (params.remoteFilter === "remote") {
      filtered = filtered.filter((j) => j.remote);
    } else if (params.remoteFilter === "onsite") {
      filtered = filtered.filter((j) => !j.remote);
    }

    if (params.location) {
      const locLower = params.location.toLowerCase();
      filtered = filtered.filter(
        (j) =>
          j.remote || j.location.toLowerCase().includes(locLower)
      );
    }

    const limited = filtered.slice(0, params.limit ?? 25);

    return {
      jobs: limited.map((j) => ({
        jobId: j.hnId,
        title: j.title,
        company: { name: j.company },
        location: j.location,
        remote: j.remote,
        description: j.description,
        skills: [],
        url: j.applyUrl,
        listedAt: j.postedAt,
      })),
      total: filtered.length,
    };
  },

  async getJobDetail({ jobId }) {
    const jobs = await getJobs();
    const job = jobs.find((j) => j.hnId === jobId);
    if (!job) throw new Error(`HN job ${jobId} not found`);
    return job;
  },

  async checkSalary({ jobId }) {
    const jobs = await getJobs();
    const job = jobs.find((j) => j.hnId === jobId);
    if (!job) return { note: "Job not found" };

    // Try to parse a salary range from the posting text
    const m = job.description.match(
      /\$\s*(\d{2,3})k?\s*[-–to]+\s*\$?\s*(\d{2,3})k?/i
    );
    if (m) {
      const toNum = (s: string) => {
        const n = parseInt(s);
        return n < 500 ? n * 1000 : n; // "150k" vs "150000"
      };
      return {
        min: toNum(m[1]),
        max: toNum(m[2]),
        currency: "USD",
        source: "parsed from posting",
      };
    }

    return { note: "No salary information found in posting" };
  },

  async submitApplication({ jobId }) {
    const jobs = await getJobs();
    const job = jobs.find((j) => j.hnId === jobId);
    return {
      success: false,
      note: "HN jobs require direct application — see the URL below",
      applyUrl: job
        ? job.applyUrl
        : `https://news.ycombinator.com/item?id=${jobId}`,
    };
  },
});

const transport = new StdioServerTransport();
await server.connect(transport);
