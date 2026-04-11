/**
 * Resume Tailor — AI-powered resume customization engine.
 *
 * Takes a base resume and a target job listing, then produces a
 * tailored version that emphasizes relevant experience, mirrors
 * the job's language, and highlights matching skills.
 *
 * Design:
 * - Multi-pass approach: analyze → strategize → generate → review
 * - Produces multiple variants with different emphasis strategies
 * - Full observability: every decision is logged with reasoning
 */

import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { getTracer, getMetrics, getDecisionLog } from "../observability/index.js";
import type {
  UserProfile,
  JobListing,
  ContentResult,
  ContentVariant,
} from "../types.js";

interface TailoringStrategy {
  name: string;
  emphasis: string;
  skillsToHighlight: string[];
  experienceToFeature: string[];
  toneGuidance: string;
}

export class ResumeTailor {
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
   * Generate tailored resume variants for a specific job.
   */
  async tailor(
    profile: UserProfile,
    job: JobListing,
    variantCount: number = 2
  ): Promise<ContentResult> {
    const rootSpan = this.tracer.startTrace("content.resume.tailor");
    rootSpan.setAttributes({
      "job.id": job.id,
      "job.title": job.title,
      "job.company": job.company,
      "variants.requested": variantCount,
    });

    const startTime = performance.now();
    let totalTokens = 0;

    try {
      // ── Pass 1: Analyze the job and identify key requirements ──
      const analysis = await this.tracer.traced(
        "content.resume.analyze",
        rootSpan,
        async (span) => {
          const result = await this.analyzeJob(job, profile);
          span.setAttribute("skills_matched", result.matchedSkills.length);
          span.setAttribute("skills_missing", result.missingSkills.length);
          totalTokens += result.tokensUsed;
          return result;
        }
      );

      // ── Pass 2: Generate tailoring strategies ─────────────────
      const strategies = await this.tracer.traced(
        "content.resume.strategize",
        rootSpan,
        async (span) => {
          const result = await this.generateStrategies(
            profile,
            job,
            analysis,
            variantCount
          );
          span.setAttribute("strategies_generated", result.strategies.length);
          totalTokens += result.tokensUsed;

          this.decisionLog.logDecision({
            traceId: rootSpan.traceId,
            component: "resume_tailor.strategize",
            decision: `Generated ${result.strategies.length} tailoring strategies`,
            reasoning: result.strategies
              .map((s) => `${s.name}: ${s.emphasis}`)
              .join("; "),
            inputs: {
              matchedSkills: analysis.matchedSkills,
              missingSkills: analysis.missingSkills,
            },
            output: result.strategies.map((s) => s.name),
            alternatives: result.strategies.map((s, i) => ({
              option: s.name,
              score: 1 - i * 0.1,
              reason: s.emphasis,
            })),
          });

          return result.strategies;
        }
      );

      // ── Pass 3: Generate resume variants ──────────────────────
      const variants: ContentVariant[] = [];

      for (const strategy of strategies) {
        const variant = await this.tracer.traced(
          `content.resume.generate.${strategy.name}`,
          rootSpan,
          async (span) => {
            const result = await this.generateVariant(
              profile,
              job,
              strategy
            );
            span.setAttribute("content_length", result.content.length);
            totalTokens += result.tokensUsed;
            return result;
          }
        );

        variants.push({
          id: nanoid(8),
          content: variant.content,
          strategy: strategy.name,
          confidence: variant.confidence,
        });
      }

      const durationMs = Math.round(performance.now() - startTime);
      rootSpan.setAttribute("duration_ms", durationMs);
      rootSpan.setAttribute("total_tokens", totalTokens);
      rootSpan.end();

      this.metrics.increment("orpheus_content_generations_total", {
        type: "resume",
      });

      const costUsd = this.estimateCost(totalTokens);
      this.decisionLog.logCost({
        traceId: rootSpan.traceId,
        model: this.model,
        inputTokens: Math.round(totalTokens * 0.7),
        outputTokens: Math.round(totalTokens * 0.3),
        costUsd,
        component: "resume_tailor",
        timestamp: new Date().toISOString(),
      });

      return {
        type: "resume",
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

  // ─── Analysis Pass ────────────────────────────────────────────

  private async analyzeJob(
    job: JobListing,
    profile: UserProfile
  ): Promise<{
    matchedSkills: string[];
    missingSkills: string[];
    keyPhrases: string[];
    companyCulture: string;
    tokensUsed: number;
  }> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1500,
      system: `You analyze job descriptions to extract key requirements. Respond with JSON only, no markdown fences.`,
      messages: [
        {
          role: "user",
          content: `Analyze this job listing against the candidate's skills.

Job: ${job.title} at ${job.company}
Description: ${job.description}

Candidate Skills: ${profile.skills.join(", ")}
Candidate Experience: ${profile.experience.map((e) => `${e.title} at ${e.company}`).join("; ")}

Return JSON:
{
  "matchedSkills": ["skills the candidate has that match"],
  "missingSkills": ["skills the job wants that the candidate lacks"],
  "keyPhrases": ["important phrases/keywords from the listing"],
  "companyCulture": "brief culture/values assessment"
}`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    parsed.tokensUsed =
      (response.usage?.input_tokens ?? 0) +
      (response.usage?.output_tokens ?? 0);

    return parsed;
  }

  // ─── Strategy Generation ──────────────────────────────────────

  private async generateStrategies(
    profile: UserProfile,
    job: JobListing,
    analysis: { matchedSkills: string[]; missingSkills: string[]; keyPhrases: string[] },
    count: number
  ): Promise<{ strategies: TailoringStrategy[]; tokensUsed: number }> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      system: `You are a resume strategy expert. Generate ${count} distinct resume tailoring strategies. Each strategy should take a different angle on presenting the candidate. Respond with JSON only.`,
      messages: [
        {
          role: "user",
          content: `Generate ${count} tailoring strategies for this candidate/job combo.

Target Role: ${job.title} at ${job.company}
Matched Skills: ${analysis.matchedSkills.join(", ")}
Missing Skills: ${analysis.missingSkills.join(", ")}
Key Phrases: ${analysis.keyPhrases.join(", ")}
Candidate Background: ${profile.summary ?? "Not provided"}

Return JSON array:
[{
  "name": "strategy_name",
  "emphasis": "what this strategy emphasizes",
  "skillsToHighlight": ["skills to feature prominently"],
  "experienceToFeature": ["which experiences to lead with"],
  "toneGuidance": "tone and voice guidance"
}]`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const strategies = JSON.parse(text.replace(/```json|```/g, "").trim());
    const tokensUsed =
      (response.usage?.input_tokens ?? 0) +
      (response.usage?.output_tokens ?? 0);

    return { strategies, tokensUsed };
  }

  // ─── Variant Generation ───────────────────────────────────────

  private async generateVariant(
    profile: UserProfile,
    job: JobListing,
    strategy: TailoringStrategy
  ): Promise<{ content: string; confidence: number; tokensUsed: number }> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      system: `You are an expert resume writer. Generate a tailored resume following the given strategy. Output the resume in clean markdown format. After the resume, add a JSON block with your confidence score.`,
      messages: [
        {
          role: "user",
          content: `Write a tailored resume using this strategy:

Strategy: ${strategy.name}
Emphasis: ${strategy.emphasis}
Skills to Highlight: ${strategy.skillsToHighlight.join(", ")}
Experience to Feature: ${strategy.experienceToFeature.join(", ")}
Tone: ${strategy.toneGuidance}

Candidate Profile:
Name: ${profile.name}
Summary: ${profile.summary ?? ""}
Skills: ${profile.skills.join(", ")}
Experience:
${profile.experience.map((e) => `- ${e.title} at ${e.company} (${e.startDate} - ${e.endDate ?? "Present"})\n  ${e.description}\n  Highlights: ${e.highlights.join("; ")}`).join("\n")}

Education:
${profile.education.map((e) => `- ${e.degree} in ${e.field ?? "N/A"}, ${e.institution}`).join("\n")}

Target Job: ${job.title} at ${job.company}
Job Description: ${job.description.slice(0, 2000)}

Output the resume in markdown, then on a new line output: CONFIDENCE: <0-1 score>`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Extract confidence score
    const confidenceMatch = text.match(/CONFIDENCE:\s*([\d.]+)/);
    const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.7;

    // Remove the confidence line from content
    const content = text.replace(/CONFIDENCE:.*$/m, "").trim();

    const tokensUsed =
      (response.usage?.input_tokens ?? 0) +
      (response.usage?.output_tokens ?? 0);

    return { content, confidence, tokensUsed };
  }

  private estimateCost(tokens: number): number {
    return (tokens / 1_000_000) * 3.0;
  }
}
