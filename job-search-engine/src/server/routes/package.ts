import type { Request, Response } from "express";
import { nanoid } from "nanoid";
import { loadConfig } from "../config.js";
import { scoreJob, flagAsymmetry, computeGithubSignalBoost } from "../../conductor/ranker.js";
import { generateStructuralRead } from "../../content/structural_read.js";
import {
  generatePackageResume,
  generatePackageCoverLetter,
  generatePackageEmail,
} from "../../content/package_generators.js";
import { renderResumeDocx, renderCoverLetterDocx, sanitizeFilename } from "../../content/docx_render.js";
import type {
  JobListing,
  SearchQuery,
  PackageScoringResult,
  ResumeStructured,
  CoverLetterStructured,
} from "../../types.js";

// ─── Rate limiter (in-memory, rolling 60-minute window) ───────────

interface RateEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateEntry>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT) return false;

  entry.count++;
  return true;
}

// ─── POST /api/package ────────────────────────────────────────────

export async function packageHandler(req: Request, res: Response): Promise<void> {
  const ip = req.ip ?? "unknown";

  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: "Rate limit exceeded. Max 10 packages per hour." });
    return;
  }

  const { company, title, description, location, remote } = req.body as {
    company?: unknown;
    title?: unknown;
    description?: unknown;
    location?: unknown;
    remote?: unknown;
  };

  if (typeof company !== "string" || company.trim().length === 0 || company.length > 200) {
    res.status(400).json({ error: "company is required and must be <= 200 characters." });
    return;
  }
  if (typeof title !== "string" || title.trim().length === 0 || title.length > 200) {
    res.status(400).json({ error: "title is required and must be <= 200 characters." });
    return;
  }
  if (typeof description !== "string" || description.length < 100 || description.length > 20000) {
    res.status(400).json({ error: "description must be between 100 and 20000 characters." });
    return;
  }

  const config = loadConfig();

  const syntheticJob: JobListing = {
    id: `package_${nanoid(10)}`,
    source: "package",
    sourceId: nanoid(8),
    title: title.trim(),
    company: company.trim(),
    location: typeof location === "string" && location.trim() ? location.trim() : "Not specified",
    remote: remote === true,
    description,
    requirements: [],
    url: "https://orpheus.local/package",
    scrapedAt: new Date().toISOString(),
    tags: [],
  };

  const syntheticQuery: SearchQuery = {
    raw: title,
    title: title,
    skills: [],
    industries: [],
    excludeCompanies: [],
    maxResults: 1,
  };

  // Step 1: Score (synchronous)
  const jobScore = scoreJob(
    syntheticJob,
    syntheticQuery,
    config.profile,
    config.org_adjacency,
    undefined,
    config.github_signal ?? []
  );

  // Extract github signal hits from winner reasons
  const githubSignalHits = (jobScore.identityScores[jobScore.matchedIdentity]?.reasons ?? [])
    .filter((r) => r.startsWith("GitHub signal:"))
    .map((r) => r.replace(/^GitHub signal:\s*/, "").replace(/\s*\([^)]+\)\s*$/, "").trim());

  // Compute asymmetry on the winner's github boost pts
  const winnerBoost = computeGithubSignalBoost(
    syntheticJob,
    jobScore.matchedIdentity,
    config.github_signal ?? []
  );
  const asymmetry_fit = flagAsymmetry(syntheticJob, jobScore.compound_fit, winnerBoost?.pts ?? 0);

  syntheticJob.matchedIdentity = jobScore.matchedIdentity;
  syntheticJob.compound_fit = jobScore.compound_fit;
  syntheticJob.asymmetry_fit = asymmetry_fit;

  const scoring: PackageScoringResult = {
    identity_scores: Object.fromEntries(
      Object.entries(jobScore.identityScores).map(([k, v]) => [k, { score: v.score, reasons: v.reasons }])
    ),
    winning_identity: jobScore.matchedIdentity,
    compound_fit: jobScore.compound_fit,
    asymmetry_fit,
    github_signal_hits: githubSignalHits,
    score_reasons: jobScore.identityScores[jobScore.matchedIdentity]?.reasons ?? [],
  };

  const identity = jobScore.matchedIdentity;

  // Step 2: Structural read (single Claude call, must succeed)
  let structuralRead;
  try {
    structuralRead = await generateStructuralRead(syntheticJob, jobScore, config);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Structural read generation failed", detail });
    return;
  }

  // Step 3: Resume + cover letter + email in parallel
  type ResumeResult = { structured: ResumeStructured; html: string };
  type CoverLetterResult = { structured: CoverLetterStructured; html: string };
  type EmailResult = { subject: string; body: string };

  const [resumeResult, coverLetterResult, emailResult] = await Promise.allSettled([
    generatePackageResume(syntheticJob, config.profile, config, identity),
    generatePackageCoverLetter(syntheticJob, config.profile, config, identity),
    generatePackageEmail(syntheticJob, config.profile, config, identity),
  ]);

  const resumeOut = resumeResult.status === "fulfilled"
    ? resumeResult.value as ResumeResult
    : null;
  const coverLetterOut = coverLetterResult.status === "fulfilled"
    ? coverLetterResult.value as CoverLetterResult
    : null;
  const emailOut = emailResult.status === "fulfilled"
    ? emailResult.value as EmailResult
    : null;

  res.json({
    synthetic_job: syntheticJob,
    scoring,
    structural_read: structuralRead,
    resume: resumeOut ?? { error: resumeResult.status === "rejected" ? (resumeResult.reason as Error).message : "Failed" },
    cover_letter: coverLetterOut ?? { error: coverLetterResult.status === "rejected" ? (coverLetterResult.reason as Error).message : "Failed" },
    outreach_email: emailOut ?? { error: emailResult.status === "rejected" ? (emailResult.reason as Error).message : "Failed" },
  });
}

// ─── POST /api/package/download/resume ────────────────────────────

export async function downloadResumeHandler(req: Request, res: Response): Promise<void> {
  const { structured, company } = req.body as {
    structured?: unknown;
    company?: unknown;
  };

  if (!structured || typeof structured !== "object") {
    res.status(400).json({ error: "structured is required" });
    return;
  }

  try {
    const buffer = await renderResumeDocx(structured as ResumeStructured);
    const co = typeof company === "string" && company.trim() ? sanitizeFilename(company.trim()) : "Company";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="Andrew_Shipley_Resume_${co}.docx"`);
    res.send(buffer);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Resume docx generation failed", detail });
  }
}

// ─── POST /api/package/download/cover-letter ──────────────────────

export async function downloadCoverLetterHandler(req: Request, res: Response): Promise<void> {
  const { structured, company } = req.body as {
    structured?: unknown;
    company?: unknown;
  };

  if (!structured || typeof structured !== "object") {
    res.status(400).json({ error: "structured is required" });
    return;
  }

  try {
    const buffer = await renderCoverLetterDocx(structured as CoverLetterStructured);
    const co = typeof company === "string" && company.trim() ? sanitizeFilename(company.trim()) : "Company";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="Andrew_Shipley_Cover_Letter_${co}.docx"`);
    res.send(buffer);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Cover letter docx generation failed", detail });
  }
}
