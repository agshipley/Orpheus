/**
 * Orpheus Dashboard — Terminal UI built with Ink.
 *
 * Three panels rendered from persisted state written by the search command:
 *   1. Trace waterfall  — span tree with relative timing bars
 *   2. Metrics table    — latency histograms (p50/p90/p95/p99) + key counters
 *   3. Cost breakdown   — LLM spend per component
 *
 * State is saved to ./data/dashboard-state.json after each search so the
 * dashboard can be opened in a separate process without needing live data.
 *
 * Press q (or Escape) to quit.
 */

import React, { useMemo } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import type { Span, CostEntry } from "../types.js";
import type { MetricSnapshot } from "../observability/metrics.js";

// ─── Public State Type ───────────────────────────────────────────
// Written by cli.ts after each search; read back by the dashboard command.

export interface DashboardState {
  savedAt: string;
  searchQuery: string;
  stats: {
    totalFound: number;
    afterDedup: number;
    durationMs: number;
    agentsQueried: number;
    agentsSucceeded: number;
    totalTokensUsed: number;
    estimatedCostUsd: number;
  };
  trace: Span | null;
  metricsSnapshot: MetricSnapshot[];
  costSummary: {
    totalUsd: number;
    byModel: Record<string, number>;
    byComponent: Record<string, number>;
    entryCount: number;
  };
  costEntries: CostEntry[];
}

// ─── Layout constants ────────────────────────────────────────────

const LABEL_W = 32; // span name column width
const BAR_W   = 36; // waterfall bar area width
const DUR_W   =  8; // duration column width (e.g. " 2148ms")

const METRIC_NAME_W = 38;
const METRIC_VAL_W  =  9;

const DIVIDER = "─".repeat(LABEL_W + BAR_W + DUR_W + 2);

// ─── Helpers ─────────────────────────────────────────────────────

function pad(s: string, w: number, right = false): string {
  const t = s.slice(0, w);
  return right ? t.padStart(w) : t.padEnd(w);
}

function fmtMs(ms: number): string {
  if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function fmtUsd(usd: number): string {
  return usd < 0.0001 ? "<$0.0001" : `$${usd.toFixed(4)}`;
}

// ─── Waterfall helpers ────────────────────────────────────────────

interface WaterfallRow {
  depth: number;
  name: string;
  offsetMs: number;
  durationMs: number;
  status: "ok" | "error" | "timeout";
}

function flattenTrace(span: Span, rootStart: number, depth = 0): WaterfallRow[] {
  const rows: WaterfallRow[] = [
    {
      depth,
      name: span.name,
      offsetMs: Math.max(0, span.startTime - rootStart),
      durationMs: span.durationMs ?? 0,
      status: span.status,
    },
  ];
  for (const child of span.children) {
    rows.push(...flattenTrace(child, rootStart, depth + 1));
  }
  return rows;
}

// ─── Section: Divider ────────────────────────────────────────────

const Divider: React.FC = () => (
  <Text color="gray">{DIVIDER}</Text>
);

// ─── Section: Header ─────────────────────────────────────────────

const Header: React.FC<{ state: DashboardState }> = ({ state }) => {
  const { stats } = state;
  const saved = new Date(state.savedAt).toLocaleTimeString();

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="white"> Orpheus Dashboard  </Text>
        <Text color="dim">
          · last search at {saved}
        </Text>
      </Box>
      <Box marginTop={1} gap={3}>
        <Text color="cyan">"{state.searchQuery}"</Text>
        <Text color="dim">
          {fmtMs(stats.durationMs)} · {stats.afterDedup} jobs
          ({stats.totalFound} raw) · {stats.agentsSucceeded}/{stats.agentsQueried} agents
        </Text>
      </Box>
    </Box>
  );
};

// ─── Section: Trace Waterfall ─────────────────────────────────────

const WaterfallBar: React.FC<{
  offsetMs: number;
  durationMs: number;
  totalMs: number;
  status: "ok" | "error" | "timeout";
}> = ({ offsetMs, durationMs, totalMs, status }) => {
  const total = Math.max(totalMs, 1);
  const offsetChars = Math.min(
    BAR_W - 1,
    Math.floor((offsetMs / total) * BAR_W)
  );
  const barChars = Math.max(
    1,
    Math.min(BAR_W - offsetChars, Math.floor((durationMs / total) * BAR_W))
  );
  const color = status === "error" ? "red" : status === "timeout" ? "yellow" : "cyan";

  return (
    <Text>
      {" ".repeat(offsetChars)}
      <Text color={color}>{"█".repeat(barChars)}</Text>
    </Text>
  );
};

