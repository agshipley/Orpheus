# Orpheus — AI-Powered Job Search Engine

> Orchestrates parallel search agents, generates tailored application materials,
> and exposes full observability into every decision the system makes.

---

## Demo

<!-- After recording, replace this block with one of:
     • asciinema.org embed:  [![asciicast](https://asciinema.org/a/XXXX.svg)](https://asciinema.org/a/XXXX)
     • GIF from agg:         ![demo](docs/demo.gif)
-->

**Record it yourself (requires [asciinema](https://asciinema.org) and [jq](https://jqlang.github.io/jq)):**

```bash
asciinema rec demo.cast --command bash scripts/demo.sh
```

The script walks through four steps automatically:

1. **Search** — queries the live HN "Who is Hiring?" thread, shows a ranked results table
2. **Pick** — selects the top-ranked job
3. **Cover letter** — generates a tailored cover letter with Claude
4. **Dashboard** — renders the Ink TUI with trace waterfall, latency percentiles, and cost breakdown

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        Orpheus                                 │
│                                                                │
│  ┌──────────┐   ┌──────────────┐   ┌────────────────────────┐  │
│  │Conductor │──▶│  Agent Pool  │──▶│   Content Generator    │  │
│  │  (orch.) │   │  (parallel)  │   │  Resume · CL · Email   │  │
│  └────┬─────┘   └──────┬───────┘   └──────────┬─────────────┘  │
│       │                │                       │               │
│       ▼                ▼                       ▼               │
│  ┌────────────────────────────────────────────────────────┐    │
│  │                  MCP Server Layer                      │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │    │
│  │  │ LinkedIn │ │  Indeed  │ │  GitHub  │ │HN  Jobs  │  │    │
│  │  │  Agent   │ │  Agent   │ │  Agent   │ │  Agent   │  │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │    │
│  └────────────────────────────────────────────────────────┘    │
│       │                │                       │               │
│       ▼                ▼                       ▼               │
│  ┌────────────────────────────────────────────────────────┐    │
│  │             Observability Layer (Pylon)                │    │
│  │    Traces · Metrics · Decision Logs · Cost Tracking    │    │
│  └────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### Why MCP?
The Model Context Protocol provides a standardised interface for AI agents to interact
with external tools and data sources. Each job board integration is an independent MCP
stdio server, which means:
- **Hot-swappable sources** — add a new job board without touching orchestration logic
- **Typed tool interfaces** — every agent interaction is schema-validated
- **Protocol-level observability** — intercept and log every tool call at the transport layer

### Why Parallel Agents?
Job searching is embarrassingly parallel. Each source is independent; results need
deduplication but not coordination. The pipeline uses a **fan-out / fan-in** pattern:
1. The **Conductor** fans out search queries to N agents simultaneously
2. Each agent operates independently with its own MCP client session
3. Results stream back through an async merge with deduplication
4. The Conductor ranks and filters the unified result set

### Why a Custom Observability Layer?
LLM-powered systems are notoriously hard to debug. Pylon captures:
- **Traces** — full request lifecycle from query → agent dispatch → tool calls → LLM inference
- **Metrics** — latency percentiles (p50/p90/p95/p99), token usage, cost per search
- **Decision Logs** — why did the ranker score job X higher than Y? what prompt produced this cover letter?
- **Cost Tracking** — per-component USD breakdown for every LLM call

---

## Project Structure

```
job-search-engine/
├── src/
│   ├── conductor/
│   │   ├── conductor.ts        # Orchestrator — fan-out, merge, rank
│   │   ├── query_planner.ts    # Decomposes free-text intent into structured queries
│   │   └── result_merger.ts    # Deduplication and relevance ranking
│   │
│   ├── agents/
│   │   ├── base_agent.ts       # Abstract MCP client with auto-connect lifecycle
│   │   ├── hn_agent.ts         # Hacker News "Who is Hiring?" agent  ← live data
│   │   ├── linkedin_agent.ts
│   │   ├── indeed_agent.ts
│   │   └── github_agent.ts
│   │
│   ├── mcp/
│   │   └── server.ts           # MCP server factory (createJobBoardServer)
│   │
│   ├── content/
│   │   ├── resume_tailor.ts    # Resume customisation engine
│   │   ├── cover_letter.ts     # Cover letter generator
│   │   └── email_drafter.ts    # Cold-outreach email composer
│   │
│   ├── observability/
│   │   ├── tracer.ts           # Distributed tracing (SpanBuilder)
│   │   ├── metrics.ts          # Latency histograms + counters
│   │   ├── decision_log.ts     # Structured decision + cost logging
│   │   └── index.ts            # Singleton accessors
│   │
│   ├── storage/
│   │   └── job_store.ts        # SQLite-backed job persistence
│   │
│   ├── ui/
│   │   └── dashboard.tsx       # Ink TUI — trace waterfall, metrics, cost breakdown
│   │
│   └── cli.ts                  # Commander CLI (search / apply / dashboard / stats)
│
├── mcp-servers/
│   ├── hn-jobs/
│   │   └── index.ts            # Live HN Firebase scraper MCP server
│   └── mock/
│       └── index.ts            # Fixture server for integration tests
│
├── tests/
│   ├── unit/                   # Tracer, metrics, decision log
│   └── integration/
│       └── pipeline.test.ts    # Full conductor pipeline (no API keys needed)
│
├── scripts/
│   └── demo.sh                 # asciinema demo script
│
├── docs/
├── orpheus.config.example.yaml
├── package.json
└── tsconfig.json
```

---

## Quick Start

```bash
git clone https://github.com/agshipley/Orpheus.git
cd Orpheus/job-search-engine
npm install

# Add your Anthropic API key
cp .env.example .env
# edit .env: ANTHROPIC_API_KEY=sk-ant-...

# Search the live HN "Who is Hiring?" thread
npx tsx src/cli.ts search "typescript engineer remote"

# Open the observability dashboard
npx tsx src/cli.ts dashboard

# Generate tailored application materials
npx tsx src/cli.ts apply <job-id> --cover-letter --resume
```

The span trace tree prints to stderr as the pipeline runs:

```
▸ conductor.search
  ▸ conductor.parse_query
  ✓ conductor.parse_query     312ms  raw=typescript engineer remote
  ▸ conductor.fan_out
    ▸ agent.ycombinator.connect
    ✓ agent.ycombinator.connect   288ms
    ▸ agent.ycombinator.search
      ▸ mcp.tool.search_jobs
      ✓ mcp.tool.search_jobs   1498ms  count=23
    ✓ agent.ycombinator.search   1508ms  source=ycombinator
  ✓ conductor.fan_out   1798ms  agents=1
  ▸ conductor.merge
  ✓ conductor.merge       2ms  before_dedup=23 after_dedup=21
  ▸ conductor.rank
  ✓ conductor.rank       36ms  ranked=21
✓ conductor.search   2148ms
```

---

## Configuration

Copy `orpheus.config.example.yaml` and customise:

```yaml
profile:
  name: "Your Name"
  skills: ["TypeScript", "Python", "Go", "System Design"]
  preferences:
    remote: true
    salaryMin: 150000
    locations: ["San Francisco", "New York", "Remote"]

agents:
  concurrency: 5
  timeoutMs: 30000
  sources:
    - ycombinator   # live HN "Who is Hiring?" (default)
    # - linkedin
    # - indeed
    # - github

content:
  model: "claude-sonnet-4-20250514"
  temperature: 0.7
  maxVariants: 3
```

---

## MCP Tool Interface

Each job board MCP server implements a standard set of tools:

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `search_jobs` | Query job listings | `query`, `location`, `remote`, `skills` |
| `get_job_detail` | Fetch the full job description | `job_id` |
| `check_salary` | Estimate compensation range | `job_id`, `location` |
| `submit_application` | Submit application materials | `job_id`, `resume`, `cover_letter` |

And MCP resources for stateful context:

| Resource | Description |
|----------|-------------|
| `profile://user` | Current user profile and resume |
| `preferences://search` | Search preferences and filters |

---

## Observability: Pylon

Every operation produces a structured trace. Example from a live search:

```json
{
  "traceId": "orp_7f3a9b2c1d4e5f6a",
  "name": "conductor.search",
  "durationMs": 2148,
  "status": "ok",
  "children": [
    {
      "name": "conductor.parse_query",
      "durationMs": 312
    },
    {
      "name": "agent.ycombinator.search",
      "durationMs": 1508,
      "attributes": {
        "source": "ycombinator",
        "results.count": 23,
        "tokens.used": 0
      }
    },
    {
      "name": "conductor.merge",
      "durationMs": 2,
      "attributes": { "jobs.before_dedup": 23, "jobs.after_dedup": 21 }
    },
    {
      "name": "conductor.rank",
      "durationMs": 36,
      "attributes": { "jobs.ranked": 21, "tokens.used": 472, "cost.usd": 0.0014 }
    }
  ]
}
```

The `dashboard` command renders this as a live terminal UI (press `q` to quit):

```
 Orpheus Dashboard  · last search at 11:53:42 AM

 "typescript engineer remote"   2148ms · 21 jobs · 1/1 agents

 TRACE WATERFALL  orp_7f3a9b2c1d4e5f6a
 conductor.search                ████████████████████████████████████  2148ms
   conductor.parse_query         █████                                  312ms
   conductor.fan_out                  ██████████████████████████████   1798ms
     agent.ycombinator.search              █████████████████████████   1508ms
   conductor.rank                                                   █    36ms

 METRICS
                                          p50      p90      p95      p99  count
 search_latency_ms                     2148ms   2148ms   2148ms   2148ms      1
 agent_latency_ms                      1508ms   1508ms   1508ms   1508ms      1

 COST BREAKDOWN
 Component                        Tokens In Tokens Out       Cost
 query_parser                           350         72    $0.0010
 ranker                                  95         27    $0.0003
 ──────────────────────────────────────────────────────────────
 Total                                  445         99    $0.0014
```

---

## Testing

```bash
npm test                  # unit + integration (no API keys needed)
npm run test:coverage     # with coverage report
```

Integration tests spin up the mock MCP server as a real subprocess and run the
full Conductor pipeline with the Anthropic SDK mocked — no network calls, no
API keys required.

---

## Deployment (Railway)

### One-time setup

```bash
# Install the Railway CLI
npm install -g @railway/cli

# Authenticate
railway login

# Create a new Railway project linked to this directory
railway init
```

### Set environment variables

In the Railway dashboard → your project → Variables, add:

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` |
| `NODE_ENV` | `production` |

Railway injects `PORT` automatically — no need to set it.

### Deploy

```bash
# Build and push to Railway
railway up
```

Railway detects the `Dockerfile` and runs the multi-stage build:
1. Installs root and client dependencies
2. Compiles TypeScript (`dist/`)
3. Bundles the React frontend (`dist/client/`)
4. Produces a lean Alpine image (~`node:20-alpine` + compiled output)

The `railway.toml` configures the health check at `GET /api/health`. Railway will wait for a `{"status":"ok"}` response before routing traffic.

### Subsequent deploys

```bash
railway up
```

Or connect the GitHub repo in the Railway dashboard for automatic deploys on push to `main`.

### Local production preview

```bash
npm run build          # compile server + bundle client
NODE_ENV=production node dist/server/index.js
# → http://localhost:3000
```

---

## License

MIT

---

*Built to demonstrate production-grade MCP architecture, agentic orchestration, and AI-native observability.*
