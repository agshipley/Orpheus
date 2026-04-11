#!/usr/bin/env bash
# demo.sh — Orpheus end-to-end demo
#
# Records well with asciinema:
#   asciinema rec demo.cast --command ./scripts/demo.sh
#
# Prerequisites:
#   • ANTHROPIC_API_KEY set in .env or the environment
#   • jq installed  (brew install jq / apt install jq)
#   • npm install has been run

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────
QUERY="${ORPHEUS_DEMO_QUERY:-"typescript engineer remote"}"
RESULTS_TMP="$(mktemp /tmp/orpheus_demo_XXXXXX.json)"
trap 'rm -f "$RESULTS_TMP"' EXIT   # clean up on exit

# ── Helpers ────────────────────────────────────────────────────────────────────

# Print a section banner, then pause so asciinema viewers can read it.
section() {
  printf '\n\033[1;36m━━━  %s  ━━━\033[0m\n\n' "$1"
  sleep 1
}

# Require a command; exit with a friendly message if it's missing.
need() {
  command -v "$1" &>/dev/null || {
    echo "Error: '$1' is required but not installed."
    echo "  $2"
    exit 1
  }
}

# Change to the project root regardless of where the script is called from.
cd "$(dirname "$0")/.."

# ── Preflight checks ───────────────────────────────────────────────────────────
need jq   "Install with: brew install jq  (macOS) or  apt install jq  (Linux)"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]] && ! grep -q 'ANTHROPIC_API_KEY' .env 2>/dev/null; then
  echo "Error: ANTHROPIC_API_KEY is not set."
  echo "  Add it to .env or export it before running this script."
  exit 1
fi

# ── Introduction ───────────────────────────────────────────────────────────────
clear
printf '\033[1;37m'
cat <<'BANNER'
  ╔═══════════════════════════════════════════════════╗
  ║              Orpheus  ·  Job Search Engine        ║
  ║     AI-powered · MCP architecture · Observable   ║
  ╚═══════════════════════════════════════════════════╝
BANNER
printf '\033[0m'
printf '\n  Query: \033[1;33m"%s"\033[0m\n' "$QUERY"
sleep 2

# ── Step 1: Search ─────────────────────────────────────────────────────────────
section "Step 1 of 4 — Search for jobs"

# Run the search with three flags at once:
#   --json   Machine-readable output so we can extract the top job ID below.
#            The spinner and span trace tree always go to stderr, so they still
#            appear live in the terminal.
#   --save   Persist ranked results to data/orpheus.db for the apply step.
#   --limit  Keep the live table readable; we only apply for the top result.
#
# stderr (spinner + trace tree) → /dev/tty so it prints to the terminal.
# stdout (JSON)                 → tee to both the temp file and a jq formatter.
npx tsx src/cli.ts search "$QUERY" --json --save --limit 10 2>/dev/tty \
  | tee "$RESULTS_TMP" \
  | jq -r '
      "  Found \(.stats.afterDedup) jobs  (\(.stats.totalFound) raw, \(.stats.totalFound - .stats.afterDedup) duplicates removed)",
      "  Duration: \(.stats.durationMs)ms  ·  Agents: \(.stats.agentsSucceeded)/\(.stats.agentsQueried)  ·  Cost: $\(.stats.estimatedCostUsd | . * 10000 | round / 10000)",
      "",
      "  \("ID" | . + (" " * (12 - length)))  \("Title" | . + (" " * (32 - length)))  \("Company" | . + (" " * (20 - length)))  Score",
      "  \("-" * 12)  \("-" * 32)  \("-" * 20)  -----",
      (.jobs[:10] | .[] |
        "  \(.id[0:12])  \((.title[0:32]) | . + (" " * (32 - length)))  \((.company[0:20]) | . + (" " * (20 - length)))  \(.matchScore // 0 | . * 100 | round)%"
      )
    '

sleep 2

# ── Step 2: Pick the top result ────────────────────────────────────────────────
section "Step 2 of 4 — Select the top-ranked result"

# Parse the first job's ID and title from the JSON we captured in step 1.
TOP_ID=$(jq -r '.jobs[0].id // empty' "$RESULTS_TMP")
TOP_TITLE=$(jq -r '.jobs[0].title // "Unknown"' "$RESULTS_TMP")
TOP_COMPANY=$(jq -r '.jobs[0].company // "Unknown"' "$RESULTS_TMP")

if [[ -z "$TOP_ID" ]]; then
  echo "  No results returned — check your API key and network connection."
  exit 1
fi

printf '  \033[1;37m%s\033[0m  at  \033[1;37m%s\033[0m\n' "$TOP_TITLE" "$TOP_COMPANY"
printf '  Job ID: \033[2m%s\033[0m\n' "$TOP_ID"
sleep 2

# ── Step 3: Generate a cover letter ───────────────────────────────────────────
section "Step 3 of 4 — Generate a tailored cover letter"

# The apply command reads the job from the SQLite database written in step 1.
# --cover-letter asks Claude to write a letter that highlights the candidate's
# most relevant skills for this specific role.
# --tone and --variants let you tune the output; defaults are sensible.
npx tsx src/cli.ts apply "$TOP_ID" --cover-letter --tone conversational --variants 1

sleep 2

# ── Step 4: Observability dashboard ───────────────────────────────────────────
section "Step 4 of 4 — View the observability dashboard"

# The dashboard reads data/dashboard-state.json written after the search.
# Piping empty stdin causes Ink to render once and exit (non-TTY path), which
# is ideal for a scripted recording.
#
# To explore interactively after the demo, run:
#   npx tsx src/cli.ts dashboard
# and press q to quit.
echo "" | npx tsx src/cli.ts dashboard

# ── Done ───────────────────────────────────────────────────────────────────────
printf '\n\033[1;32m  ✓ Demo complete.\033[0m\n'
printf '  Try an interactive search:  \033[1mnpx tsx src/cli.ts search "%s"\033[0m\n\n' "$QUERY"