const TraceWaterfall: React.FC<{ state: DashboardState }> = ({ state }) => {
  const { trace, stats } = state;
  const totalMs = stats.durationMs;

  const rows = useMemo(
    () => (trace ? flattenTrace(trace, trace.startTime) : []),
    [trace]
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold color="white">TRACE WATERFALL</Text>
        {trace && (
          <Text color="gray">  {trace.traceId}</Text>
        )}
      </Box>

      {!trace || rows.length === 0 ? (
        <Text color="gray">  No trace data</Text>
      ) : (
        rows.map((row, i) => {
          const indent = "  ".repeat(row.depth);
          const rawLabel = indent + (row.status === "error" ? "✗ " : "") + row.name;
          const label = pad(rawLabel, LABEL_W);
          const dur = pad(fmtMs(row.durationMs), DUR_W, true);
          const labelColor = row.status === "error" ? "red" : "dim";

          return (
            <Box key={i} flexDirection="row">
              <Box width={LABEL_W} flexShrink={0}>
                <Text color={labelColor}>{label}</Text>
              </Box>
              <Box width={BAR_W} flexShrink={0}>
                <WaterfallBar
                  offsetMs={row.offsetMs}
                  durationMs={row.durationMs}
                  totalMs={totalMs}
                  status={row.status}
                />
              </Box>
              <Box width={DUR_W} flexShrink={0}>
                <Text color="dim">{dur}</Text>
              </Box>
            </Box>
          );
        })
      )}
    </Box>
  );
};

// ─── Section: Metrics Table ──────────────────────────────────────

