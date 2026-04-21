/**
 * Job Store — SQLite-backed persistence for job listings.
 *
 * Handles:
 * - Storing discovered jobs with deduplication
 * - Tracking application status per job
 * - Full-text search across stored listings
 * - Statistics and analytics queries
 */

import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type { JobListing } from "../types.js";

export class JobStore {
  private db: Database.Database;

  constructor(dbPath: string = "./data/orpheus.db") {
    this.db = new Database(dbPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        company TEXT NOT NULL,
        location TEXT,
        remote INTEGER DEFAULT 0,
        salary_min REAL,
        salary_max REAL,
        salary_currency TEXT DEFAULT 'USD',
        description TEXT,
        requirements TEXT, -- JSON array
        url TEXT,
        posted_at TEXT,
        scraped_at TEXT NOT NULL,
        tags TEXT, -- JSON array
        match_score REAL,
        match_reasoning TEXT,
        dedup_key TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(dedup_key)
      );

      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        status TEXT NOT NULL DEFAULT 'saved',
        resume_variant_id TEXT,
        cover_letter_variant_id TEXT,
        applied_at TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS search_history (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        raw_query TEXT NOT NULL,
        parsed_query TEXT, -- JSON
        results_count INTEGER,
        duration_ms INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS generated_content (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        type TEXT NOT NULL,
        strategy TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
      CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
      CREATE INDEX IF NOT EXISTS idx_jobs_dedup ON jobs(dedup_key);
      CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(match_score DESC);
      CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
      CREATE INDEX IF NOT EXISTS idx_generated_content_job ON generated_content(job_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
        title, company, description, tags,
        content='jobs',
        content_rowid='rowid'
      );
    `);
  }

  /**
   * Upsert a job listing. Returns true if new, false if duplicate.
   */
  upsert(job: JobListing): boolean {
    const dedupKey = this.dedupKey(job);

    const stmt = this.db.prepare(`
      INSERT INTO jobs (
        id, source, source_id, title, company, location, remote,
        salary_min, salary_max, salary_currency, description,
        requirements, url, posted_at, scraped_at, tags,
        match_score, match_reasoning, dedup_key
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?
      )
      ON CONFLICT(dedup_key) DO UPDATE SET
        match_score = COALESCE(excluded.match_score, match_score),
        match_reasoning = COALESCE(excluded.match_reasoning, match_reasoning),
        scraped_at = excluded.scraped_at
    `);

    const result = stmt.run(
      job.id,
      job.source,
      job.sourceId,
      job.title,
      job.company,
      job.location,
      job.remote ? 1 : 0,
      job.salary?.min ?? null,
      job.salary?.max ?? null,
      job.salary?.currency ?? "USD",
      job.description,
      JSON.stringify(job.requirements),
      job.url,
      job.postedAt ?? null,
      job.scrapedAt,
      JSON.stringify(job.tags),
      job.matchScore ?? null,
      job.matchReasoning ?? null,
      dedupKey
    );

    return result.changes > 0;
  }

  /**
   * Bulk upsert jobs. Returns count of new insertions.
   */
  bulkUpsert(jobs: JobListing[]): number {
    const transaction = this.db.transaction((jobList: JobListing[]) => {
      let newCount = 0;
      for (const job of jobList) {
        if (this.upsert(job)) newCount++;
      }
      return newCount;
    });

    return transaction(jobs);
  }

  /**
   * Full-text search across stored jobs.
   */
  search(query: string, limit: number = 20): JobListing[] {
    const rows = this.db
      .prepare(
        `
      SELECT j.* FROM jobs j
      JOIN jobs_fts ON jobs_fts.rowid = j.rowid
      WHERE jobs_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `
      )
      .all(query, limit) as JobRow[];

    return rows.map(this.rowToListing);
  }

  /**
   * Get a single job by ID.
   */
  getById(id: string): JobListing | undefined {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE id = ?`)
      .get(id) as JobRow | undefined;
    return row ? this.rowToListing(row) : undefined;
  }

  /**
   * Paginated job listing with optional source/remote filters.
   */
  list(opts: {
    page?: number;
    limit?: number;
    source?: string;
    remote?: boolean;
  } = {}): { jobs: JobListing[]; total: number } {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.source) {
      conditions.push("source = ?");
      params.push(opts.source);
    }
    if (opts.remote !== undefined) {
      conditions.push("remote = ?");
      params.push(opts.remote ? 1 : 0);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) as count FROM jobs ${where}`)
        .get(...params) as { count: number }
    ).count;

    const rows = this.db
      .prepare(
        `SELECT * FROM jobs ${where}
         ORDER BY match_score DESC, scraped_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as JobRow[];

    return { jobs: rows.map(this.rowToListing), total };
  }

