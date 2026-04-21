/**
 * Shared config + .env loader for the Express server.
 *
 * Config file priority (first found wins):
 *   archimedes.config.yaml   ← personal profile, gitignored
 *   archimedes.config.yml
 *   orpheus.config.yaml
 *   orpheus.config.yml
 *   config.yaml
 *
 * NOTE: The archimedes.config.yaml uses snake_case for the fields added in
 * the v2 schema update (target_titles, avoid_phrases, positioning_guidance,
 * etc.). Zod strips unknown keys, so those values will be absent from the
 * parsed config until the YAML is updated to camelCase or a transform is
 * added here. The core fields (name, skills, experience, preferences,
 * agents, content, storage) are already camelCase and load correctly.
 */

import { readFileSync, existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import { ConfigSchema } from "../types.js";
import type { Config } from "../types.js";

// ─── .env ─────────────────────────────────────────────────────────
// Load once at import time so every module that imports this file
// inherits the env vars.

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

// ─── Config loader ────────────────────────────────────────────────

const CONFIG_PATHS = [
  "./archimedes.config.yaml",
  "./archimedes.config.yml",
  "./orpheus.config.yaml",
  "./orpheus.config.yml",
  "./config.yaml",
];

function normalizeProfileKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const profile = raw.profile as Record<string, unknown> | undefined;
  if (!profile) return raw;

  const renames: Record<string, string> = {
    target_titles:       "targetTitles",
    positioning_guidance: "positioningGuidance",
    additional_experience: "additionalExperience",
  };
  for (const [from, to] of Object.entries(renames)) {
    if (profile[from] !== undefined && profile[to] === undefined) {
      profile[to] = profile[from];
      delete profile[from];
    }
  }

  const voice = profile.voice as Record<string, unknown> | undefined;
  if (voice) {
    const voiceRenames: Record<string, string> = {
      avoid_phrases:     "avoidPhrases",
      signature_phrases: "signaturePhrases",
    };
    for (const [from, to] of Object.entries(voiceRenames)) {
      if (voice[from] !== undefined && voice[to] === undefined) {
        voice[to] = voice[from];
        delete voice[from];
      }
    }
  }

  return { ...raw, profile };
}

export function loadConfig(): Config {
  for (const path of CONFIG_PATHS) {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      const parsed = normalizeProfileKeys(parseYaml(raw));
      return ConfigSchema.parse(parsed);
    }
  }

  // Bare-minimum defaults so the server can start without a config file.
  return ConfigSchema.parse({
    profile: {
      name: process.env.USER ?? "User",
      skills: [],
      preferences: {},
    },
    agents: {},
    observability: {},
    content: {},
    storage: {},
  });
}
