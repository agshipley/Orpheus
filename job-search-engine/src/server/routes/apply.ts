import type { Request, Response } from "express";
import { ResumeTailor, CoverLetterGenerator, EmailDrafter } from "../../content/index.js";
import { JobStore } from "../../storage/job_store.js";
import { loadConfig } from "../config.js";

type ContentType = "resume" | "cover_letter" | "email";

/**
 * POST /api/apply
 * Body: { jobId: string, types: ContentType[], tone?: string, variants?: number }
 *
 * Generates the requested application materials for a stored job.
 */
export async function applyHandler(req: Request, res: Response): Promise<void> {
  const { jobId, types, tone = "conversational", variants = 2 } =
    req.body as {
      jobId?: unknown;
      types?: unknown;
      tone?: string;
      variants?: number;
    };

  if (typeof jobId !== "string" || !jobId.trim()) {
    res.status(400).json({ error: "jobId must be a non-empty string" });
    return;
  }

  if (!Array.isArray(types) || types.length === 0) {
    res.status(400).json({ error: "types must be a non-empty array of: resume, cover_letter, email" });
    return;
  }

  const validTypes = new Set<ContentType>(["resume", "cover_letter", "email"]);
  const invalid = (types as unknown[]).filter((t) => !validTypes.has(t as ContentType));
  if (invalid.length) {
    res.status(400).json({ error: `Unknown type(s): ${invalid.join(", ")}` });
    return;
  }

  const config = loadConfig();
  const store = new JobStore(config.storage.dbPath);

  try {
    const job = store.getById(jobId);
    if (!job) {
      res.status(404).json({ error: `Job not found: ${jobId}` });
      return;
    }

    const profile = config.profile;
    const model = config.content.model;
    const numVariants = Math.min(5, Math.max(1, Number(variants)));
    const result: Record<string, unknown> = { jobId, job };

    for (const type of types as ContentType[]) {
      if (type === "resume") {
        const tailor = new ResumeTailor(model);
        result.resume = await tailor.tailor(profile, job, numVariants);
      } else if (type === "cover_letter") {
        const generator = new CoverLetterGenerator(model);
        result.coverLetter = await generator.generate(profile, job, {
          tone: tone as "formal" | "conversational" | "enthusiastic" | "concise",
        });
      } else if (type === "email") {
        const drafter = new EmailDrafter(model);
        result.email = await drafter.draft(profile, job, { type: "cold_outreach" }, numVariants);
      }
    }

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Content generation failed", detail: message });
  } finally {
    store.close();
  }
}