  /**
   * Get top-scored jobs.
   */
  getTopJobs(limit: number = 20): JobListing[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE match_score IS NOT NULL ORDER BY match_score DESC LIMIT ?`
      )
      .all(limit) as JobRow[];

    return rows.map(this.rowToListing);
  }

  /**
   * Track an application.
   */
  trackApplication(
    jobId: string,
    status: string = "saved",
    notes?: string
  ): string {
    const id = `app_${nanoid(10)}`;
    this.db
      .prepare(
        `INSERT INTO applications (id, job_id, status, notes) VALUES (?, ?, ?, ?)`
      )
      .run(id, jobId, status, notes ?? null);
    return id;
  }

  /**
   * Update application status.
   */
  updateApplicationStatus(appId: string, status: string): void {
    this.db
      .prepare(
        `UPDATE applications SET status = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(status, appId);
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalJobs: number;
    bySource: Record<string, number>;
    byStatus: Record<string, number>;
    avgMatchScore: number;
  } {
    const totalJobs = (
      this.db.prepare(`SELECT COUNT(*) as count FROM jobs`).get() as {
        count: number;
      }
    ).count;

    const bySource = Object.fromEntries(
      (
        this.db
          .prepare(
            `SELECT source, COUNT(*) as count FROM jobs GROUP BY source`
          )
          .all() as { source: string; count: number }[]
      ).map((r) => [r.source, r.count])
    );

    const byStatus = Object.fromEntries(
      (
        this.db
          .prepare(
            `SELECT status, COUNT(*) as count FROM applications GROUP BY status`
          )
          .all() as { status: string; count: number }[]
      ).map((r) => [r.status, r.count])
    );

    const avgScore = (
      this.db
        .prepare(
          `SELECT AVG(match_score) as avg FROM jobs WHERE match_score IS NOT NULL`
        )
        .get() as { avg: number | null }
    ).avg;

    return {
      totalJobs,
      bySource,
      byStatus,
      avgMatchScore: avgScore ?? 0,
    };
  }

  /**
   * Persist a generated content variant for a job.
   */
  storeGeneratedContent(params: {
    jobId: string;
    type: string;
    strategy: string;
    content: string;
    confidence: number;
  }): string {
    const id = `gen_${nanoid(10)}`;
    this.db
      .prepare(
        `INSERT INTO generated_content (id, job_id, type, strategy, content, confidence)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, params.jobId, params.type, params.strategy, params.content, params.confidence);
    return id;
  }

  /**
   * Retrieve all generated content for a job, newest first.
   */
  getGeneratedContent(jobId: string): Array<{
    id: string;
    jobId: string;
    type: string;
    strategy: string;
    content: string;
    confidence: number;
    createdAt: string;
  }> {
    return (
      this.db
        .prepare(`SELECT * FROM generated_content WHERE job_id = ? ORDER BY created_at DESC`)
        .all(jobId) as Array<{
          id: string; job_id: string; type: string; strategy: string;
          content: string; confidence: number; created_at: string;
        }>
    ).map((r) => ({
      id: r.id,
      jobId: r.job_id,
      type: r.type,
      strategy: r.strategy,
      content: r.content,
      confidence: r.confidence,
      createdAt: r.created_at,
    }));
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  private dedupKey(job: JobListing): string {
    const title = job.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    const company = job.company.toLowerCase().replace(/[^a-z0-9]/g, "");
    return `${title}::${company}`;
  }

  private rowToListing(row: JobRow): JobListing {
    return {
      id: row.id,
      source: row.source as JobListing["source"],
      sourceId: row.source_id,
      title: row.title,
      company: row.company,
      location: row.location ?? "",
      remote: row.remote === 1,
      salary:
        row.salary_min || row.salary_max
          ? {
              min: row.salary_min ?? undefined,
              max: row.salary_max ?? undefined,
              currency: row.salary_currency ?? "USD",
              period: "yearly",
            }
          : undefined,
      description: row.description ?? "",
      requirements: JSON.parse(row.requirements ?? "[]"),
      url: row.url ?? "",
      postedAt: row.posted_at ?? undefined,
      scrapedAt: row.scraped_at,
      tags: JSON.parse(row.tags ?? "[]"),
      matchScore: row.match_score ?? undefined,
      matchReasoning: row.match_reasoning ?? undefined,
    };
  }
}

interface JobRow {
  id: string;
  source: string;
  source_id: string;
  title: string;
  company: string;
  location: string | null;
  remote: number;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  description: string | null;
  requirements: string | null;
  url: string | null;
  posted_at: string | null;
  scraped_at: string;
  tags: string | null;
  match_score: number | null;
  match_reasoning: string | null;
  dedup_key: string;
}
