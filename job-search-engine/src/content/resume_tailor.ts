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
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getTracer, getMetrics, getDecisionLog } from "../observability/index.js";
import type {
  UserProfile,
  JobListing,
  ContentResult,
  ContentVariant,
  IdentityKey,
  Config,
} from "../types.js";

type GithubSignalEntry = NonNullable<Config["github_signal"]>[number];

function readPositioningContext(): string {
  const path = join(process.cwd(), "POSITIONING.md");
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return "";
  return `\n\nCANDIDATE POSITIONING CONTEXT (read before writing — this defines the posture):\n${content}`;
}

const EVALUATOR_POSTURE = `
CANDIDATE POSTURE — THIS IS NON-NEGOTIABLE:
This candidate is evaluating whether this opportunity is worth his time — not applying for it. Write from that posture throughout.
- Open the resume summary (if present) with a sharp statement of the candidate's operating shape and the problem type he solves, not with "experienced professional" or similar
- Emphasize shipped systems by name (first-agent, charlie, mrkt, NLSAFE, Orpheus) when relevant to the role
- Use declarative framing: "ships production AI systems," "deployed for named clients," "builds systems that named businesses use daily"
- Never use: "excited to apply," "would love to," "grateful for the opportunity," "passionate about," "results-driven"`.trim();

function buildGithubSignalContext(
  identity: IdentityKey | undefined,
  githubSignal?: GithubSignalEntry[]
): string {
  if (!identity || !githubSignal || githubSignal.length === 0) return "";
  const relevant = githubSignal.filter((e) => e.identity_boosts.includes(identity));
  if (relevant.length === 0) return "";
  const list = relevant.map((e) => `- **${e.name}**: ${e.summary}`).join("\n");
  return `\n\nRelevant personal projects to reference authentically when the role context warrants it. Do not force citations. Cite by name and the specific aspect that matches the role.\n${list}`;
}

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

  private buildIdentityContext(profile: UserProfile, identity?: IdentityKey): string {
    if (!identity || !profile.identities) return "";
    const cfg = profile.identities[identity];
    if (!cfg) return "";
    const lines: string[] = [];
    if (cfg.positioning_guidance) lines.push(`IDENTITY POSITIONING:\n${cfg.positioning_guidance.trim()}`);
    if (cfg.resume_emphasis)      lines.push(`RESUME EMPHASIS:\n${cfg.resume_emphasis.trim()}`);
    if (cfg.key_credentials?.length) lines.push(`KEY CREDENTIALS TO HIGHLIGHT: ${cfg.key_credentials.join(", ")}`);
    return lines.length ? `\n\n${lines.join("\n\n")}` : "";
  }

  /**
   * Generate tailored resume variants for a specific job.
   */
  async tailor(
    profile: UserProfile,
    job: JobListing,
    variantCount: number = 2,
    identity?: IdentityKey,
    githubSignal?: GithubSignalEntry[]
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
              strategy,
              identity,
              githubSignal
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
    return lines.length ? `\n\n${lines.join("\n\n")}` : "";
  }

  private async generateVariant(
    profile: UserProfile,
    job: JobListing,
    strategy: TailoringStrategy,
    identity?: IdentityKey,
    githubSignal?: GithubSignalEntry[]
  ): Promise<{ content: string; confidence: number; tokensUsed: number }> {
    const voiceContext = this.buildVoiceContext(profile);
    const identityContext = this.buildIdentityContext(profile, identity);
    const githubContext = buildGithubSignalContext(identity, githubSignal);

    const positioningContext = readPositioningContext();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      system: `You are an expert resume writer. Generate a tailored resume following the given strategy. Output the resume in clean markdown format. After the resume, add a JSON block with your confidence score.\n\n${EVALUATOR_POSTURE}${positioningContext}${voiceContext}${identityContext}${githubContext}`,
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
${profile.projects?.length ? `\nProjects:\n${profile.projects.map((p) => `- ${p.name}: ${p.description}${p.role ? ` (${p.role})` : ""}`).join("\n")}` : ""}
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
