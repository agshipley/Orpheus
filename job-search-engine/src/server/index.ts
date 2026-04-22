/**
 * Orpheus Express API server.
 *
 * Routes:
 *   POST /api/search              — run a search via the Conductor
 *   POST /api/apply               — generate application materials
 *   GET  /api/jobs                — paginated stored-job listing
 *   GET  /api/jobs/:id            — single stored job
 *   GET  /api/traces              — recent Pylon traces
 *   GET  /api/metrics             — current metrics snapshot
 *   GET  /api/config/profile      — safe user-profile subset
 *
 * In production (NODE_ENV=production) the server also serves the compiled
 * React frontend from dist/client/. In development, Vite runs on port 5173
 * and proxies /api requests here, so the static-file serving is skipped.
 *
 * Reads config from archimedes.config.yaml (falling back through the
 * orpheus.config.* chain). The .env file is loaded by src/server/config.ts
 * at import time.
 */

import express from "express";
import cors from "cors";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Route handlers
import { searchHandler } from "./routes/search.js";
import { searchWideHandler } from "./routes/search_wide.js";
import { applyHandler } from "./routes/apply.js";
import { listJobsHandler, getJobHandler } from "./routes/jobs.js";
import { tracesHandler, metricsHandler, decisionsHandler } from "./routes/observability.js";
import { profileHandler } from "./routes/profile.js";
import { createApplicationHandler } from "./routes/applications.js";
import {
  recordFeedbackHandler,
  retuneWeightsHandler,
  regenerateSummaryHandler,
  feedbackStatusHandler,
} from "./routes/feedback.js";
import { regeneratePositioningHandler, getPositioningHandler } from "./routes/positioning.js";
import { matchesHandler } from "./routes/matches.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const IS_PROD = process.env.NODE_ENV === "production";

// ─── App ──────────────────────────────────────────────────────────

const app = express();

// Parse JSON request bodies (generous limit for cover-letter payloads)
app.use(express.json({ limit: "1mb" }));

// CORS — in development, allow the Vite dev server on 5173.
// In production the same origin serves the frontend so this isn't needed,
// but we keep a loose policy in case the frontend is deployed separately.
app.use(
  cors({
    origin: IS_PROD
      ? false  // same-origin only in production
      : ["http://localhost:5173", "http://127.0.0.1:5173"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ─── Request logger (every request, before routing) ───────────────

app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.path}`);
  next();
});

// ─── API Routes ───────────────────────────────────────────────────

app.post("/api/search", searchHandler);
app.post("/api/search/wide", searchWideHandler);
app.post("/api/apply", applyHandler);
app.post("/api/applications", createApplicationHandler);

app.post("/api/feedback", recordFeedbackHandler);
app.post("/api/feedback/retune-weights", retuneWeightsHandler);
app.post("/api/feedback/regenerate-summary", regenerateSummaryHandler);
app.get("/api/feedback/status", feedbackStatusHandler);

app.get("/api/jobs", listJobsHandler);
app.get("/api/jobs/:id", getJobHandler);

app.get("/api/traces", tracesHandler);
app.get("/api/metrics", metricsHandler);
app.get("/api/decisions", decisionsHandler);

app.get("/api/config/profile", profileHandler);

app.get("/api/matches", matchesHandler);
app.get("/api/positioning", getPositioningHandler);
app.post("/api/positioning/regenerate", regeneratePositioningHandler);

// ─── Health check ─────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0", timestamp: new Date().toISOString() });
});

// ─── Static frontend (production) ─────────────────────────────────

if (IS_PROD) {
  const clientDist = join(__dirname, "../../dist/client");
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // SPA fallback — any non-API path returns index.html
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(join(clientDist, "index.html"));
    });
  } else {
    console.warn(
      "[server] dist/client not found — frontend not available. " +
        "Run the frontend build first."
    );
  }
}

// ─── Start ────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(
    `[server] Orpheus API listening on http://localhost:${PORT}  ` +
      `(${IS_PROD ? "production" : "development"})`
  );
});

export { app };
