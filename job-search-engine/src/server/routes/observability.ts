import type { Request, Response } from "express";
import { getTracer, getMetrics, getDecisionLog } from "../../observability/index.js";

/**
 * GET /api/traces
 * Query params: limit (default 20, max 100)
 */
export function tracesHandler(req: Request, res: Response): void {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
  const traces = getTracer().getTraces(limit);
  res.json({ traces, count: traces.length });
}

/**
 * GET /api/metrics
 */
export function metricsHandler(_req: Request, res: Response): void {
  const snapshot = getMetrics().snapshot();
  res.json({ metrics: snapshot, capturedAt: new Date().toISOString() });
}

/**
 * GET /api/decisions
 * Query params: limit (default 50), component (optional filter)
 */
export function decisionsHandler(req: Request, res: Response): void {
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10)));
  const component = typeof req.query.component === "string" ? req.query.component : undefined;

  const log = getDecisionLog();
  let entries = log.getAll(limit);
  if (component) {
    entries = entries.filter((e) => e.component === component);
  }

  res.json({
    entries,
    costSummary: log.getCostSummary(),
    costEntries: log.toJSON().costs,
    count: entries.length,
  });
}
