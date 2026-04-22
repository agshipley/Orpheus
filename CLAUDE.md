# Orpheus — Canonical Project State

**Before doing anything in this session, read `ORPHEUS_STATE.md` in the repo root.** It is the single source of truth for the user, project, architecture, six-phase build plan, portfolio, infrastructure discipline, and standing risks. Anything in chat conversations or prior sessions that conflicts with `ORPHEUS_STATE.md` is stale — reconcile to the state file.

Update `ORPHEUS_STATE.md` whenever a phase ships, architecture changes, portfolio changes, or a new standing risk is identified. Do not let it drift.

**CLAUDE.md governs process. ORPHEUS_STATE.md governs state. If they conflict, ORPHEUS_STATE.md wins on facts; CLAUDE.md wins on rules.**

---

# Orpheus — Claude Code Project Guide

## Project Overview

Orpheus is a personal job search engine and application assistant. It fans out searches across multiple job boards, ranks results against a multi-identity profile (operator / legal / research / applied_ai_operator), and generates application materials (resume variants, cover letters, emails) using Claude. It is deployed on Railway as a single Express + React application backed by SQLite.

Key directories:
- `job-search-engine/src/` — Express API server, conductor orchestration, agents, storage
- `job-search-engine/client/src/` — React + Vite frontend
- `job-search-engine/archimedes.config.yaml` — primary config (profile, identities, org adjacency)
- `job-search-engine/data/` — SQLite database (gitignored; persisted via Railway volume)

---

## Verification Gates

**Committed to main is not shipped. Railway deploy success is not shipped. User-visible behavior on the live production URL is shipped.**

No feature is reported as complete until Andrew has loaded the production URL and confirmed the feature is executing. Every feature prompt must include a verification step that names a specific observable signal — not a test pass count, not a build log, not a TypeScript clean. Examples of valid verification signals:

- "Search results include source codes from vc_portfolio, ai_first, foundations_policy — not just ycombinator"
- "The /tonight page loads, shows 5 cards with why-paragraphs, and the source count is greater than 0"
- "Rating a job on Tune shows ✓ inline without a page reload"

If a verification step cannot be specified before writing code, the feature is not ready to ship.

**The failure mode this guards against:** a sophisticated system where everyone downstream of the commit assumes production reflects the code, and it doesn't. This is the most expensive failure mode in the Orpheus build history — more expensive than any individual bug.

---

## Build Failure Budget

**If more than two Railway deploys fail in succession on the same feature, stop shipping and run a root-cause pass before writing any new code.**

Three or more consecutive deploy failures is a process signal, not a coding signal. It means one of the following is true:

1. The TypeScript build has accumulated technical debt that is surfacing under new code
2. The feature scope grew past what a single commit can safely contain
3. A prior unverified deploy created a production state that conflicts with the new code
4. The spec was written before the affected types/interfaces were fully understood

When this pattern fires: stop, read the build log, identify which file and which line, fix only that, commit, wait for green. Do not add the next feature while the deploy is red. A red Railway deploy is a full stop.

**The failure mode this guards against:** a full day of work producing zero user-visible output because each commit assumed the prior one was stable when it wasn't. Three dozen failed builds in a day is not a run of bad luck — it is a process failure with a root cause.

---

## Infrastructure Reality Checks

The user is not an engineer by training. Before implementing any feature that adds new state, new external dependencies, or new cost exposure, surface the deployment implications explicitly — do not assume the user will catch them.

For every feature that adds persisted data, a new endpoint, a new external API call, or a background process, answer these questions in the response BEFORE writing code:

1. **Persistence.** Does this feature write data that needs to survive a restart or deploy? If yes, does it use the Railway volume mount at `/data` (via the `DATABASE_PATH` env var)? If it writes anywhere else, that data will be wiped on every deploy.

2. **Secrets and env vars.** Does this feature require a new API key, credential, or configuration variable? If yes, name the env var, explain where it needs to be set (Railway dashboard), and confirm it is NOT committed to the repo.

