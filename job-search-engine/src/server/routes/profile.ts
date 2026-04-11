import type { Request, Response } from "express";
import { loadConfig } from "../config.js";

/**
 * GET /api/config/profile
 *
 * Returns the safe, public subset of the user profile — fields that the
 * frontend needs for display and content generation. Email, phone, and any
 * credential-like fields are deliberately excluded.
 */
export function profileHandler(_req: Request, res: Response): void {
  const { profile } = loadConfig();

  res.json({
    name: profile.name,
    location: profile.location ?? null,
    linkedin: profile.linkedin ?? null,
    github: profile.github ?? null,
    website: profile.website ?? null,
    summary: profile.summary ?? null,
    skills: profile.skills,
    targetTitles: profile.targetTitles,
    preferences: {
      remote: profile.preferences.remote,
      locations: profile.preferences.locations,
      industries: profile.preferences.industries,
      companySize: profile.preferences.companySize,
      // salaryMin intentionally omitted
    },
    projects: profile.projects,
    positioningGuidance: profile.positioningGuidance ?? null,
    voice: profile.voice ?? null,
  });
}