const MetricsTable: React.FC<{ snapshots: MetricSnapshot[] }> = ({ snapshots }) => {
  // Histograms with percentile data
  const histograms = snapshots.filter(
    (s) => s.type === "histogram" && s.percentiles && s.percentiles.count > 0
  );

  // Key counters — only those with a non-zero total
  const counters = snapshots.filter((s) => {
    if (s.type !== "counter") return false;
    const total = s.series.reduce((sum, sr) => sum + sr.value, 0);
    return total > 0;
  });

  // Shorten metric names: strip the "orpheus_" prefix for display
  const shortName = (n: string) => n.replace(/^orpheus_/, "");

  const Col: React.FC<{
    w: number;
    right?: boolean;
    color?: string;
    bold?: boolean;
    children: React.ReactNode;
  }> = ({ w, right = false, color, bold, children }) => (
    <Box width={w} flexShrink={0} justifyContent={right ? "flex-end" : "flex-start"}>
      <Text color={color} bold={bold}>{children}</Text>
    </Box>
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="white">METRICS</Text>

      {/* Histogram table */}
      {histograms.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {/* Header row */}
          <Box>
            <Col w={METRIC_NAME_W} color="gray"> </Col>
            {["p50", "p90", "p95", "p99", "count"].map((h) => (
              <Col key={h} w={METRIC_VAL_W} right color="gray">{h}</Col>
            ))}
          </Box>
          {histograms.map((s) => {
            const p = s.percentiles!;
            return (
              <Box key={s.name}>
                <Col w={METRIC_NAME_W} color="dim">{shortName(s.name)}</Col>
                <Col w={METRIC_VAL_W} right color="cyan">{fmtMs(Math.round(p.p50))}</Col>
                <Col w={METRIC_VAL_W} right color="cyan">{fmtMs(Math.round(p.p90))}</Col>
                <Col w={METRIC_VAL_W} right color="cyan">{fmtMs(Math.round(p.p95))}</Col>
                <Col w={METRIC_VAL_W} right color="cyan">{fmtMs(Math.round(p.p99))}</Col>
                <Col w={METRIC_VAL_W} right color="dim">{String(p.count)}</Col>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Counters */}
      {counters.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">  Counters</Text>
          {counters.map((s) => {
            const total = s.series.reduce((sum, sr) => sum + sr.value, 0);
            return (
              <Box key={s.name}>
                <Box width={2} flexShrink={0}><Text> </Text></Box>
                <Col w={METRIC_NAME_W} color="dim">{shortName(s.name)}</Col>
                <Col w={METRIC_VAL_W} right color="white">{String(total)}</Col>
              </Box>
            );
          })}
        </Box>
      )}

      {histograms.length === 0 && counters.length === 0 && (
        <Text color="gray">  No metrics recorded yet</Text>
      )}
    </Box>
  );
};

// ─── Section: Cost Breakdown ──────────────────────────────────────

const CostBreakdown: React.FC<{
  summary: DashboardState["costSummary"];
  entries: CostEntry[];
}> = ({ summary, entries }) => {
  // Aggregate by component
  const byComponent = new Map<
    string,
    { inputTokens: number; outputTokens: number; costUsd: number }
  >();

  for (const e of entries) {
    const existing = byComponent.get(e.component) ?? {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    byComponent.set(e.component, {
      inputTokens: existing.inputTokens + e.inputTokens,
      outputTokens: existing.outputTokens + e.outputTokens,
      costUsd: existing.costUsd + e.costUsd,
    });
  }

  const COL_COMP = 32;
  const COL_TOK  = 10;
  const COL_COST = 10;

  const Col: React.FC<{
    w: number;
    right?: boolean;
    color?: string;
    bold?: boolean;
    children: React.ReactNode;
  }> = ({ w, right = false, color, bold, children }) => (
    <Box width={w} flexShrink={0} justifyContent={right ? "flex-end" : "flex-start"}>
      <Text color={color} bold={bold}>{children}</Text>
    </Box>
  );

  const CostRow: React.FC<{
    comp: string;
    tokIn: number;
    tokOut: number;
    cost: number;
    bold?: boolean;
  }> = ({ comp, tokIn, tokOut, cost, bold = false }) => (
    <Box>
      <Col w={COL_COMP} color={bold ? "white" : "dim"} bold={bold}>{comp}</Col>
      <Col w={COL_TOK} right color={bold ? "white" : "cyan"} bold={bold}>{String(tokIn)}</Col>
      <Col w={COL_TOK} right color={bold ? "white" : "cyan"} bold={bold}>{String(tokOut)}</Col>
      <Col w={COL_COST} right color={bold ? "yellow" : "dim"} bold={bold}>{fmtUsd(cost)}</Col>
    </Box>
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="white">COST BREAKDOWN</Text>

      {entries.length === 0 ? (
        <Text color="gray">  No LLM calls recorded</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {/* Header */}
          <Box>
            <Col w={COL_COMP} color="gray">Component</Col>
            <Col w={COL_TOK} right color="gray">Tokens In</Col>
            <Col w={COL_TOK} right color="gray">Tokens Out</Col>
            <Col w={COL_COST} right color="gray">Cost</Col>
          </Box>

          {/* Per-component rows */}
          {Array.from(byComponent.entries()).map(([comp, v]) => (
            <CostRow
              key={comp}
              comp={comp.replace("conductor.", "")}
              tokIn={v.inputTokens}
              tokOut={v.outputTokens}
              cost={v.costUsd}
            />
          ))}

          {/* Total */}
          <Text color="gray">{"─".repeat(COL_COMP + COL_TOK + COL_TOK + COL_COST)}</Text>
          <CostRow
            comp="Total"
            tokIn={entries.reduce((s, e) => s + e.inputTokens, 0)}
            tokOut={entries.reduce((s, e) => s + e.outputTokens, 0)}
            cost={summary.totalUsd}
            bold
          />

          {/* Model breakdown if more than one model used */}
          {Object.keys(summary.byModel).length > 1 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">  By model:</Text>
              {Object.entries(summary.byModel).map(([model, cost]) => (
                <Box key={model}>
                  <Box width={2} flexShrink={0}><Text> </Text></Box>
                  <Col w={COL_COMP - 2} color="dim">{model}</Col>
                  <Col w={COL_COST} right color="dim">{fmtUsd(cost)}</Col>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

// ─── Root Component ───────────────────────────────────────────────

export const Dashboard: React.FC<{ state: DashboardState }> = ({ state }) => {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();

  // Only wire keyboard input when running in a real TTY.
  // In piped / non-interactive contexts (CI, tests) raw mode isn't available;
  // in that case the UI renders once and the process exits normally.
  useInput(
    (input, key) => {
      if (input === "q" || key.escape) exit();
    },
    { isActive: isRawModeSupported }
  );

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Header state={state} />
      <Divider />
      <Box marginTop={1}>
        <TraceWaterfall state={state} />
      </Box>
      <Divider />
      <Box marginTop={1}>
        <MetricsTable snapshots={state.metricsSnapshot} />
      </Box>
      <Divider />
      <Box marginTop={1}>
        <CostBreakdown
          summary={state.costSummary}
          entries={state.costEntries}
        />
      </Box>
      <Divider />
      <Box marginTop={1}>
        <Text color="gray">  Press </Text>
        <Text color="white" bold>q</Text>
        <Text color="gray"> to quit</Text>
      </Box>
    </Box>
  );
};
