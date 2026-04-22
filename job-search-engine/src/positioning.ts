/**
 * Positioning service — manages POSITIONING.md, the living asymmetry-frame
 * document that drives content-generator posture and matches-page identity.
 *
 * Section 1 (auto-generated) is rebuilt on demand from current config state.
 * Section 2 (human-curated) is preserved across regenerations.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { Config } from "./types.js";

const POSITIONING_PATH = join(process.cwd(), "POSITIONING.md");
const SECTION2_MARKER = "<!-- HUMAN-CURATED";

export function getPositioningPath(): string {
  return POSITIONING_PATH;
}

export function buildSection1(config: Config): string {
  const profile = config.profile;
  const githubSignal = (config.github_signal ?? []).filter(
    (e) => e.name !== "client-deployed AI systems"
  );

  const identityLines = profile.identities
    ? Object.entries(profile.identities)
        .filter(([, cfg]) => cfg && cfg.target_titles.length > 0)
        .map(([key, cfg]) => {
          const titles = cfg!.target_titles.slice(0, 3).join(", ");
          return `- **${key}**: ${titles}${cfg!.target_titles.length > 3 ? " …" : ""}`;
        })
        .join("\n")
    : "No identities configured.";

  const portfolioLines = githubSignal.length > 0
    ? githubSignal
        .map((e) => {
          const summary = e.summary.length > 130
            ? e.summary.slice(0, 130) + "…"
            : e.summary;
          return `- **${e.name}**: ${summary}`;
        })
        .join("\n")
    : "No portfolio entries configured.";

  const credentialLines = profile.education
    .slice(0, 3)
    .map((e) => `${e.degree}${e.field ? ` in ${e.field}` : ""}, ${e.institution}`)
    .join(" · ");

  return `<!-- AUTO-GENERATED — POST /api/positioning/regenerate to rebuild this section. Do not hand-edit above the divider. -->
<!-- Last regenerated: ${new Date().toISOString()} -->

# Positioning Frame

${profile.name} built the portfolio below as an unpaid hobby while running a law practice. The throughline is not "interested in AI" — it is operational judgment applied to production systems across multiple verticals. The right role is one where a named capability gap is the structural problem and his shape is the unlock. That role needs him more than he needs it. Orpheus exists to find those roles, surface the asymmetry, and write on his behalf from a position of evaluating the opportunity — not applying for it.

## Active Identities

${identityLines}

## Portfolio

${portfolioLines}

## Credentials

${credentialLines}

`;
}

export function readPositioningFile(): string {
  if (!existsSync(POSITIONING_PATH)) return "";
  return readFileSync(POSITIONING_PATH, "utf-8");
}

export function regeneratePositioning(config: Config): void {
  const section1 = buildSection1(config);

  const existing = existsSync(POSITIONING_PATH)
    ? readFileSync(POSITIONING_PATH, "utf-8")
    : "";

  const dividerIdx = existing.indexOf(SECTION2_MARKER);
  const section2 =
    dividerIdx >= 0
      ? existing.slice(dividerIdx)
      : `${SECTION2_MARKER} SECTION — Edit freely below this line. Regeneration preserves everything from here down. -->

---

## Andrew's Evolving Thesis

<!-- What roles am I becoming? What patterns am I seeing? What are my anti-patterns? -->
<!-- Which companies or problem spaces would make this role worth my time? -->
<!-- What signals in a JD tell me this is the right kind of problem? -->
`;

  writeFileSync(POSITIONING_PATH, section1 + section2, "utf-8");
}
