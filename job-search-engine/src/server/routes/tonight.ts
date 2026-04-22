/**
 * GET /api/tonight
 *
 * Live fan-out across all 6 sources, full 4-identity scoring, asymmetry +
 * compound-fit filter, top 5 picks. Each pick gets a 2-3 sentence
 * "why this specifically" paragraph synthesised from scores by Claude.
 *
 * Cost: up to 5 × claude-sonnet-4-6 calls at ≤300 output tokens ≈ $0.003/request.
 * Endpoint is unauthenticated — same exposure as /api/apply.
 */

import type { Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { Conductor } from "../../conductor/conductor.js";
import type { TonightPick } from "../../conductor/conductor.js";
import { inferReaderFrame } from "../../content/reader_frame.js";
import type { ReaderFrame } from "../../content/reader_frame.js";
import { loadConfig } from "../config.js";

const SYSTEM_PROMPT = `You are writing a 2-3 sentence "why this role specifically" paragraph for Andrew Shipley, who evaluates job opportunities from an evaluator's position — not an applicant's.

Andrew's arc: Rhodes Scholar / Oxford DPhil Experimental Psychology (3 peer-reviewed publications, named collaborators John T. Jost NYU and William H. Dutton OII) / Yale JD / Gunderson Dettmer VC law / co-founding partner boutique startup law firm (100+ startups, $250M+ transactions) / Chief of Staff to quantum computing CEO (promoted from outside counsel) / Director of Operations Series A AI infrastructure (10x ARR, SOC II, ARIA safety grant) / five shipped production AI systems as a hobby including an autonomous multi-agent intelligence system.

The Rhodes pre-licenses the evaluator register. Write from "this organization has a named gap that this specific combination resolves" — not "he is qualified for this." Name the structural fit: which identity wins and why, what the company gap is, why this profile combination is rare. Specific beats generic. Do not hedge. 2-3 sentences maximum. No bullet points.

A reader-frame may be provided. If so, use the reader's vocabulary — not generic evaluator vocabulary. A profit-motive reader runs AUM and process velocity questions; a mission-motive reader runs outcome and stewardship questions; a thesis-motive reader runs deal flow and portfolio construction questions. Match the register to the frame. If no frame is provided, default to market-motive register.`;

function buildFallbackParagraph(pick: TonightPick): string {
  const job = pick.job;
  const identityLabels: Record<string, string> = {
    operator:            "operator/Chief-of-Staff",
    legal:               "legal/GC",
    research:            "research/policy",
    applied_ai_operator: "applied AI operator",
  };
  const label = identityLabels[job.matchedIdentity ?? "operator"] ?? "operator";
  const score = Math.round((job.matchScore ?? 0) * 100);
  const parts: string[] = [
    `${job.company}'s ${job.title} is a ${score}% match on the ${label} identity.`,
  ];
  if ((job.compound_fit ?? 0) >= 2) {
    parts.push(`The role fires across ${job.compound_fit} identities — breadth uncommon in a single posting.`);
  }
  if (job.asymmetry_fit === "high") {
    parts.push("Asymmetry signals indicate a structural gap this profile specifically addresses.");
  }
  return parts.join(" ");
}

async function generateWhyParagraph(
  client: Anthropic,
  model: string,
  pick: TonightPick,
  frame?: ReaderFrame
): Promise<string> {
  const { job, identityScores } = pick;
  const descSnippet = job.description.slice(0, 500).replace(/\s+/g, " ");

  const userMessage = JSON.stringify({
    role: job.title,
    company: job.company,
    location: job.location || "unspecified",
    description_excerpt: descSnippet,
    winning_identity: job.matchedIdentity,
    identity_scores: identityScores,
    compound_fit: job.compound_fit ?? 0,
    asymmetry_fit: job.asymmetry_fit ?? "none",
    score_reasons: job.identityReasons?.[job.matchedIdentity ?? "operator"] ?? [],
    github_signal_hits: pick.github_signal_hits,
    reader_frame: frame
      ? {
          primary: frame.primary,
          secondary: frame.secondary ?? null,
          reader_role_guess: frame.reader_role_guess,
          reader_concerns: frame.reader_concerns,
          reader_vocabulary: frame.reader_vocabulary,
          anti_vocabulary: frame.anti_vocabulary,
        }
      : null,
  });

  const response = await client.messages.create({
    model,
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function tonightHandler(_req: Request, res: Response): Promise<void> {
  try {
    const config = loadConfig();
    const conductor = new Conductor(config);
    const { picks, stats, mode } = await conductor.searchTonight();

    const client = new Anthropic();
    const model = config.content.model;

    const enrichedPicks = await Promise.all(
      picks.map(async (pick) => {
        const frame = await inferReaderFrame({
          company: pick.job.company,
          title: pick.job.title,
          description: pick.job.description,
          config,
        }).catch(() => undefined);

        let why_paragraph: string;
        try {
          why_paragraph = await generateWhyParagraph(client, model, pick, frame);
        } catch {
          why_paragraph = buildFallbackParagraph(pick);
        }
        return { ...pick, why_paragraph, reader_frame: frame ?? null };
      })
    );

    let corpus_note: string | undefined;
    if (mode === "best_available") {
      corpus_note = `No asymmetry-flagged or compound-fit results found. Showing top ${enrichedPicks.length} by raw score. More will surface as sources warm up and feedback data accumulates.`;
    } else if (mode === "curated" && enrichedPicks.length < 5) {
      corpus_note = `Corpus limited — ${enrichedPicks.length} asymmetry-flagged or compound-fit result${enrichedPicks.length !== 1 ? "s" : ""} from tonight's search. More will surface as sources warm up.`;
    } else if (mode === "empty") {
      corpus_note = "No results from tonight's search. Try refreshing in a few minutes.";
    }

    res.json({
      picks: enrichedPicks,
      meta: {
        date: new Date().toISOString().slice(0, 10),
        query: "Head of Applied AI / Chief of Staff AI / Director of AI / Applied AI Lead / Strategic Initiatives",
        agentsQueried: stats.agentsQueried,
        agentsSucceeded: stats.agentsSucceeded,
        rawResults: stats.rawResults,
        afterDedup: stats.afterDedup,
        durationMs: stats.durationMs,
        mode,
        corpus_note,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Tonight search failed", detail: message });
  }
}
