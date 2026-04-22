import type { Request, Response } from "express";
import { loadConfig } from "../config.js";
import { regeneratePositioning, readPositioningFile } from "../../positioning.js";

/**
 * POST /api/positioning/regenerate
 * Rebuilds Section 1 of POSITIONING.md from current config state.
 * Section 2 (human-curated) is preserved.
 */
export async function regeneratePositioningHandler(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const config = loadConfig();
    regeneratePositioning(config);
    const content = readPositioningFile();
    res.json({ ok: true, length: content.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Positioning regeneration failed", detail: message });
  }
}

/**
 * GET /api/positioning
 * Returns the current POSITIONING.md content.
 */
export function getPositioningHandler(_req: Request, res: Response): void {
  const content = readPositioningFile();
  res.json({ content });
}
