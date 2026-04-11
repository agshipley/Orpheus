# Pylon — Observability Layer

Pylon is Orpheus' built-in observability system. It provides three pillars
of insight into system behavior without requiring external infrastructure.

## Why "Pylon"?

In the Orpheus metaphor, pylons are the structural supports. Observability
supports everything else — without it, you're flying blind.

## Tracing

### Concepts

- **Trace**: A complete request lifecycle (e.g., one search operation)
- **Span**: A unit of work within a trace (e.g., one agent's search)
- **Event**: A point-in-time annotation on a span
- **Attribute**: Key-value metadata on a span

### Usage

```typescript
import { getTracer } from './observability/index.js';

const tracer = getTracer();

// Start a trace
const rootSpan = tracer.startTrace('my.operation');
rootSpan.setAttribute('query', 'typescript engineer');

// Create child spans
const childSpan = rootSpan.startChild('sub.operation');
childSpan.addEvent('step.completed', { items: 42 });
childSpan.end();

// Use the traced() helper for automatic error handling
const result = await tracer.traced('async.work', rootSpan, async (span) => {
  span.setAttribute('step', 'processing');
  return await doWork();
});

rootSpan.end();
```

### Trace Output

```json
{
  "traceId": "arc_7f3a2b1c9d4e5f6g",
  "name": "conductor.search",
  "durationMs": 2847,
  "status": "ok",
  "attributes": {
    "query.raw": "senior typescript engineer remote",
    "duration_ms": 2847
  },
  "children": [
    {
      "name": "conductor.parse_query",
      "durationMs": 245,
      "attributes": { "query.title": "Senior TypeScript Engineer" }
    },
    {
      "name": "conductor.fan_out",
      "durationMs": 2100,
      "children": [
        { "name": "agent.linkedin.search", "durationMs": 1800 },
        { "name": "agent.indeed.search", "durationMs": 1200 },
        { "name": "agent.github.search", "durationMs": 900 }
      ]
    }
  ]
}
```

## Metrics

### Registered Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `orpheus_searches_total` | counter | Total search operations |
| `orpheus_agent_calls_total` | counter | Agent invocations by source |
| `orpheus_agent_errors_total` | counter | Agent errors by source and code |
| `orpheus_jobs_found_total` | counter | Jobs discovered by source |
| `orpheus_jobs_deduplicated_total` | counter | Duplicate jobs removed |
| `orpheus_search_latency_ms` | histogram | End-to-end search latency |
| `orpheus_agent_latency_ms` | histogram | Per-agent latency |
| `orpheus_llm_tokens_total` | counter | LLM tokens consumed |
| `orpheus_llm_cost_usd` | counter | Cumulative LLM spend |
| `orpheus_content_generations_total` | counter | Content pieces generated |
| `orpheus_tool_calls_total` | counter | MCP tool invocations |
| `orpheus_cache_hits_total` | counter | Cache hits |
| `orpheus_cache_misses_total` | counter | Cache misses |

### Usage

```typescript
import { getMetrics } from './observability/index.js';

const metrics = getMetrics();

metrics.increment('orpheus_searches_total');
metrics.observe('orpheus_search_latency_ms', 2847, { source: 'linkedin' });
metrics.gauge('active_agents', 3);

// Export
console.log(metrics.toConsole());    // Human-readable
console.log(metrics.toPrometheus()); // Prometheus exposition format
```

### Histogram Percentiles

Histograms automatically compute p50, p90, p95, and p99:

```
orpheus_search_latency_ms (histogram): Search latency in ms
  p50=1200.0ms p90=2800.0ms p95=3500.0ms p99=4200.0ms count=47 sum=89400.0ms
```

## Decision Log

The decision log captures *why* the system made each choice, not just *what* it did.

### When Decisions Are Logged

- Query parsing: "Interpreted 'TS engineer' as title='TypeScript Engineer'"
- Agent failure handling: "LinkedIn agent timed out, continuing with 2/3 agents"
- Ranking: "Used heuristic ranking (result set < 10, LLM unnecessary)"
- Content strategy: "Generated 3 strategies: narrative, technical, cultural"
- Deduplication: "Removed 16 duplicates across LinkedIn/Indeed overlap"

### Decision Log Entry

```json
{
  "traceId": "arc_7f3a...",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "component": "conductor.ranker",
  "decision": "Selected heuristic ranking over LLM ranking",
  "reasoning": "Result set size (7) below LLM threshold (10). Heuristic ranking is faster and cheaper for small sets.",
  "inputs": { "resultCount": 7, "threshold": 10 },
  "output": { "method": "heuristic" },
  "alternatives": [
    { "option": "heuristic", "score": 0.9, "reason": "Fast, zero cost" },
    { "option": "llm_ranking", "score": 0.7, "reason": "Better quality but ~$0.003 cost" }
  ]
}
```

### Log Levels

- **minimal**: Decision + reasoning only (no inputs, no alternatives)
- **standard**: Decision + reasoning + truncated inputs + alternatives
- **detailed**: Everything, including full input payloads

### Cost Tracking

Every LLM call is tracked with token counts and estimated cost:

```typescript
const summary = decisionLog.getCostSummary();
// {
//   totalUsd: 0.0847,
//   byModel: { "claude-sonnet-4-20250514": 0.0847 },
//   byComponent: {
//     "conductor.query_parser": 0.0023,
//     "conductor.ranker": 0.0084,
//     "resume_tailor": 0.0420,
//     "cover_letter_generator": 0.0320
//   },
//   entryCount: 12
// }
```

## Dashboard

The CLI dashboard (`orpheus dashboard`) displays a live view of:
- Metric snapshots with histogram percentiles
- Recent traces with timing
- Recent decisions with reasoning
- Cost summary by model and component

## Extending Pylon

### Custom Metric Export

```typescript
const metrics = getMetrics();

// Export to your monitoring system
setInterval(() => {
  const snapshot = metrics.snapshot();
  myMonitoringClient.send(snapshot);
}, 60_000);
```

### Custom Trace Export

```typescript
const tracer = getTracer();

tracer.on('span:end', (span) => {
  if (span.durationMs && span.durationMs > 5000) {
    alerting.warn(`Slow span: ${span.name} took ${span.durationMs}ms`);
  }
});
```
