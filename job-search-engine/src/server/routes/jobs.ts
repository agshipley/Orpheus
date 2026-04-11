import type { Request, Response } from "express";
import { JobStore } from "../../storage/job_store.js";
import { loadConfig } from "../config.js";

/**
 * GET /api/jobs
 * Query params: page (default 1), limit (default 20, max 100),
 *               source, remote ("true"/"false")
 */
export function listJobsHandler(req: Request, res: Response): void {
  const config = loadConfig();
  const store = new JobStore(config.storage.dbPath);

  try {
    const page = parseInt(String(req.query.page ?? "1"), 10);
    const limit = parseInt(String(req.query.limit ?? "20"), 10);
    const source = typeof req.query.source === "string" ? req.query.source : undefined;
    const remoteParam = req.query.remote;
    const remote =
      remoteParam === "true" ? true : remoteParam === "false" ? false : undefined;

    const { jobs, total } = store.list({ page, limit, source, remote });

    res.json({
      jobs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } finally {
    store.close();
  }
}

/**
 * GET /api/jobs/:id
 */
export function getJobHandler(req: Request, res: Response): void {
  const config = loadConfig();
  const store = new JobStore(config.storage.dbPath);

  try {
    const id = req.params["id"] as string;
    const job = store.getById(id);
    if (!job) {
      res.status(404).json({ error: `Job not found: ${id}` });
      return;
    }
    res.json(job);
  } finally {
    store.close();
  }
}
