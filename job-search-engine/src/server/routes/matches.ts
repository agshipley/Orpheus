import type { Request, Response } from "express";
import { Conductor } from "../../conductor/conductor.js";
import { loadConfig } from "../config.js";

/**
 * GET /api/matches
 * Re-scores stored jobs with asymmetry detection and returns those
 * flagged asymmetry_fit=high, sorted by compound_fit then matchScore.
 * No new search triggered — works from the existing job store.
 */
export async function matchesHandler(_req: Request, res: Response): Promise<void> {
  try {
    const config = loadConfig();
    const conductor = new Conductor(config);
    const jobs = await conductor.getMatches();
    res.json({ jobs, count: jobs.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Matches failed", detail: message });
  }
}