3. **LLM cost exposure.** Does this feature add LLM calls to user-facing paths? The live Orpheus URL has no authentication — anyone with the URL can trigger API calls that charge Andrew's Anthropic account. For any new user-facing LLM path, report:
   - Estimated cost per call
   - Whether the endpoint is public or rate-limited
   - Whether the feature should only run on authenticated paths (future)
   - Whether there should be a per-request or per-session cost cap

4. **Rate limits and external API reliability.** Does this feature depend on an external API (Anthropic, job boards, etc.)? What happens when that API is down, rate-limited, or returns malformed data? The feature must degrade gracefully, not fail silently.

5. **Data in logs and traces.** Does this feature log any PII (resume content, personal profile, email addresses, generated application materials)? If yes, confirm whether that data is OK to appear in Railway deploy logs and in the Observatory traces. Sensitive content should not be logged in plaintext.

6. **Rollback safety.** If this feature includes a database migration, schema change, or irreversible data operation, name it explicitly and describe how to roll back.

7. **Deploy order.** Does this feature require changes to Railway configuration (env vars, volume mounts, domains) that must be made before OR after the code deploys? If yes, give Andrew the exact sequence.

8. **Production visibility lag.** Will Andrew be able to see this change on the production URL within 30 minutes of commit? If not — because of a Railway build queue, a missing env var that must be set first, a cold-start delay, or any other factor — name the lag explicitly and tell Andrew what to watch for and when. Do not let a silent deploy create the impression that nothing changed.

Treat the above as a required checklist, not a suggestion. The cost of catching an infrastructure issue at architecture time is zero. The cost of catching it after a deploy has corrupted data or burned unexpected money is much higher.

If any of the eight items apply to a feature you're about to implement, state them at the top of the response, BEFORE proposing code changes. Andrew relies on this.

---

## Context Persistence Discipline

**ORPHEUS_STATE.md is authoritative. Any session that does not load it first is starting from a worse state than necessary.**

Before any architectural decision — adding an identity, changing the ranker, adding an agent source, modifying the scoring model — re-read ORPHEUS_STATE.md. Do not infer state from conversation history. Do not assume the prior session's final message reflects the committed codebase. Read the file.

Signs that a session has drifted from the state file and must be corrected before proceeding:

- Re-spec'ing work that `git log` shows is already committed
- Proposing a config change that contradicts an existing field in archimedes.config.yaml
- Asking the user to explain something that ORPHEUS_STATE.md already documents
- Treating a section of ORPHEUS_STATE.md as a proposal when it is already shipped

**The failure mode this guards against:** 45 minutes of a session consumed by state negotiation that ORPHEUS_STATE.md was built to eliminate. The state file exists because that failure happened. Do not reproduce it.

If there is a discrepancy between ORPHEUS_STATE.md and the actual codebase, flag it immediately and update the state file. Do not silently proceed on the wrong state.

---

## The User Is Not a Debugger

**When code Claude wrote fails, Claude reasons through the fix using the codebase context Claude already has. Asking the user to paste logs before attempting a fix is not a neutral move.**

Shifting the cost of a failure back to the user compounds the original error. The user does not have the mental model of the file Claude just wrote. They cannot efficiently read a TypeScript stack trace against a 400-line file they didn't author. Every "can you paste the error?" that could have been "let me read the file and find it" is a tax on the user's time and attention that Claude should be absorbing.

Default posture:
1. Read the failing file and the error message if available
2. Form a hypothesis from the code structure
3. Fix it
4. Run `tsc --noEmit` to confirm before reporting
5. Only ask the user for information that is genuinely unavailable from the codebase — e.g., a Railway environment variable value, a live URL response

**The exception:** if the fix requires understanding runtime behavior that cannot be inferred from static analysis (e.g., the Railway deploy is green but the live URL returns unexpected data), then ask for exactly the specific output needed, not a general "paste the logs."

---

## Velocity as a Product Feature

**When Andrew is in a momentum state, preserve it. When he is not, do not stack new feature work on a broken foundation.**

