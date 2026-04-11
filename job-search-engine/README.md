# 🔍 Orpheus — AI-Powered Job Search Engine

> *"Give me a lever long enough and a fulcrum on which to place it, and I shall move the world."*

An agentic job search platform built on the **Model Context Protocol (MCP)** that orchestrates parallel search agents, generates tailored application materials, and provides full observability into every decision the system makes.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Orpheus Core                         │
│                                                             │
│  ┌──────────┐   ┌──────────────┐   ┌────────────────────┐  │
│  │ Conductor│──▶│ Agent Pool   │──▶│ Content Generator  │  │
│  │ (Orch.)  │   │ (Parallel)   │   │ (Resume/CL/Email)  │  │
│  └────┬─────┘   └──────┬───────┘   └────────┬───────────┘  │
│       │                │                     │              │
│       ▼                ▼                     ▼              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              MCP Server Layer                        │   │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐  │   │
│  │  │LinkedIn│ │Indeed  │ │GitHub  │ │ Custom Board │  │   │
│  │  │ Agent  │ │ Agent  │ │ Jobs   │ │   Scraper    │  │   │
│  │  └────────┘ └────────┘ └────────┘ └──────────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
│       │                │                     │              │
│       ▼                ▼                     ▼              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           Observability Layer (Pylon)                │   │
│  │  Traces · Metrics · Decision Logs · Cost Tracking    │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### Why MCP?
The Model Context Protocol provides a standardized interface for AI agents to interact with external tools and data sources. By building each job board integration as an MCP server, we get:
- **Hot-swappable data sources** — add a new job board without touching orchestration logic
- **Typed tool interfaces** — every agent interaction is schema-validated
- **Protocol-level observability** — intercept and log every tool call at the transport layer

### Why Parallel Agents?
Job searching is embarrassingly parallel. Each source is independent, results need deduplication but not coordination. We use a **fan-out/fan-in** pattern:
1. The **Conductor** fans out search queries to N agents simultaneously
2. Each agent operates independently with its own MCP client session
3. Results stream back through an async merge with deduplication
4. The Conductor ranks and filters the unified result set

### Why a Custom Observability Layer?
LLM-powered systems are notoriously hard to debug. Pylon (our observability layer) captures:
- **Traces**: Full request lifecycle from query → agent dispatch → tool calls → LLM inference → content generation
- **Metrics**: Latency percentiles, token usage, cost per search, cache hit rates
- **Decision Logs**: Why did the ranker score job X higher than job Y? What prompt produced this cover letter?
- **Audit Trail**: Every LLM call with full prompt/completion pairs for reproducibility

---

## Project Structure

```
orpheus/
├── src/
│   ├── conductor/              # Orchestration layer
│   │   ├── conductor.ts        # Main orchestrator
│   │   ├── query_planner.ts    # Decomposes user intent into search queries
│   │   └── result_merger.ts    # Deduplication & ranking
│   │
│   ├── agents/                 # Parallel search agents
│   │   ├── base_agent.ts       # Abstract agent with MCP client
│   │   ├── linkedin_agent.ts   # LinkedIn Jobs integration
│   │   ├── indeed_agent.ts     # Indeed integration
│   │   ├── github_agent.ts     # GitHub Jobs integration
│   │   └── custom_agent.ts     # Generic scraper agent
│   │
│   ├── mcp/                    # MCP server implementations
│   │   ├── server.ts           # Base MCP server factory
│   │   ├── tools/              # Tool definitions per source
│   │   │   ├── search.ts       # search_jobs tool
│   │   │   ├── detail.ts       # get_job_detail tool
│   │   │   └── apply.ts        # submit_application tool
│   │   ├── resources/          # MCP resources (user profile, preferences)
│   │   │   ├── profile.ts
│   │   │   └── preferences.ts
│   │   └── prompts/            # MCP prompt templates
│   │       ├── search.ts
│   │       └── analyze.ts
│   │
│   ├── content/                # AI content generation
│   │   ├── resume_tailor.ts    # Resume customization engine
│   │   ├── cover_letter.ts     # Cover letter generator
│   │   ├── email_drafter.ts    # Outreach email composer
│   │   └── templates/          # Base templates & few-shot examples
│   │
│   ├── observability/          # Pylon — observability layer
│   │   ├── tracer.ts           # Distributed tracing
│   │   ├── metrics.ts          # Metrics collection & export
│   │   ├── decision_log.ts     # Structured decision logging
│   │   ├── cost_tracker.ts     # LLM cost accounting
│   │   └── dashboard.ts        # Terminal dashboard renderer
│   │
│   ├── storage/                # Persistence layer
│   │   ├── job_store.ts        # Job listing storage & dedup
│   │   ├── application_store.ts # Application tracking
│   │   └── vector_store.ts     # Embedding-based similarity search
│   │
│   └── config/                 # Configuration
│       ├── schema.ts           # Zod config schemas
│       └── defaults.ts         # Default configuration
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
│
├── docs/
│   ├── architecture.md         # Deep-dive architecture doc
│   ├── mcp-protocol.md         # MCP implementation details
│   └── observability.md        # Pylon documentation
│
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── .github/
    └── workflows/
        └── ci.yml
```

