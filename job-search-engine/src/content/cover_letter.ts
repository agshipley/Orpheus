/**
 * Cover Letter Generator — AI-powered cover letter creation.
 *
 * Generates tailored cover letters with different strategic approaches:
 * - "narrative": Tells a story connecting candidate's journey to the role
 * - "technical": Leads with technical achievements and capability proof
 * - "cultural": Emphasizes alignment with company mission and values
 *
 * Each variant is independently generated and scored for quality.
 */

import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { getTracer, getMetrics, getDecisionLog } from "../observability/index.js";
import type {
  UserProfile,
  JobListing,
  ContentResult,
  ContentVariant,
  ContentRequest,
} from "../types.js";

interface LetterStrategy {
  id: string;
  name: string;
  angle: string;
  openingHook: string;
  bodyFocus: string;
  closingStyle: string;
}

const DEFAULT_STRATEGIES: LetterStrategy[] = [
  {
    id: "narrative",
    name: "The Narrative Arc",
    angle: "Tell a compelling story that connects past experience to this specific role",
    openingHook: "Open with a specific moment or achievement that relates to the company's mission",
    bodyFocus: "Weave experience into a narrative showing natural progression toward this role",
    closingStyle: "Forward-looking: paint a picture of impact you'd make in the first 90 days",
  },
  {
    id: "technical",
    name: "The Technical Proof",
    angle: "Lead with quantified achievements and technical depth",
    openingHook: "Open with your most impressive, relevant technical achievement with numbers",
    bodyFocus: "Map your technical skills directly to their requirements, with evidence for each",
    closingStyle: "Concrete: propose a specific technical improvement or initiative you'd pursue",
  },
  {
    id: "cultural",
    name: "The Mission Alignment",
    angle: "Show deep understanding of the company and genuine enthusiasm for their mission",
    openingHook: "Open with insight about the company's work that shows you've done your homework",
    bodyFocus: "Connect your values and experience to their culture, team, and mission",
    closingStyle: "Authentic: share why this specific role at this specific company excites you",
  },
];

export class CoverLetterGenerator {
  private client: Anthropic;
  private model: string;
  private tracer = getTracer();
  private metrics = getMetrics();
  private decisionLog = getDecisionLog();

  constructor(model: string = "claude-sonnet-4-20250514") {
    this.client = new Anthropic();
    this.model = model;
  }

  /**
   * Generate cover letter variants for a job application.
   */
  async generate(
    profile: UserProfile,
    job: JobListing,
    options?: {
      tone?: ContentRequest["tone"];
      strategies?: string[];
      maxLength?: number;
    }
  ): Promise<ContentResult> {
    const rootSpan = this.tracer.startTrace("content.cover_letter.generate");
    rootSpan.setAttributes({
      "job.id": job.id,
      "job.title": job.title,
      "tone": options?.tone ?? "conversational",
    });

    const startTime = performance.now();
    let totalTokens = 0;

    try {
      // Select strategies
      const selectedStrategies = options?.strategies
        ? DEFAULT_STRATEGIES.filter((s) => options.strategies!.includes(s.id))
        : DEFAULT_STRATEGIES;

      const variants: ContentVariant[] = [];

      // Generate each variant in parallel
      const variantPromises = selectedStrategies.map(async (strategy) => {
        const result = await this.tracer.traced(
          `content.cover_letter.variant.${strategy.id}`,
          rootSpan,
          async (span) => {
            const variant = await this.generateVariant(
              profile,
              job,
              strategy,
              options?.tone ?? "conversational",
              options?.maxLength ?? 400
            );
            span.setAttributes({
              "strategy": strategy.id,
              "content_length": variant.content.length,
              "confidence": variant.confidence,
            });
            return variant;
          }
        );

        totalTokens += result.tokensUsed;

        return {
          id: nanoid(8),
          content: result.content,
          strategy: strategy.name,
          confidence: result.confidence,
        };
      });

      const results = await Promise.all(variantPromises);
      variants.push(...results);

      // Sort by confidence
      variants.sort((a, b) => b.confidence - a.confidence);

      const durationMs = Math.round(performance.now() - startTime);
      rootSpan.setAttribute("duration_ms", durationMs);
      rootSpan.end();

      this.metrics.increment("orpheus_content_generations_total", {
        type: "cover_letter",
      });

      this.decisionLog.logDecision({
        traceId: rootSpan.traceId,
        component: "cover_letter_generator",
        decision: `Generated ${variants.length} cover letter variants`,
        reasoning: `Best variant: "${variants[0]?.strategy}" (confidence: ${variants[0]?.confidence.toFixed(2)})`,
        inputs: { jobTitle: job.title, company: job.company },
        output: variants.map((v) => ({
          strategy: v.strategy,
          confidence: v.confidence,
        })),
        alternatives: variants.map((v) => ({
          option: v.strategy,
          score: v.confidence,
          reason: `${v.content.length} chars, confidence ${v.confidence.toFixed(2)}`,
        })),
      });

      const costUsd = this.estimateCost(totalTokens);

      return {
        type: "cover_letter",
        variants,
        metadata: {
          model: this.model,
          tokensUsed: totalTokens,
          generationTimeMs: durationMs,
          costUsd,
        },
      };
    } catch (error) {
      rootSpan.setError(error instanceof Error ? error.message : String(error));
      rootSpan.end();
      throw error;
    }
  }

