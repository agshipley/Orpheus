# Orpheus — Canonical Project State

**Before doing anything in this session, read `ORPHEUS_STATE.md` in the repo root.** It is the single source of truth for the user, project, architecture, six-phase build plan, portfolio, infrastructure discipline, and standing risks. Anything in chat conversations or prior sessions that conflicts with `ORPHEUS_STATE.md` is stale — reconcile to the state file.

Update `ORPHEUS_STATE.md` whenever a phase ships, architecture changes, portfolio changes, or a new standing risk is identified. Do not let it drift.

---

# Orpheus — Claude Code Project Guide

## Project Overview

Orpheus is a personal job search engine and application assistant. It fans out searches across multiple job boards, ranks results against a multi-identity profile (operator / legal / research), and generates application materials (resume variants, cover letters, emails) using Claude. It is deployed on Railway as a single Express + React application backed by SQLite.

Key directories:
- `job-search-engine/src/` — Express API server, conductor orchestration, agents, storage
- `job-search-engine/client/src/` — React + Vite frontend
- `job-search-engine/archimedes.config.yaml` — primary config (profile, identities, org adjacency)
- `job-search-engine/data/` — SQLite database (gitignored; persisted via Railway volume)

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

Treat the above as a required checklist, not a suggestion. The cost of catching an infrastructure issue at architecture time is zero. The cost of catching it after a deploy has corrupted data or burned unexpected money is much higher.

If any of the seven items apply to a feature you're about to implement, state them at the top of the response, BEFORE proposing code changes. Andrew relies on this.

## Known Standing Risks

These are known architectural characteristics of Orpheus as currently deployed. They are not bugs. They are limitations that become problems if circumstances change. Any feature or change that affects one of these should prompt a re-evaluation.

- **No authentication.** The live URL is public. Any visitor can run searches and trigger LLM generations that bill to Andrew's Anthropic account. Fine while the URL is obscure. Becomes a problem if the URL is shared publicly (GitHub README, LinkedIn, portfolio site). Mitigation when needed: simple password gate or auth before any URL-sharing.

- **Profile data in private repo.** `archimedes.config.yaml` contains Andrew's full personal profile including contact info and work history. Committed to a private GitHub repo. Fine as long as the repo stays private. Blocks open-sourcing the project without a secrets refactor (move profile back to env var, commit only profile.example.yaml).

- **No rate limiting.** No endpoint has request throttling. A bug or bad actor could trigger runaway LLM costs.

- **Single-node SQLite.** The database is a local SQLite file on a Railway volume. Fine for single-user personal use. Not a scaling architecture. If Orpheus ever gets multi-user or multi-writer, migrate to Postgres before that point, not after.

- **No backups.** The Railway volume is not backed up. Catastrophic data loss is possible. Consider periodic SQLite snapshots to Railway's object storage or an external bucket when the data becomes valuable enough to lose sleep over.
