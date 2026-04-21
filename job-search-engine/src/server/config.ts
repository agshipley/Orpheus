/**
 * Shared config + .env loader for the Express server.
 *
 * Config resolution order (first match wins):
 *   1. ORPHEUS_PROFILE_YAML env var — full config as a YAML string.
 *      Set this in Railway (or any host) to inject the personal profile
 *      without committing it to git.
 *   2. archimedes.config.yaml  ← personal profile, gitignored
 *   3. archimedes.config.yml
 *   4. orpheus.config.yaml
 *   5. orpheus.config.yml
 *   6. config.yaml
 *
 * snake_case → camelCase normalisation is applied in all paths so older
 * YAML files (target_titles, avoid_phrases, etc.) keep working.
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
  // ── 1. Env-var injection (Railway / any host without filesystem config) ──
  if (process.env.ORPHEUS_PROFILE_YAML) {
    const parsed = normalizeProfileKeys(parseYaml(process.env.ORPHEUS_PROFILE_YAML));
    return ConfigSchema.parse(parsed);
  }

  // ── 2. File-based loading ─────────────────────────────────────────────────
  for (const path of CONFIG_PATHS) {
    if (existsSync(path)) {
      const parsed = normalizeProfileKeys(parseYaml(readFileSync(path, "utf-8")));
      return ConfigSchema.parse(parsed);
    }
  }

  // ── 3. Bare-minimum defaults (no config at all) ───────────────────────────
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