---

## Quick Start

```bash
# Clone & install
git clone https://github.com/youruser/orpheus.git
cd orpheus
npm install

# Configure
cp .env.example .env
# Add your API keys (Anthropic, job board APIs)

# Run a search
npx tsx src/cli.ts search "senior typescript engineer, remote, $180k+"

# Launch the observability dashboard
npx tsx src/cli.ts dashboard

# Generate tailored materials for a specific job
npx tsx src/cli.ts apply <job-id> --resume --cover-letter
```

---

## Configuration

```yaml
# orpheus.config.yaml
profile:
  name: "Your Name"
  resume_path: "./resume.pdf"
  skills: ["TypeScript", "Python", "System Design", "MCP"]
  preferences:
    remote: true
    salary_min: 150000
    locations: ["San Francisco", "New York", "Remote"]
    industries: ["AI/ML", "Developer Tools", "Infrastructure"]

agents:
  concurrency: 5
  timeout_ms: 30000
  sources:
    - linkedin
    - indeed
    - github
    - ycombinator

observability:
  trace_sampling_rate: 1.0  # Sample everything in dev
  metrics_export: "console"  # or "prometheus", "otlp"
  decision_log_level: "detailed"
  cost_tracking: true

content:
  model: "claude-sonnet-4-20250514"
  temperature: 0.7
  max_variants: 3  # Generate N cover letter variants
```

---

## MCP Protocol Design

Each job board integration exposes a standard set of MCP tools:

| Tool | Description | Parameters |
|------|-------------|------------|
| `search_jobs` | Query job listings | `query`, `location`, `filters` |
| `get_job_detail` | Fetch full job description | `job_id` |
| `check_salary` | Estimate compensation range | `job_id`, `location` |
| `submit_application` | Submit application materials | `job_id`, `resume`, `cover_letter` |

And MCP resources for stateful context:

| Resource | Description |
|----------|-------------|
| `profile://user` | Current user profile & resume |
| `preferences://search` | Search preferences & filters |
| `history://applications` | Past applications & outcomes |

---

## Observability: Pylon

Every operation produces structured traces:

```json
{
  "trace_id": "arc_7f3a...",
  "span": "conductor.search",
  "duration_ms": 2847,
  "children": [
    {
      "span": "agent.linkedin.search",
      "duration_ms": 1203,
      "tool_calls": 3,
      "results_found": 47,
      "tokens_used": 1840,
      "cost_usd": 0.0055
    },
    {
      "span": "agent.indeed.search",
      "duration_ms": 890,
      "tool_calls": 2,
      "results_found": 31,
      "tokens_used": 1520,
      "cost_usd": 0.0046
    }
  ],
  "merged_results": 62,
  "deduplicated": 16,
  "final_ranked": 62
}
```

---

## License

MIT

---

*Built to demonstrate production-grade MCP architecture, agentic orchestration, and AI-native workflows.*
