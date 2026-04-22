import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../types.js";

export type MotiveFrame = "profit" | "thesis" | "market" | "mission" | "craft" | "service";

export interface ReaderFrame {
  primary: MotiveFrame;
  secondary?: MotiveFrame | null;
  reader_role_guess: string;
  reader_concerns: string[];
  reader_vocabulary: string[];
  frame_rationale: string;
  anti_vocabulary: string[];
}

const FALLBACK: ReaderFrame = {
  primary: "market",
  secondary: null,
  reader_role_guess: "hiring manager",
  reader_concerns: [
    "will this candidate produce results",
    "will this candidate require supervision",
  ],
  reader_vocabulary: [],
  frame_rationale: "Reader-frame inference failed; market default applied.",
  anti_vocabulary: [],
};

const FRAME_DEFINITIONS = `
Profit-motive: Hedge funds, trading firms, private equity, proprietary trading, family offices operating as investment vehicles. Reader runs money and time questions nakedly. AUM, returns, process velocity, IR pipeline, reputation to LPs, bandwidth of the principal. Vocabulary: capital committed, deal closed, pipeline converted, operational leverage. Do not use "passion," "purpose," or "mission" — they disqualify.

Thesis-motive: Venture capital, growth equity, corporate VC, some strategic investors. Reader runs money questions wearing a thesis costume. Deal flow, winning competitive processes, portfolio velocity, fund-level narrative to LPs, thesis coherence. Vocabulary: conviction, wedge, asymmetric bet, portfolio construction, founder quality.

Market-motive: Operating companies across stages, most startups, commercial software, law firms as businesses, agencies, services businesses. Reader runs revenue and cost questions through a P&L frame. Customer acquisition, retention, margin, unit economics, operational leverage, competitive position, hiring leverage. Vocabulary: growth, efficiency, runway, burn, conversion, expansion.

Mission-motive: Foundations, policy organizations, advocacy groups, think tanks with named missions, some academic research institutions. Reader runs outcome and legitimacy questions. Program quality, grantee success, intellectual contribution, field-building, institutional trust, the organization's theory of change. Money is instrumental here, not the thing. Vocabulary: outcomes, evidence, field, grantees, program, theory of change, stewardship.

Craft-motive: Universities, presses, museums, editorial institutions, research organizations whose purpose is the work itself. Reader runs quality and reputation questions. Work that would not otherwise exist, standards that would not otherwise be held, the institution's reputation in its field, intellectual continuity. Vocabulary: standards, judgment, field, scholarship, editorial, program, rigor.

Service-motive: Direct-service nonprofits, clinics, community organizations, some government agencies. Reader runs capacity and effectiveness questions. People served, quality of service, staff sustainability, donor relationships as enabling infrastructure. Vocabulary: clients served, capacity, sustainability, community, program delivery, outcomes.
`.trim();

const SYSTEM_PROMPT = `You are inferring the organizational motive frame for a job posting. Your output will be used to calibrate the register and vocabulary of application materials. Read the posting and the organization's likely public footprint. Classify into one of six frames: profit, thesis, market, mission, craft, service.

Frame definitions:
${FRAME_DEFINITIONS}

Identify:
- primary frame (required — one of the six above)
- secondary frame (only if genuinely load-bearing, otherwise null)
- likely reader role (one phrase — who is reading this letter, e.g. "Managing Partner", "Program Officer", "CEO", "Executive Director")
- 3-5 specific concerns this reader is running in their head right now
- 6-12 terms in the reader's own vocabulary
- 2-3 sentence rationale for the classification
- 2-5 anti-vocabulary terms — words that would signal category error to this reader

Return ONLY a JSON object. No preamble, no explanation. Shape:
{
  "primary": "profit"|"thesis"|"market"|"mission"|"craft"|"service",
  "secondary": "profit"|"thesis"|"market"|"mission"|"craft"|"service"|null,
  "reader_role_guess": "string",
  "reader_concerns": ["string", ...],
  "reader_vocabulary": ["string", ...],
  "frame_rationale": "string",
  "anti_vocabulary": ["string", ...]
}`;

export async function inferReaderFrame(params: {
  company: string;
  title: string;
  description: string;
  config: Config;
}): Promise<ReaderFrame> {
  const { company, title, description, config } = params;
  const client = new Anthropic();
  const model = config.content.model ?? "claude-sonnet-4-6";

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            company,
            title,
            description: description.slice(0, 2500),
          }),
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    const parsed = JSON.parse(text) as Partial<ReaderFrame>;

    const validFrames: MotiveFrame[] = ["profit", "thesis", "market", "mission", "craft", "service"];
    const primary = validFrames.includes(parsed.primary as MotiveFrame)
      ? (parsed.primary as MotiveFrame)
      : FALLBACK.primary;
    const secondary = parsed.secondary && validFrames.includes(parsed.secondary as MotiveFrame)
      ? (parsed.secondary as MotiveFrame)
      : null;

    return {
      primary,
      secondary,
      reader_role_guess: typeof parsed.reader_role_guess === "string" && parsed.reader_role_guess
        ? parsed.reader_role_guess
        : FALLBACK.reader_role_guess,
      reader_concerns: Array.isArray(parsed.reader_concerns)
        ? (parsed.reader_concerns as string[])
        : FALLBACK.reader_concerns,
      reader_vocabulary: Array.isArray(parsed.reader_vocabulary)
        ? (parsed.reader_vocabulary as string[])
        : [],
      frame_rationale: typeof parsed.frame_rationale === "string" && parsed.frame_rationale
        ? parsed.frame_rationale
        : FALLBACK.frame_rationale,
      anti_vocabulary: Array.isArray(parsed.anti_vocabulary)
        ? (parsed.anti_vocabulary as string[])
        : [],
    };
  } catch {
    console.warn("[reader_frame] inferReaderFrame failed — using market default");
    return FALLBACK;
  }
}