Andrew runs on momentum. The emotional state of the session is product-relevant, not background noise. A tool that finds a role he didn't know to look for — that's the thrill the product exists to produce. A search that returns 37 generic results from the wrong continent after ten hours of work — that's the failure the product must never produce. The distance between those two states is the product's entire value proposition.

Operating rules that follow from this:

- **If the last user-visible search returned results that did not reflect Andrew's profile, that is the highest-priority problem.** No architecture, no new features, no roadmap discussion until a search on the live URL returns results that look like they were found for him specifically.
- **If a Railway deploy is red, nothing else ships until it is green.** A green build with a broken feature is acceptable to work through. A red build with an accumulating commit queue is a process failure.
- **If a session has cost more than 30 minutes in coordination overhead** (pasting logs, re-explaining state, re-spec'ing committed work), the session should stop and the coordination failure should be named before continuing. The tool serves the user; the user does not serve the tool.
- **Momentum lost to process failure does not automatically recover.** It requires a concrete visible win — a search that surfaces a role worth clicking, a /tonight card with a why-paragraph that reads like it knows who he is. The next concrete deliverable after a bad session should be that visible win, not the next architectural layer.

---

## Portfolio-Level Process Risk

**Orpheus is not the only project. Process failures here will recur on the next project unless documented and explicitly mitigated.**

Andrew's other projects (first-agent, charlie, mrkt, NLSAFE, CW_Actual) shipped successfully under the same human-AI collaboration model. Orpheus is the first project where the process produced sustained build failure and context loss at scale. That asymmetry is diagnostic.

Candidate causes, documented here so they can be checked on the next project before the pattern runs:

1. **Scope creep on commits.** Orpheus commits grew to touch types, ranker, agents, server routes, and frontend in a single pass. When any one file has a type error, the whole commit fails. Smaller commits with explicit type-check gates before proceeding reduce blast radius.

2. **Unverified intermediate states.** Each phase assumed the prior phase was stable on the production URL. It wasn't always. The verification gate rule (above) addresses this directly.

3. **Context handoff as a point of failure.** The transition between Claude web chat and Claude Code sessions dropped state repeatedly. ORPHEUS_STATE.md addresses this. On the next project, create the state file on day one, not after the first context-loss incident.

4. **The user absorbing coordination cost.** When the collaboration stack has a seam, the default behavior was for the user to manually bridge it — paste logs, re-explain architecture, re-trigger builds. That cost is invisible in individual instances and catastrophic in aggregate. The "user is not a debugger" rule (above) is the mitigation.

If any of these patterns surface on a future project, check this file first. The solutions are already written.

---

## Known Standing Risks

These are known architectural characteristics of Orpheus as currently deployed. They are not bugs. They are limitations that become problems if circumstances change. Any feature or change that affects one of these should prompt a re-evaluation.

- **No authentication.** The live URL is public. Any visitor can run searches and trigger LLM generations that bill to Andrew's Anthropic account. Fine while the URL is obscure. Becomes a problem if the URL is shared publicly (GitHub README, LinkedIn, portfolio site). Mitigation when needed: simple password gate or auth before any URL-sharing.

- **Profile data in private repo.** `archimedes.config.yaml` contains Andrew's full personal profile including contact info and work history. Committed to a private GitHub repo. Fine as long as the repo stays private. Blocks open-sourcing the project without a secrets refactor (move profile back to env var, commit only profile.example.yaml).

- **No rate limiting.** No endpoint has request throttling. A bug or bad actor could trigger runaway LLM costs.

- **Single-node SQLite.** The database is a local SQLite file on a Railway volume. Fine for single-user personal use. Not a scaling architecture. If Orpheus ever gets multi-user or multi-writer, migrate to Postgres before that point, not after.

- **No backups.** The Railway volume is not backed up. Catastrophic data loss is possible. Consider periodic SQLite snapshots to Railway's object storage or an external bucket when the data becomes valuable enough to lose sleep over.
