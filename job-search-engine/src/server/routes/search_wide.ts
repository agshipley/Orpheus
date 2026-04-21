import type { Request, Response } from "express";
import { Conductor } from "../../conductor/conductor.js";
import { JobStore } from "../../storage/job_store.js";
import { loadConfig } from "../config.js";

/**
 * POST /api/search/wide
 * Body: { identity?: "operator"|"legal"|"research" }
 *
 * No LLM query parsing, no LLM re-ranking. Uses preset identity queries,
 * fans out to all configured agent sources, heuristic-ranks up to 100 results.
 */
export async function searchWideHandler(req: Request, res: Response): Promise<void> {
  const { identity } = req.body as { identity?: unknown };
  const identityKey = typeof identity === "string" ? identity : "operator";

  const config = loadConfig();
  const conductor = new Conductor(config);

  try {
    const result = await conductor.searchWide(identityKey);

    const store = new JobStore(config.storage.dbPath);
    try {
      store.bulkUpsert(result.jobs);
    } finally {
      store.close();
    }

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Wide search failed", detail: message });
  }
}
