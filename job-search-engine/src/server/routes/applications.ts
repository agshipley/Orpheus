import type { Request, Response } from "express";
import { JobStore } from "../../storage/job_store.js";
import { loadConfig } from "../config.js";

/**
 * POST /api/applications
 * Body: { jobId, type, strategy, content, confidence }
 *
 * Persists a generated content variant so the Tracker can retrieve it.
 */
export async function createApplicationHandler(req: Request, res: Response): Promise<void> {
  const { jobId, type, strategy, content, confidence } = req.body as {
    jobId?: unknown;
    type?: unknown;
    strategy?: unknown;
    content?: unknown;
    confidence?: unknown;
  };

  if (typeof jobId !== "string" || !jobId) {
    res.status(400).json({ error: "jobId required" });
    return;
  }
  if (typeof type !== "string" || !type) {
    res.status(400).json({ error: "type required" });
    return;
  }
  if (typeof content !== "string" || !content) {
    res.status(400).json({ error: "content required" });
    return;
  }

  const config = loadConfig();
  const store = new JobStore(config.storage.dbPath);

  try {
    const id = store.storeGeneratedContent({
      jobId,
      type,
      strategy: typeof strategy === "string" ? strategy : "default",
      content,
      confidence: typeof confidence === "number" ? confidence : 0.7,
    });
    res.json({ id, jobId });
  } finally {
    store.close();
  }
}
