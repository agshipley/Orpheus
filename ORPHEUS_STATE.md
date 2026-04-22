# ORPHEUS — Project State

**Purpose of this file.** This is the single source of truth for the Orpheus project across conversations. Any Claude Code session or chat conversation should load this file first. If anything elsewhere conflicts with what's here, treat this as authoritative and reconcile before acting.

**Location.** Committed at the repo root as `ORPHEUS_STATE.md`. Claude Code reads it via CLAUDE.md's "See ORPHEUS_STATE.md" reference. Claude.ai conversations load it via the project knowledge sidebar.

**Maintenance.** Update this file via Claude Code whenever a phase ships, the architecture changes, the portfolio changes, or a new standing risk is identified. Do not let it drift.

---

## 1. User

**Andrew Shipley** (Santa Monica, CA).

- **Education.** Yale Law School (JD). Rhodes Scholar at Oxford (Experimental Psychology). Fulbright Scholar at University of Wellington. Phi Beta Kappa, University of Oregon.
- **Career arc.** Gunderson Dettmer (corporate associate, VC law) → AGS Law PLLC (co-founding partner, 100+ startups, $250M+ transactions) → EeroQ Corporation (Special Counsel, promoted to Chief of Staff) → Trace Machina / NativeLink (Director of Operations, 10x ARR to $1M, SOC II certification, ARIA Safeguarded AI grant work).
- **Publications (peer-reviewed).**
  - Shipley, A. (2008). *Social comparison and prosocial behavior: an applied study of social identity theory in community food drives.* Psychological Reports 102(2): 425–434. **Sole author.**
  - Dutton, W. H., & Shipley, A. (2010). *The Role of Britain's Televised Leadership Debates in Shaping Political Engagement.* In: Leaders in the Living Room, Reuters Institute for the Study of Journalism. Co-author with William H. Dutton (Oxford Internet Institute).
  - Strupp-Levitsky, M., Noorbaloochi, S., Shipley, A., & Jost, J. T. (2020). *Moral "foundations" as the product of motivated social cognition.* PLOS ONE 15(11): e0241144. Co-author with John T. Jost (NYU).
- **Role in this project.** Product owner, taste/judgment calls, domain expert. **Not an engineer by training.** Uses Claude Code for implementation.

---

## 2. Project

**Orpheus** — AI-powered personal job search engine built on MCP (Model Context Protocol) architecture.

- **Live deployment.** `https://orpheus-production-6b88.up.railway.app`
- **GitHub.** `https://github.com/agshipley/Orpheus` (public)
- **Local repo.** `~/projects/Orpheus/job-search-engine/`
- **Model.** `claude-sonnet-4-6`
- **Stack.** Node.js / TypeScript, Express backend, React + Vite + Tailwind frontend, `better-sqlite3`.
- **Deploy.** Railway auto-deploys from `main`. SQLite on Railway volume at `/data` via `DATABASE_PATH=/data/orpheus.db`. Volume is required — without it every deploy wipes all saved jobs, feedback, tuned weights, and traces.
- **Dual purpose.** (1) Functional job search for Andrew's actual target roles. (2) Portfolio piece demonstrating MCP architecture, parallel agent orchestration, four-identity ranking, github_signal company-affinity boost, observability, and behavioral feedback learning.

---

## 3. Current Architecture (shipped)

### Backend

