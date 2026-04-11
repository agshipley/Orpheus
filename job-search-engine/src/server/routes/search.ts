import type { Request, Response } from "express";
import { Conductor } from "../../conductor/conductor.js";
import { loadConfig } from "../config.js";

/**
 * POST /api/search
 * Body: { query: string }
 *
 * Runs the full Conductor pipeline. Agent failures are handled gracefully
 * by the Conductor — partial results or just the parsed query are returned
 * if source agents are unavailable.
 */
export async function searchHandler(req: Request, res: Response): Promise<void> {
  const { query } = req.body as { query?: unknown };

  if (typeof query !== "string" || !query.trim()) {
    res.status(400).json({ error: "query must be a non-empty string" });
    return;
  }

  const config = loadConfig();
  const conductor = new Conductor(config);

  try {
    const result = await conductor.search(query.trim());
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Search failed", detail: message });
  }
}
