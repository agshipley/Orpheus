# MCP Protocol Implementation

This document details how Orpheus uses the Model Context Protocol
and why each design choice was made.

## Transport Layer

Orpheus uses **stdio transport** for MCP server communication. Each
MCP server runs as a child process, and the agent communicates via stdin/stdout.

Why stdio over HTTP/SSE?

- **Simplicity**: No port management, no TLS, no CORS
- **Process isolation**: Crashes in a server don't affect the agent
- **Development speed**: `node server.js` is all you need to start a server
- **Testing**: Pipe mock data through stdin for deterministic tests

For production deployments, the transport can be swapped to SSE without
changing the tool interface.

## Tool Design Principles

### 1. Consistent Interface Across Sources

Every job board server exposes the same four tools:

```typescript
search_jobs(params: SearchParams): SearchResult
get_job_detail(params: { jobId: string }): JobDetail
check_salary(params: { jobId: string; location?: string }): SalaryEstimate
submit_application(params: ApplicationParams): ApplicationResult
```

This consistency means the Conductor doesn't need source-specific logic.
It dispatches the same tool call to every agent; the MCP server handles
the translation to source-specific APIs.

### 2. Typed Schemas with Zod

All tool inputs are defined as Zod schemas, providing:
- Runtime validation (bad inputs fail fast with clear errors)
- Type inference (TypeScript types derived from schemas)
- Self-documenting (schema descriptions are surfaced to MCP clients)

### 3. Resource-Based Context

MCP resources provide read-only contextual data:

- `profile://user` — the candidate's profile (skills, experience, preferences)
- `preferences://search` — saved search filters and exclusions
- `history://applications` — past applications for dedup and status tracking

Resources are distinct from tools because they represent state, not actions.
An MCP client can read resources to inform its behavior without triggering
side effects.

### 4. Prompt Templates

MCP prompts encapsulate reusable LLM interaction patterns:

- `analyze_job` — takes a job description and user skills, returns a
  structured match analysis with score and reasoning

Prompts are useful because they standardize the LLM interaction pattern
across different clients. The same `analyze_job` prompt works whether
called from the CLI, a web UI, or Claude Desktop.

## Server Lifecycle

```
┌─────────────────────────────────────────────┐
│ Agent creates StdioClientTransport          │
│     │                                       │
│     ▼                                       │
│ client.connect(transport)                   │
│     │                                       │
│     ▼                                       │
│ MCP handshake (initialize + capabilities)   │
│     │                                       │
│     ▼                                       │
│ client.callTool("search_jobs", params)      │
│     │                                       │
│     ▼                                       │
│ Server executes tool, returns result        │
│     │                                       │
│     ▼                                       │
│ Agent normalizes result → JobListing[]      │
│     │                                       │
│     ▼                                       │
│ client.close() (on agent disconnect)        │
└─────────────────────────────────────────────┘
```

## Adding a New Job Board

To add a new source (e.g., Glassdoor):

1. Create `mcp-servers/glassdoor/index.js` implementing the MCP server
2. Create `src/agents/glassdoor_agent.ts` extending `BaseAgent`
3. Register in `src/agents/index.ts`
4. Add "glassdoor" to config sources

The agent only needs to implement two abstract methods:
- `createTransport()` — how to spawn the MCP server process
- `search()` — how to call tools and normalize results

Everything else (retry logic, tracing, metrics, error classification)
is inherited from `BaseAgent`.

## Observability Integration

Every MCP tool call is automatically traced by `BaseAgent.callTool()`:

```typescript
protected async callTool<T>(
  toolName: string,
  args: Record<string, unknown>,
  parentSpan: SpanBuilder
): Promise<T> {
  const span = parentSpan.startChild(`mcp.tool.${toolName}`);
  // ... execute tool call ...
  span.end();
}
```

This means the trace tree naturally captures MCP tool call latency,
making it trivial to identify slow servers or failing integrations.
