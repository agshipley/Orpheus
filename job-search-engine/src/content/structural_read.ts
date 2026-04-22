import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { JobListing, StructuralRead, Config } from "../types.js";
import type { JobScore } from "../conductor/ranker.js";

function readPositioningContext(): string {
  const path = join(process.cwd(), "POSITIONING.md");
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return "";
  return content;
}

const SYSTEM_PROMPT = `You are reading a job posting on behalf of Andrew Shipley and producing a diagnostic evaluator read — not an enthusiastic pitch, not a cautious warning. Andrew's arc: Rhodes Scholar / Oxford DPhil Experimental Psychology (3 peer-reviewed publications, named collaborators John T. Jost NYU and William H. Dutton OII) / Yale JD / Gunderson Dettmer VC law / co-founding partner boutique startup law firm (100+ startups, $250M+ transactions) / Chief of Staff to quantum computing CEO (promoted from outside counsel) / Director of Operations Series A AI infrastructure (10x ARR, SOC II, ARIA safety grant) / five shipped production AI systems as a hobby including two deployed for named clients.

Andrew evaluates roles from an evaluator's position, not an applicant's. Your read should:
1. Name what the company is actually hiring for — the underlying capability gap, not the title.
2. Explain which of the four identities (operator, legal, research, applied_ai_operator) best addresses the gap and why.
3. State the asymmetry clearly: is this a role where this profile is the unlock, or a role where Andrew is one of many qualified candidates, or a role where the profile is a poor fit for specific reasons.
4. Give a single should_pursue_signal: strong, moderate, or weak — and briefly say why.

Be direct. Do not hedge. Do not flatter. If the role is a poor fit, say so and why. If the role is a strong fit, say so and why. The goal is accurate decision support, not motivation.

Respond ONLY with valid JSON matching this exact shape (no markdown, no fences, no commentary):
{
  "company_problem": "string (2-3 sentences)",
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
  config: Config
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