- Express server with MCP server layer. Conductor orchestrates parallel agent fan-out via `p-limit`.
- **Active agents.** HN (YCombinator Who's Hiring) and Jobicy.
- **Deprecated agents (kept in code, unregistered).** WaaS (client-rendered, not worth headless scraping), Getro (401 auth-gated), Pallet (404).

### Four-Identity Ranker (Phase 2.5 → extended, commit `3424f48` + subsequent)

Every job is scored against four identities independently, then **MAX** wins.

- **OPERATOR** — Chief of Staff, Director of Ops, Founder's Associate, Business Operations, Head of Strategic Initiatives. Built on EeroQ CoS + Trace Machina Director of Ops + AGS Law partner track.
- **LEGAL** — General Counsel, Head of Business Affairs, Corporate Development, VP Legal, Special Counsel. Built on AGS Law + Gunderson + EeroQ Special Counsel.
- **RESEARCH** — Research Operations, Program Officer, Policy Fellow, Senior Fellow, Research Manager, CoS to Chief Scientist. Built on three peer-reviewed publications + Rhodes DPhil + Fulbright + Trace Machina ARIA work + NLSAFE.
- **APPLIED_AI_OPERATOR** — Head of AI, Director of Applied AI, AI Program Lead, Applied AI Lead, VP AI, and equivalents. Built on five shipped production AI systems (first-agent, charlie, mrkt, NLSAFE, Orpheus). Positioned as "applied-AI operator who has shipped production systems for named clients." Targets non-AI-first companies where the AI operator layer is the value capture.

Each identity has its own block in `archimedes.config.yaml` with `target_titles`, `positioning_guidance`, `resume_emphasis`, `cover_letter_emphasis`, and `key_credentials`.

**Research-identity org-adjacency boosts** (only apply to research identity scoring):

- **Tier 1 (frontier AI, +60).** Anthropic, OpenAI, Google DeepMind, Meta AI Research / FAIR, METR, Redwood Research, FAR Labs, ARC (Alignment Research Center), Apollo Research, AI Objectives Institute, Conjecture.
- **Tier 2 (AI policy, +50).** Open Philanthropy, RAND (AI portfolio), CSET, GovAI, AI Policy Institute, CAIDP, Centre for the Governance of AI.
- **Tier 3 (tech policy / civic, +40).** Oxford Internet Institute, Stanford HAI, Stanford Cyber Policy Center, Berkman Klein, Data & Society, AI Now Institute, Knight First Amendment Institute, Reuters Institute, Shorenstein, Pew, Mozilla Foundation, Omidyar Network, Knight Foundation, Ford Foundation (tech programs), Protect Democracy, The GovLab (NYU).

**Legal-identity boost** (+25) when job description contains: "JD", "law degree", "legal background", "attorney", "counsel", "deal experience", "transactional".

**Scoring.** Normalized to `[0, 1]` against a fixed 160-point ceiling (absolute, not best-in-batch). A job shown as 100% actually hits the ceiling — not just "least bad of the batch."

**github_signal boost** (shipped). Top-level `github_signal` block in config — 6 hand-curated entries (NLSAFE, first-agent, charlie, mrkt, Orpheus, client-deployed AI systems). For each identity, after base scoring, add up to **+20 points** based on unique keyword hits in `job.company + job.description` against that identity's aggregated keyword bag. Linear scale: 1 hit = +5, 2 = +10, 3 = +15, 4+ = +20. Fails safe — absent block → no boost, no throw.

**Content-generator injection.** github_signal entries filtered to the active identity are injected into ResumeTailor / CoverLetterGenerator / EmailDrafter prompts as "Relevant personal projects to reference authentically when the role context warrants it." Keywords are NOT passed; only `name + summary`.

**UI exposure.** Search results show **OP / LEG / RES / AAI** badges per result (blue / amber / green / teal). Detail panel has a **Match Analysis** section showing the winning identity's reasons expanded, other identities collapsed. An **identity override dropdown** in the detail panel header lets the user force a different identity for content generation (all four options).

### Content Generators

- `ResumeTailor`, `CoverLetterGenerator`, `EmailDrafter` — all accept an `identity` parameter.
- `/api/apply` passes `job.matchedIdentity` by default; the UI dropdown overrides it.
- Each generator reads the matching identity block from config and injects `positioning_guidance`, `resume_emphasis` / `cover_letter_emphasis`, and `key_credentials` into the LLM system prompt.

### Config

- **`archimedes.config.yaml` is the single source of truth.** Committed to the repo.
- **`ORPHEUS_PROFILE_YAML` env var is DEPRECATED.** Do not reintroduce. Profile changes ship via `git push`.
- Fields currently populated: `profile` (name, contact, education, experience), `identities.operator / legal / research`, `org_adjacency.tier_1 / tier_2 / tier_3`, `profile.projects[]` (NLSAFE, first-agent, mrkt), `profile.github_url`, `profile.publications[]` (all three papers), `voice.avoidPhrases`, `voice.signaturePhrases`, `positioningGuidance`.

### Tests

- 52 tests passing.
- Ranking tests in `tests/unit/ranking.test.ts` cover: operator-win, legal-win, research-win-tier-1-boost, research-win-tier-3-boost, low-score-engineering-role, MAX-not-sum behavior, applied_ai_operator-win (Head of AI), github_signal exact boost (+5 for 1 hit), github_signal ceiling (+20 for 4+ hits), github_signal graceful fallback (empty array → null, no throw), MAX-not-sum with 4 identities, null-returns for no-match jobs.

---

## 4. Six-Phase Build Plan

Build order: **2 (verify) → 2.5 (verify) → 2.6 → 2.7 → 3 → 4 → 5 → 6.**

Rationale: 2.6 and 2.7 before 3 because the Observatory needs feedback-loop data to show. 5 before 6 because redesigning the UI once with all routes present is cheaper than redesigning twice. 6 last because it depends on 2, 3, and 4 being real.

### Phase 2 — Job Detail View + Content Generation UI  *(SHIPPED, not yet fully verified live)*

- Search results clickable, slide-out detail panel.
- Three buttons: Tailor Resume, Write Cover Letter, Draft Outreach Email.
- `/api/apply` routes to the correct generator with the active identity.
- Variants display with strategy name, confidence score, copy-to-clipboard.
- **Pending verification.** End-to-end on live Railway: search → click → generate all three types → confirm operator-identity resume differs meaningfully from research-identity resume for the same job.

### Phase 2.5 — Three-Identity Ranking  *(SHIPPED, commit `3424f48`, 46 tests pass locally, needs live verification)*

Live verification test matrix:

1. Search `"chief of staff AI startup"` → expect OP badges dominant.
2. Search `"general counsel venture backed"` → expect LEG badges.
3. Search `"program officer AI safety"` → expect RES badges with org-adjacency boosts on tier-1 orgs.

Then click into one result per identity and confirm the Match Analysis panel renders with winning-identity reasons and collapsed alternative identities.

### Phase 2.6 — Saved Jobs Primitive  *(SPEC READY)*

- First-class "saved" state separate from the tracker kanban.
- `saved_jobs` table in SQLite with `job_id`, `saved_at`, `notes`.
- Bookmark icon on every job row everywhere (search results, tuning cards, detail panel).
- `/saved` route with inline-editable notes.
- Nav link "Saved (N)" on every page.
- Idempotent toggle (second click unsaves). No modal.
- Integrates with Phase 2.7 feedback loop: a save action logs a synthetic +2 rating tagged `source='save'`.

### Phase 2.7 — Behavioral Feedback Loop  *(SPEC READY — "Option A + Option C", five-point Likert)*

Design rooted in Shipley 2008 principle: measure behavior, not self-report.

- `POST /api/search/wide` — low-cost endpoint: skip query parsing, skip LLM re-rank, heuristic-only ranking, up to 100 results. Target near-zero cost per call.
- `/tune` page — card-stack interface, one job at a time, full description visible.
- **Five-point Likert scale.** `+2 Love`, `+1 Interested`, `0 Neutral`, `-1 Not for me`, `-2 Never`. Keyboard shortcuts 1–5.
- **Identity mismatch flag** — separate signal when the ranker assigned the wrong identity; dropdown to select the correct one.
- **Option A (heuristic weight tuning).** Every 20 votes or via button: compute point-biserial correlation per feature per identity, adjust weights ±20% cap, minimum 10 samples per feature. Weights stored in `ranker_weights` table, per-identity. Reset-to-baseline per feature.
- **Option C (LLM preference summary).** Every 50 votes or via button: one LLM call summarizing last 100 rated jobs, returns structured JSON (strong_likes, strong_dislikes, weak_or_ambiguous, divergence_from_stated). Injected into the ranker's re-rank prompt.
- **Identity correction learning.** Every 10 corrections: LLM pass generating rules appended to that identity's positioning_guidance.
- **Cost target.** Under $0.50 per full tuning session.
- All feedback persists to SQLite (`job_feedback`, `ranker_weights`, `preference_summaries`). Requires the Railway volume.

### Phase 3 — Observatory Dashboard

- Exists in code, never validated live.
- Waterfall traces with per-agent spans, timing, result counts.
- Metrics: search count, agent success rate, latency p50/p95/p99, tokens, cumulative cost.
- Decision log, filterable by component.
- Feedback-loop status panel (from Phase 2.7): vote histogram, current tuned weights vs baseline, latest preference summary, rating-distribution sparkline over time.
- Monospace font (JetBrains Mono) — this route only.
- **Requires SQLite trace persistence.** Traces currently in-memory only, wiped on Railway restart. Add `traces`, `spans` tables and write-through-cache pattern.

### Phase 4 — Application Tracker

- UI shell exists, no persistence layer.
- Kanban columns: Saved, Applied, Interview Scheduled, Offer, Rejected, Withdrawn.
- Drag-drop updates via `PATCH /api/applications/:id` (endpoint currently missing — the unblocker).
- Cards show title, company, salary, applied date, link to generated materials for that job.

### Phase 5 — UI Redesign (Linear / Vercel aesthetic)

- Near-black background `#0A0A0B`, card surfaces `#111113`.
- Single accent: muted blue `#3B82F6`, used sparingly.
- White primary text `#FAFAFA`, gray secondary `#71717A`.
- Inter font everywhere except Observatory (JetBrains Mono there).
- 1px borders `rgba(255,255,255,0.06)`, 8px radii.
- No gradients, no glows, no purple.
- Raycast-style minimal centered search bar.
- Top nav: Orpheus logo left, Search / Saved / Tracker / Observatory right.

### Phase 6 — GBrain-style Self-Enriching Memory Layer  *(SPEC READY, gated on Phase 2–5 completion)*

Adapted conceptually from Garry Tan's GBrain. **Reimplement natively in Orpheus's stack — do NOT copy code from that repo.**

- **Entity model.** Company, Person, Role, Interaction with typed relations (`hiring_at`, `posted_role`, `generated_for`, `referred_me`, `interviewed_me`, `rejected_me`).
- **Storage.** Every entity as a markdown page with front-matter, versioned in `entity_versions`. Extends SQLite schema; optionally add `sqlite-vec` for vector search.
- **Signal capture.** Background queue, fire-and-forget, never blocks user requests. Hooks: `onSearch`, `onJobView`, `onContentGeneration`, `onApplicationStatusChange`.
- **Entity extraction.** Regex + alias lookup. **Zero LLM calls in the fast path.**
- **Tier promotion.** Stub (3) → known (2) at 3 mentions → priority (1) on user action. Tier-1 promotion triggers ONE LLM enrichment call, cached forever.
- **Context retrieval.** `getCompanyContext`, `getRoleContext`, `getPersonContext` called by content generators before every generation; injected into prompts as prior-context section.
- **Daily cron.** Consolidate duplicates, archive stale stubs, generate morning briefing (active applications, follow-ups, new matching roles from brain).
- **MCP exposure.** `brain_search`, `brain_get`, `brain_list`, `brain_write` — reusable outside Orpheus.
- **UI.** New `/brain` route: browseable knowledge graph. Job detail view shows a "Context" panel above generation buttons. Application tracker cards show current tier of the company.

---

## 5. Portfolio (public repos at `github.com/agshipley`)

Five showable repos, plus CW_Actual as sixth.

1. **NLSAFE** (Rust, Apache 2.0). Verifiable build infrastructure for safety-critical AI systems. Three subprojects: `llvm_ir_analyzer` (static IR scanner for unsafe memory patterns), `mlir_audit_tool` (MLIR dialect-aware audit for dynamic ops and layout violations), `bep_to_slsa` (Bazel Build Event Protocol → SLSA provenance transformer). 14 commits. **Tier-1 research credential. Also operator-relevant.**

2. **first-agent** (Python, Flask, Apache 2.0). Production AI lead-generation agent for Tre Borden /Co, deployed on Railway with SSE streaming. Includes a multi-city art-commissioning intelligence engine covering LA, NYC, SF with typology-primary scoring, owner-pattern matching from JSON config, percent-for-art ordinance matching, connector architecture for pluggable municipal data sources. 275 tests. Has a `PERMITS_PROJECT.md` product-strategy doc with competitive analysis (Dodge / ConstructConnect / ATTOM / Shovels.ai). **Tier-1 applied_ai_operator + operator credential.**

3. **mrkt** (Python). "Moneyball for transactional law" — empirical M&A research platform. 152-agreement MAUD corpus, four Anthropic tool_use schemas, 99.7% extraction success, 91–94% expert-label agreement, OLS with HC1 robust SEs. **Tier-1 legal + research credential.**

4. **charlie** (Python). Autonomous multi-agent entertainment-industry intelligence system deployed on Railway for Liz Varner. Four agents: Ingestion, Analysis, Brief, Thesis. Per-client persistent context. **Tier-1 applied_ai_operator credential.**

5. **Orpheus** (TypeScript). This project. **Tier-1 applied_ai_operator + operator credential.**

6. **CW_Actual** (HTML / vanilla JS, canvas-rendered). Single-file ~4,400-line park-management simulation adapted from George Saunders' *CivilWarLand in Bad Decline*. Deliberate one-file monolith: no build step, no framework, no dependencies. Data-driven content architecture (events, minor events, phase-2 events, daily actions, building interiors, tally verdicts, character visuals all as plain-object tables), hand-drawn sketchy-line rendering via seeded wobble primitives, four-checkpoint moral ledger with authored verdicts, two-phase game gate at day 31, in-browser hotspot authoring tool, named design principle ('Height to Fall From') governing compounding decay. Live at `cw-actual.vercel.app`. **Tier-2 craft and systems-design credential** — demonstrates runtime-architecture judgment, content-data separation, and documentation discipline.

### Public-facing fixes pending

- Orpheus GitHub description currently says `"PD Tool"` → should say something like: "AI-powered personal job search engine on MCP architecture with multi-source agent orchestration, four-identity ranking, and observability."
- first-agent GitHub description currently says `"Test agent, pipeline generation for Borden/Co"` → should say something like: "Production AI lead-generation system for Tre Borden /Co, plus an open-source art-commissioning intelligence engine covering LA, NYC, and SF."
- Pin NLSAFE, first-agent, charlie, mrkt, Orpheus, and CW_Actual on the GitHub profile (six slots — GitHub's maximum).

---

## 6. Infrastructure Reality Checks (required for every feature prompt)

Andrew is not an engineer by training. Before implementing any feature that adds new state, new external dependencies, or new cost exposure, surface deployment implications **before writing code**. Answer these seven questions in the prompt:

1. **Persistence.** Does this write data that must survive a restart or deploy? If yes, confirm it uses the Railway volume at `/data` via `DATABASE_PATH`. Data written anywhere else is wiped on every deploy.
2. **Secrets and env vars.** New credentials or config? Name the env var. State that it must be set in Railway dashboard. Confirm it is NOT committed.
3. **LLM cost exposure.** New LLM calls on user-facing paths? The live URL has no auth — anyone can trigger generations that bill Andrew's Anthropic account. Report: estimated cost per call, whether the endpoint is public, whether it needs a cost cap.
4. **Rate limits and external API reliability.** Any external API dependency? What happens when it's down, rate-limited, or returns malformed data? Must degrade gracefully, not fail silently.
5. **Data in logs and traces.** Any PII (resume content, profile, emails, generated materials) logged? Confirm it's safe to appear in Railway deploy logs and Observatory traces.
6. **Rollback safety.** Schema changes, migrations, or irreversible data operations? Describe how to roll back.
7. **Deploy order.** Do Railway config changes (env vars, volumes, domains) need to happen before OR after the code deploys? Give the exact sequence.

**Division of labor.** Andrew makes product / taste / judgment calls. Claude covers infrastructure / security / persistence / cost. When Andrew catches an infrastructure issue Claude missed (e.g., the Railway volume), that's a failure on Claude's side, not Andrew's.

---

## 7. Known Standing Risks

These are architectural characteristics of Orpheus as currently deployed. Not bugs — limitations that become problems if circumstances change. Any feature touching one of these should re-evaluate.

- **No authentication.** Live URL is public. Any visitor can trigger LLM generations that bill Andrew's Anthropic account. Fine while obscure. Becomes a problem if the URL is shared publicly (GitHub README, LinkedIn, portfolio site). Mitigation: password gate or auth before URL-sharing.
- **Profile data in private repo.** `archimedes.config.yaml` contains full personal profile. Blocks open-sourcing Orpheus without a secrets refactor (move profile back to env-var loading with `profile.example.yaml` template).
- **No rate limiting.** No endpoint has request throttling.
- **Single-node SQLite.** Local file on Railway volume. Not a multi-user / multi-writer architecture. Migrate to Postgres before that point, not after.
- **No backups.** Railway volume is not backed up. Catastrophic data loss is possible. Consider periodic snapshots when data becomes valuable enough to lose sleep over.

---

## 8. Working Patterns (how Claude should behave)

- **Code delivery.** All code changes go through Claude Code as pasteable prompts. Never deliver raw files, tarballs, or manual `cp` commands.
- **Real paths only.** Always use `~/projects/Orpheus/job-search-engine/`. If a path is uncertain, say so explicitly — no placeholders.
- **Validate before delivery.** Verify code compiles (`npx tsc --noEmit`) before shipping. Include validation steps in multi-file changes. Never ship untested code and treat Andrew as the debugger.
- **Own errors.** When errors occur in code Claude wrote, reason through the fix using knowledge of the codebase. Do not ask Andrew to paste logs or say "I can't fix what I can't see." Claude wrote it, Claude debugs it.
- **Simplicity over architecture.** Don't add layers (Docker, extra config, complex toolchains) unless explicitly requested. Railway auto-detects Node.js — no Dockerfile. Working simple beats broken sophisticated.
- **Wire everything through.** Building personalization scaffolding (target_titles, positioning_guidance, identities) is worthless if it isn't wired into the layers that use it. Validate end-to-end, not just component existence.
- **Communication style.** Direct, efficient. Skip color commentary. Don't narrate what you're about to do. Don't pad with reassurances. When something breaks, fix it.
- **Credentials.** Never repeat or re-include sensitive credentials (API keys, passwords) in follow-up messages even if shared earlier. Flag once to rotate, then move on.
- **Voice constraints (Andrew's, for generated content).** Direct, sophisticated, analytically rigorous. Never use "passionate about," "synergy," "leverage," "dynamic self-starter," or similar.

---

## 9. Pending Actions

### Verification (must complete before Phase 2.6)

- [ ] Phase 2 end-to-end live on Railway: search → click → generate resume/cover letter/email → confirm different identities produce different resumes.
- [ ] Phase 2.5 three test searches live on Railway (operator / legal / research query matrix).
- [ ] Confirm Match Analysis panel renders on live detail view.

### Portfolio hygiene

- [ ] Update Orpheus GitHub description from "PD Tool" to accurate positioning.
- [ ] Update first-agent GitHub description from "Test agent, pipeline generation for Borden/Co" to accurate positioning.
- [ ] Pin NLSAFE, first-agent, mrkt, Orpheus on GitHub profile.
- [ ] Read mrkt repo contents for deeper positioning.
- [ ] Pin NLSAFE, first-agent, charlie, mrkt, Orpheus, CW_Actual on the agshipley GitHub profile (six slots, GitHub max).

### Shipped-but-stale

- [ ] Ship Phase 2.6 (saved jobs primitive) — prompt ready.
- [ ] Ship Phase 2.7 (feedback loop) — prompt ready.
- [ ] Ship Phase 3, 4, 5, 6 in order.

---

## 10. Change Log

- **2026-04-21** — Initial canonical state file created. Captures everything through Phase 2.5 shipped (commit `3424f48`), three-identity ranker live, portfolio identified (NLSAFE replaces earlier "Achilles" placeholder), Railway volume discipline formalized, `github_signal` block proposed but not yet shipped.
- **2026-04-21** — Fourth identity (`applied_ai_operator`) + `github_signal` block shipped. Six portfolio entries finalized (NLSAFE, first-agent, charlie, mrkt, Orpheus, CW_Actual). AAI badge (teal) added to UI. All content generators updated with filtered github_signal injection. 52 tests passing.
