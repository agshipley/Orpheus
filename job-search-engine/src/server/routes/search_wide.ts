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

  let result;
  try {
    result = await conductor.searchWide(identityKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`[search_wide] searchWide threw identity=${identityKey} error=${message}`, stack);
    res.status(500).json({ error: "Wide search failed", detail: message });
    return;
  }

  // Persist to job store — failures here are non-fatal, don't block the response.
  try {
    const store = new JobStore(config.storage.dbPath);
    try {
      store.bulkUpsert(result.jobs);
    } finally {
      store.close();
    }
  } catch (err) {
    console.warn(`[search_wide] bulkUpsert failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  res.json(result);
}
