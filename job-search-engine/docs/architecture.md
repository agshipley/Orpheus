# Architecture Deep-Dive

This document explains the technical decisions behind Orpheus in detail,
aimed at reviewers evaluating the system's design sophistication.

## System Layers

### 1. Conductor (Orchestration)

The Conductor implements the **Scatter-Gather** pattern — also known as
fan-out/fan-in — to parallelize job searches across independent data sources.

**Why not a simple sequential loop?**

Job board APIs have variable latency (200ms to 5s). Sequential execution means
total latency = sum of all sources. Parallel execution means total latency ≈
max(any single source). For 4 sources averaging 1.5s each, that's 6s vs ~2s.

**Concurrency control**: We use `p-limit` to bound concurrent agents, preventing
resource exhaustion when many sources are configured. The default concurrency of
5 means at most 5 agents run simultaneously.

**Failure isolation**: Each agent runs in its own error boundary. If LinkedIn's
API is down, Indeed and GitHub results still return. Partial results are always
better than a total failure.

### 2. Agent Pool (Search Execution)

Each agent encapsulates:
- An MCP client session with its own transport
- Source-specific parameter mapping (query → API params)
- Result normalization (API response → `JobListing`)
- Retry logic with exponential backoff
- Error classification (retryable vs fatal)

**Why MCP for job board integrations?**

Using MCP servers for each job board provides several advantages over direct
API client wrappers:

1. **Decoupling**: The agent doesn't import any job-board-specific SDK. It
   speaks MCP. The MCP server handles the SDK complexity.
2. **Process isolation**: Each MCP server runs as a separate process via stdio
   transport, so a segfault in a scraper doesn't crash the conductor.
3. **Substitutability**: Swap a real API server for a mock server with zero
   agent code changes — same tool interface, different implementation.
4. **Composability**: The same MCP server can be used by other MCP clients
   (Claude Desktop, other agents) without modification.

### 3. MCP Server Layer

Each MCP server exposes a standardized tool interface:

```
search_jobs(keywords, location, filters) → JobListing[]
get_job_detail(job_id) → JobDetail
check_salary(job_id, location) → SalaryEstimate
submit_application(job_id, resume, cover_letter) → ApplicationResult
```

Plus MCP resources for contextual data:
- `profile://user` — the candidate's profile
- `preferences://search` — saved search preferences
- `history://applications` — past application outcomes

And MCP prompts for common workflows:
- `analyze_job` — score a job against the user's profile

This tri-pillar design (tools + resources + prompts) is what distinguishes
a well-designed MCP server from a simple tool wrapper.

### 4. Content Generation Pipeline

Content generation follows a multi-pass architecture:

```
Analyze → Strategize → Generate → (optional: Review)
```

**Pass 1 — Analysis**: Extracts structured requirements from the job description
and maps them against the candidate's profile. Outputs: matched skills, missing
skills, key phrases, culture signals.

**Pass 2 — Strategy**: Given the analysis, generates N distinct content strategies.
Each strategy represents a different angle:
- "Narrative Arc" — storytelling approach
- "Technical Proof" — achievement-led, quantified
- "Mission Alignment" — culture and values focus

**Pass 3 — Generation**: Each strategy produces a variant. Variants are scored
for confidence by the model itself (calibrated via few-shot examples).

**Why multiple passes instead of one-shot?**

One-shot generation produces generic output because the model tries to do
everything at once. Decomposing into analyze → strategize → generate lets each
step focus, producing higher-quality output at each stage. The token cost is
~2x a single generation, but the quality improvement is significant.

### 5. Observability Layer (Pylon)

Pylon provides three observability pillars:

#### Tracing
Every operation is captured as a span in a trace tree. Spans nest naturally:

```
conductor.search
  ├── conductor.parse_query (45ms)
  ├── conductor.fan_out (2100ms)
  │   ├── agent.linkedin.search (1800ms)
  │   │   └── mcp.tool.search_jobs (1650ms)
  │   ├── agent.indeed.search (1200ms)
  │   │   └── mcp.tool.search_jobs (1050ms)
  │   └── agent.github.search (900ms)
  │       └── mcp.tool.search_jobs (780ms)
  ├── conductor.merge (12ms)
  └── conductor.rank (350ms)
```

This makes it trivial to identify bottlenecks. In the trace above,
LinkedIn is the slow agent — its MCP tool call takes 1650ms.

#### Metrics
Counters, gauges, and histograms with label-based dimensionality:

- `orpheus_search_latency_ms{p50, p90, p95, p99}` — latency distribution
- `orpheus_agent_calls_total{source=linkedin}` — per-source call counts
- `orpheus_llm_cost_usd{component=ranker}` — cost attribution

Exportable to Prometheus exposition format for integration with Grafana.

#### Decision Logs
Every non-trivial decision is recorded with:
- What was decided
- Why (reasoning)
- What alternatives were considered
- What inputs informed the decision

This is critical for debugging "why did the system rank job X above job Y?"
or "why did the cover letter use this strategy instead of that one?"

## Data Flow

```
User Query (natural language)
    │
    ▼
Query Parser (LLM) ──────────────────▶ Structured SearchQuery
    │
    ▼
Agent Pool (parallel) ────────────────▶ AgentResult[] (per source)
    │  └── MCP Client → MCP Server → Job Board API
    │
    ▼
Merge + Dedup ────────────────────────▶ Unified JobListing[]
    │  └── Dedup key: normalize(title + company)
    │
    ▼
Ranker (heuristic + optional LLM) ───▶ Ranked JobListing[]
    │  └── Score: skill match + title match + salary + remote + recency
    │
    ▼
Display (CLI table)
    │
    ▼ (on user request)
Content Generator ────────────────────▶ Resume / Cover Letter / Email variants
    └── Analyze → Strategize → Generate
```

## Error Handling Philosophy

1. **Fail open**: Agent failures don't block results from other agents
2. **Classify errors**: Rate limits → retry; auth errors → don't retry
3. **Exponential backoff**: 1s → 2s → 4s → 8s, capped at 30s
4. **Cost guard**: Token usage tracked per operation to prevent runaway costs
5. **Graceful degradation**: LLM ranking fails? Fall back to heuristics

## Testing Strategy

- **Unit tests**: Observability primitives (tracer, metrics, decision log)
- **Integration tests**: Dedup and ranking logic with synthetic data
- **E2E tests**: Full pipeline with mock MCP servers (future)
- **Load tests**: Concurrent agent execution under bounded concurrency (future)
