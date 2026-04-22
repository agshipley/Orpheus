import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { JobListing, StructuralRead, Config } from "../types.js";
import type { JobScore } from "../conductor/ranker.js";
import type { ReaderFrame } from "./reader_frame.js";

function readPositioningContext(): string {
  const path = join(process.cwd(), "POSITIONING.md");
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return "";
  return content;
}

const SYSTEM_PROMPT = `You are producing a diagnostic evaluator read on a job posting for Andrew Shipley. The reader-frame for this role has already been inferred and is provided as context. Your diagnostic must be written in terms that make sense for that reader-frame — do not describe a mission-motive organization's hiring problem in market-motive terms, and do not describe a profit-motive organization's hiring problem in mission-motive terms.

Andrew's arc: Rhodes Scholar / Oxford DPhil Experimental Psychology (3 peer-reviewed publications, named collaborators John T. Jost NYU and William H. Dutton OII) / Yale JD / Gunderson Dettmer VC law / co-founding partner boutique startup law firm (100+ startups, $250M+ transactions) / Chief of Staff to quantum computing CEO (promoted from outside counsel) / Director of Operations Series A AI infrastructure (10x ARR, SOC II, ARIA safety grant) / five shipped production AI systems as a hobby including two deployed for named clients.

Name:
1. What this organization is actually trying to accomplish (in their frame's vocabulary)
2. The specific capability gap this role is designed to close (in their frame's vocabulary)
3. Whether Andrew's profile addresses that gap directly, partially, or poorly — and why
4. The asymmetry read: is this a role where his profile is the unlock, one-of-many, or a miscategorization given his seniority/trajectory
5. A should_pursue_signal: strong, moderate, or weak — with one sentence of rationale

Do not default to evaluator-posture vocabulary. Do not hedge. The goal is accurate decision support written in the reader's own terms.

Respond ONLY with valid JSON (no markdown, no fences, no commentary):
{
  "company_problem": "string (2-3 sentences in reader's vocabulary)",
  "identity_rationale": "string (2-3 sentences)",
  "asymmetry_summary": "string (2-3 sentences)",
  "should_pursue_signal": "strong" | "moderate" | "weak",
  "signal_rationale": "string (1-2 sentences)"
}`;

const FALLBACK: StructuralRead = {
  company_problem: "Structural read unavailable.",
  identity_rationale: "Structural read unavailable.",
  asymmetry_summary: "Structural read unavailable.",
  should_pursue_signal: "moderate",
  signal_rationale: "Structural read parse failed; review materials manually.",
};

export async function generateStructuralRead(
  job: JobListing,
  scoring: JobScore,
  config: Config,
  frame?: ReaderFrame
): Promise<StructuralRead> {
  const client = new Anthropic();
  const model = config.content.model ?? "claude-sonnet-4-6";

  const positioningGuidance = readPositioningContext();

  const identityScoresSummary = Object.entries(scoring.identityScores)
    .map(([k, v]) => `${k}: ${v.score} pts (${v.reasons.slice(0, 3).join("; ")})`)
    .join("\n");

  const userMessage = JSON.stringify({
    role_title: job.title,
    company: job.company,
    location: job.location,
    description: job.description.slice(0, 3000),
    scoring: {
      winning_identity: scoring.matchedIdentity,
      compound_fit: scoring.compound_fit,
      identity_scores: identityScoresSummary,
    },
    reader_frame: frame ?? null,
    positioning_guidance: positioningGuidance.slice(0, 2000),
  });

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    const parsed = JSON.parse(text) as Partial<StructuralRead>;

    const signal = parsed.should_pursue_signal;
    if (signal !== "strong" && signal !== "moderate" && signal !== "weak") {
      return FALLBACK;
    }

    return {
      company_problem: parsed.company_problem ?? FALLBACK.company_problem,
      identity_rationale: parsed.identity_rationale ?? FALLBACK.identity_rationale,
      asymmetry_summary: parsed.asymmetry_summary ?? FALLBACK.asymmetry_summary,
      should_pursue_signal: signal,
      signal_rationale: parsed.signal_rationale ?? FALLBACK.signal_rationale,
    };
  } catch {
    return FALLBACK;
  }
}