  private buildVoiceContext(profile: UserProfile): string {
    const lines: string[] = [];
    if (profile.positioningGuidance) {
      lines.push(`POSITIONING GUIDANCE:\n${profile.positioningGuidance.trim()}`);
    }
    if (profile.voice?.avoidPhrases?.length) {
      lines.push(`NEVER USE THESE PHRASES: ${profile.voice.avoidPhrases.join(", ")}`);
    }
    if (profile.voice?.signaturePhrases?.length) {
      lines.push(`PREFERRED PHRASES (use naturally when they fit): ${profile.voice.signaturePhrases.join(", ")}`);
    }
    if (profile.voice?.tone) {
      lines.push(`VOICE/TONE: ${profile.voice.tone.trim()}`);
    }
    return lines.length ? `\n\n${lines.join("\n\n")}` : "";
  }

  private async generateVariant(
    profile: UserProfile,
    job: JobListing,
    strategy: LetterStrategy,
    tone: string,
    maxWords: number
  ): Promise<{ content: string; confidence: number; tokensUsed: number }> {
    const voiceContext = this.buildVoiceContext(profile);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 3000,
      system: `You are an expert cover letter writer. Write compelling, authentic cover letters that don't sound generic or AI-generated. Avoid clichés like "I am writing to express my interest" or "I would be a great fit." Every sentence should earn its place.

Strategy to follow:
- Name: ${strategy.name}
- Angle: ${strategy.angle}
- Opening: ${strategy.openingHook}
- Body Focus: ${strategy.bodyFocus}
- Closing: ${strategy.closingStyle}

Tone: ${tone}
Target length: ~${maxWords} words${voiceContext}

After the letter, on a new line write: CONFIDENCE: <0.0-1.0>`,
      messages: [
        {
          role: "user",
          content: `Write a cover letter for:

ROLE: ${job.title} at ${job.company}
LOCATION: ${job.location}${job.remote ? " (Remote)" : ""}
JOB DESCRIPTION:
${job.description.slice(0, 3000)}

CANDIDATE:
Name: ${profile.name}
Current/Recent Role: ${profile.experience[0]?.title ?? "N/A"} at ${profile.experience[0]?.company ?? "N/A"}
Key Skills: ${profile.skills.slice(0, 15).join(", ")}
Summary: ${profile.summary ?? "Not provided"}

Key Achievements:
${profile.experience
  .slice(0, 3)
  .flatMap((e) => e.highlights.slice(0, 2))
  .map((h) => `• ${h}`)
  .join("\n")}`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const confidenceMatch = text.match(/CONFIDENCE:\s*([\d.]+)/);
    const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.7;
    const content = text.replace(/CONFIDENCE:.*$/m, "").trim();

    return {
      content,
      confidence,
      tokensUsed:
        (response.usage?.input_tokens ?? 0) +
        (response.usage?.output_tokens ?? 0),
    };
  }

  private estimateCost(tokens: number): number {
    return (tokens / 1_000_000) * 3.0;
  }
}
