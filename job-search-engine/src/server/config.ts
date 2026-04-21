/**
 * Shared config + .env loader for the Express server.
 *
 * Config resolution order (first match wins):
 *   1. archimedes.config.yaml  ← committed to repo; primary source of truth
 *   2. archimedes.config.yml
 *   3. orpheus.config.yaml
 *   4. orpheus.config.yml
 *   5. config.yaml
 *   6. ORPHEUS_PROFILE_YAML env var — fallback for open-source deployments
 *      where no config file is present in the repo.
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

// Substitute ${VAR:-default} and ${VAR} patterns with process.env values.
function substituteEnvVars(yaml: string): string {
  return yaml.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const colonDash = expr.indexOf(":-");
    if (colonDash !== -1) {
      const key = expr.slice(0, colonDash);
      const fallback = expr.slice(colonDash + 2);
      return process.env[key] ?? fallback;
    }
    return process.env[expr] ?? "";
  });
}

export function loadConfig(): Config {
  // ── 1. File-based loading (committed config is primary source of truth) ───
  for (const path of CONFIG_PATHS) {
    if (existsSync(path)) {
      const raw = substituteEnvVars(readFileSync(path, "utf-8"));
      const parsed = normalizeProfileKeys(parseYaml(raw));
      return ConfigSchema.parse(parsed);
    }
  }

  // ── 2. Env-var fallback (open-source / no config file in repo) ────────────
  if (process.env.ORPHEUS_PROFILE_YAML) {
    const parsed = normalizeProfileKeys(parseYaml(process.env.ORPHEUS_PROFILE_YAML));
    return ConfigSchema.parse(parsed);
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
