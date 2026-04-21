/**
 * Email Drafter — Generates outreach and follow-up emails.
 *
 * Supports:
 * - Cold outreach to hiring managers
 * - Follow-up after application submission
 * - Thank-you notes after interviews
 * - Networking connection requests
 */

import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { getTracer, getMetrics } from "../observability/index.js";
import type {
  UserProfile,
  JobListing,
  ContentResult,
  ContentVariant,
  IdentityKey,
} from "../types.js";

type EmailType = "cold_outreach" | "follow_up" | "thank_you" | "networking";

interface EmailContext {
  type: EmailType;
  recipientName?: string;
  recipientTitle?: string;
  daysSinceApplication?: number;
  interviewDetails?: string;
  connectionContext?: string;
}

export class EmailDrafter {
  private client: Anthropic;
  private model: string;
  private tracer = getTracer();
  private metrics = getMetrics();

  constructor(model: string = "claude-sonnet-4-20250514") {
    this.client = new Anthropic();
    this.model = model;
  }

  async draft(
    profile: UserProfile,
    job: JobListing,
    context: EmailContext,
    variants: number = 2,
    identity?: IdentityKey
  ): Promise<ContentResult> {
    const rootSpan = this.tracer.startTrace("content.email.draft");
    rootSpan.setAttributes({
      "email.type": context.type,
      "job.company": job.company,
      "variants": variants,
    });

    const startTime = performance.now();
    let totalTokens = 0;

    try {
      const tones = this.getTonesForType(context.type).slice(0, variants);
      const generatedVariants: ContentVariant[] = [];

      for (const tone of tones) {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 1500,
          system: this.getSystemPrompt(context.type, tone) + this.buildIdentityContext(profile, identity),
          messages: [
            {
              role: "user",
              content: this.buildPrompt(profile, job, context),
            },
          ],
        });

        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");

        totalTokens +=
          (response.usage?.input_tokens ?? 0) +
          (response.usage?.output_tokens ?? 0);

        const confidenceMatch = text.match(/CONFIDENCE:\s*([\d.]+)/);
        const confidence = confidenceMatch
          ? parseFloat(confidenceMatch[1])
          : 0.75;

        generatedVariants.push({
          id: nanoid(8),
          content: text.replace(/CONFIDENCE:.*$/m, "").trim(),
          strategy: tone,
          confidence,
        });
      }

      const durationMs = Math.round(performance.now() - startTime);
      rootSpan.end();

      this.metrics.increment("orpheus_content_generations_total", {
        type: "email",
      });

      return {
        type: "outreach_email",
        variants: generatedVariants.sort((a, b) => b.confidence - a.confidence),
        metadata: {
          model: this.model,
          tokensUsed: totalTokens,
          generationTimeMs: durationMs,
          costUsd: (totalTokens / 1_000_000) * 3.0,
        },
      };
    } catch (error) {
      rootSpan.setError(error instanceof Error ? error.message : String(error));
      rootSpan.end();
      throw error;
    }
  }

  private getTonesForType(type: EmailType): string[] {
    switch (type) {
      case "cold_outreach":
        return ["warm-professional", "direct-and-confident", "curious-and-humble"];
      case "follow_up":
        return ["polite-persistence", "add-value"];
      case "thank_you":
        return ["genuine-gratitude", "reflective"];
      case "networking":
        return ["peer-to-peer", "mentorship-seeking"];
    }
  }

  private getSystemPrompt(type: EmailType, tone: string): string {
    const base = `You write concise, effective ${type.replace(/_/g, " ")} emails. Tone: ${tone}. Keep emails under 200 words. Include a subject line prefixed with "Subject: ". End with CONFIDENCE: <0-1>.`;

    const guidance: Record<EmailType, string> = {
      cold_outreach:
        "Never start with 'I hope this email finds you well.' Lead with something specific about their work or company. Make the ask clear and easy to say yes to.",
      follow_up:
        "Reference the original application date. Add new value (a relevant article, project update, or insight). Don't be apologetic for following up.",
      thank_you:
        "Reference a specific moment from the interview. Show you listened. Reinforce your fit with a new angle not covered in the interview.",
      networking:
        "Find genuine common ground. Be specific about what you admire in their work. Make the ask lightweight (15-min call, not a full meeting).",
    };

    return `${base}\n\n${guidance[type]}`;
  }

  private buildIdentityContext(profile: UserProfile, identity?: IdentityKey): string {
    if (!identity || !profile.identities) return "";
    const cfg = profile.identities[identity];
    if (!cfg) return "";
    const lines: string[] = [];
    if (cfg.positioning_guidance)    lines.push(`IDENTITY POSITIONING:\n${cfg.positioning_guidance.trim()}`);
    if (cfg.key_credentials?.length) lines.push(`KEY CREDENTIALS: ${cfg.key_credentials.join(", ")}`);
    return lines.length ? `\n\n${lines.join("\n\n")}` : "";
  }

  private buildVoiceContext(profile: UserProfile): string {
    const lines: string[] = [];
    if (profile.voice?.avoidPhrases?.length) {
      lines.push(`NEVER USE: ${profile.voice.avoidPhrases.join(", ")}`);
    }
    if (profile.voice?.signaturePhrases?.length) {
      lines.push(`PREFERRED PHRASES: ${profile.voice.signaturePhrases.join(", ")}`);
    }
    return lines.length ? `\n\n${lines.join("\n")}` : "";
  }

  private buildPrompt(
    profile: UserProfile,
    job: JobListing,
    context: EmailContext
  ): string {
    let prompt = `Write a ${context.type.replace(/_/g, " ")} email.

FROM: ${profile.name}
CURRENT ROLE: ${profile.experience[0]?.title ?? "N/A"} at ${profile.experience[0]?.company ?? "N/A"}
TARGET: ${job.title} at ${job.company}`;

    if (context.recipientName) {
      prompt += `\nTO: ${context.recipientName}${context.recipientTitle ? `, ${context.recipientTitle}` : ""}`;
    }

    if (context.daysSinceApplication) {
      prompt += `\nAPPLIED: ${context.daysSinceApplication} days ago`;
    }

    if (context.interviewDetails) {
      prompt += `\nINTERVIEW NOTES: ${context.interviewDetails}`;
    }

    if (context.connectionContext) {
      prompt += `\nCONNECTION: ${context.connectionContext}`;
    }

    prompt += `\n\nKEY STRENGTHS: ${profile.skills.slice(0, 8).join(", ")}`;
    prompt += this.buildVoiceContext(profile);

    return prompt;
  }
}
