import { useState, useEffect, useCallback } from "react";
import * as api from "../api/client";
import type {
  Span,
  MetricSnapshot,
  DecisionLogEntry,
  CostSummary,
  CostEntry,
} from "../types";

// ─── Shared helpers ───────────────────────────────────────────────

function fmtMs(ms: number): string {
  if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtUsd(usd: number): string {
  return usd < 0.0001 ? "<$0.0001" : `$${usd.toFixed(4)}`;
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-[10px] font-semibold tracking-widest uppercase text-zinc-600 font-mono">
        {title}
      </h2>
      {action}
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg bg-surface border border-border-subtle px-4 py-6 text-center">
      <p className="text-xs text-zinc-600 font-mono">{msg}</p>
    </div>
  );
}

// ─── Trace Waterfall ──────────────────────────────────────────────

function SpanRow({
  span,
  rootStart,
  rootDuration,
  depth,
}: {
  span: Span;
  rootStart: number;
  rootDuration: number;
  depth: number;
}) {
  const total = Math.max(rootDuration, 1);
  const dur = span.durationMs ?? 0;
  const offset = Math.max(0, span.startTime - rootStart);
  const BAR = 120; // px
  const offsetPx = Math.min(BAR - 2, (offset / total) * BAR);
  const barPx = Math.max(2, Math.min(BAR - offsetPx, (dur / total) * BAR));
  const color =
    span.status === "error"   ? "#ef4444" :
    span.status === "timeout" ? "#f59e0b" :
                                "#3B82F6";

  return (
    <>
      <tr className="group hover:bg-elevated/40 transition-colors">
        <td className="py-0.5 pr-4 font-mono text-[11px] whitespace-nowrap">
          <span className="text-zinc-700" style={{ paddingLeft: `${depth * 14}px` }}>
            {span.status === "error" ? (
              <span className="text-red-500">✗ </span>
            ) : (
              <span className="text-zinc-700">{depth > 0 ? "  " : ""}</span>
            )}
          </span>
          <span className={span.status === "error" ? "text-red-400" : "text-zinc-300"}>
            {span.name}
          </span>
        </td>
        <td className="py-0.5 pr-4">
          <div className="flex items-center h-4 relative">
            <div
              className="h-2 rounded-sm opacity-80"
              style={{
                width: `${barPx}px`,
                marginLeft: `${offsetPx}px`,
                background: color,
              }}
            />
          </div>
        </td>
        <td className="py-0.5 text-right font-mono text-[11px] text-zinc-500 whitespace-nowrap">
          {fmtMs(dur)}
        </td>
      </tr>
      {span.children.map((child) => (
        <SpanRow
          key={child.spanId}
          span={child}
          rootStart={rootStart}
          rootDuration={rootDuration}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

function TraceWaterfall({ traces }: { traces: Span[] }) {
  const [expanded, setExpanded] = useState<string | null>(traces[0]?.traceId ?? null);

  if (traces.length === 0) {
    return <Empty msg="No traces yet — run a search to see the waterfall" />;
  }

  return (
    <div className="space-y-2">
      {traces.map((trace) => {
        const dur = trace.durationMs ?? 0;
        const isOpen = expanded === trace.traceId;
        return (
          <div key={trace.traceId} className="rounded-lg border border-border-subtle overflow-hidden">
            {/* Trace header */}
            <button
              className="w-full flex items-center gap-3 px-4 py-2.5 bg-elevated hover:bg-border-subtle transition-colors text-left"
              onClick={() => setExpanded(isOpen ? null : trace.traceId)}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: trace.status === "error" ? "#ef4444" : "#22c55e" }}
              />
              <span className="font-mono text-xs text-zinc-300 flex-1">{trace.name}</span>
              <span className="font-mono text-xs text-zinc-500">{fmtMs(dur)}</span>
              <span className="font-mono text-[10px] text-zinc-700 hidden md:inline">{trace.traceId}</span>
              <svg
                className={`w-3.5 h-3.5 text-zinc-600 transition-transform shrink-0 ${isOpen ? "rotate-180" : ""}`}
                viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
              >
                <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {/* Span rows */}
            {isOpen && (
              <div className="px-4 py-2 overflow-x-auto">
                <table className="w-full">
                  <colgroup>
                    <col style={{ minWidth: "220px" }} />
                    <col style={{ width: "140px" }} />
                    <col style={{ width: "70px" }} />
                  </colgroup>
                  <tbody>
                    <SpanRow
                      span={trace}
                      rootStart={trace.startTime}
                      rootDuration={dur}
                      depth={0}
                    />
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Metrics Table ────────────────────────────────────────────────

function MetricsTable({ metrics }: { metrics: MetricSnapshot[] }) {
  const histograms = metrics.filter(
    (m) => m.type === "histogram" && m.percentiles && m.percentiles.count > 0
  );
  const counters = metrics.filter((m) => {
    if (m.type !== "counter") return false;
    return m.series.reduce((s, sr) => s + sr.value, 0) > 0;
  });

  const short = (n: string) => n.replace(/^orpheus_/, "");

  if (histograms.length === 0 && counters.length === 0) {
    return <Empty msg="No metrics recorded — run a search first" />;
  }

  return (
    <div className="rounded-lg border border-border-subtle overflow-hidden">
      {histograms.length > 0 && (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border-subtle bg-elevated">
              <th className="text-left px-4 py-2 text-zinc-600 font-medium">Metric</th>
              {["p50", "p90", "p95", "p99", "count"].map((h) => (
                <th key={h} className="text-right px-3 py-2 text-zinc-600 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {histograms.map((m) => {
              const p = m.percentiles!;
              return (
                <tr key={m.name} className="border-b border-border-subtle/50 hover:bg-elevated/40">
                  <td className="px-4 py-2 text-zinc-400">{short(m.name)}</td>
                  {[p.p50, p.p90, p.p95, p.p99].map((v, i) => (
                    <td key={i} className="text-right px-3 py-2 text-accent">
                      {fmtMs(Math.round(v))}
                    </td>
                  ))}
                  <td className="text-right px-3 py-2 text-zinc-500">{p.count}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {counters.length > 0 && (
        <table className="w-full text-xs font-mono border-t border-border-subtle">
          <tbody>
            {counters.map((m) => {
              const total = m.series.reduce((s, sr) => s + sr.value, 0);
              return (
                <tr key={m.name} className="border-b border-border-subtle/50 hover:bg-elevated/40">
                  <td className="px-4 py-2 text-zinc-500">{short(m.name)}</td>
                  <td className="text-right px-4 py-2 text-zinc-300">{total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Cost Breakdown ───────────────────────────────────────────────

function CostBreakdown({
  summary,
  entries,
}: {
  summary: CostSummary;
  entries: CostEntry[];
}) {
  if (entries.length === 0) {
    return <Empty msg="No LLM calls recorded yet" />;
  }

  // Aggregate by component
  const byComp = new Map<string, { tokIn: number; tokOut: number; cost: number }>();
  for (const e of entries) {
    const prev = byComp.get(e.component) ?? { tokIn: 0, tokOut: 0, cost: 0 };
    byComp.set(e.component, {
      tokIn:  prev.tokIn  + e.inputTokens,
      tokOut: prev.tokOut + e.outputTokens,
      cost:   prev.cost   + e.costUsd,
    });
  }

  return (
    <div className="rounded-lg border border-border-subtle overflow-hidden">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-border-subtle bg-elevated">
            <th className="text-left px-4 py-2 text-zinc-600 font-medium">Component</th>
            <th className="text-right px-4 py-2 text-zinc-600 font-medium">Tokens In</th>
            <th className="text-right px-4 py-2 text-zinc-600 font-medium">Tokens Out</th>
            <th className="text-right px-4 py-2 text-zinc-600 font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {Array.from(byComp.entries()).map(([comp, v]) => (
            <tr key={comp} className="border-b border-border-subtle/50 hover:bg-elevated/40">
              <td className="px-4 py-2 text-zinc-400">{comp.replace("conductor.", "")}</td>
              <td className="text-right px-4 py-2 text-zinc-400">{v.tokIn.toLocaleString()}</td>
              <td className="text-right px-4 py-2 text-zinc-400">{v.tokOut.toLocaleString()}</td>
              <td className="text-right px-4 py-2 text-zinc-500">{fmtUsd(v.cost)}</td>
            </tr>
          ))}
          <tr className="bg-elevated/60">
            <td className="px-4 py-2 text-zinc-200 font-semibold">Total</td>
            <td className="text-right px-4 py-2 text-zinc-200">
              {entries.reduce((s, e) => s + e.inputTokens, 0).toLocaleString()}
            </td>
            <td className="text-right px-4 py-2 text-zinc-200">
              {entries.reduce((s, e) => s + e.outputTokens, 0).toLocaleString()}
            </td>
            <td className="text-right px-4 py-2 text-amber-400 font-semibold">
              {fmtUsd(summary.totalUsd)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── Decision Log ─────────────────────────────────────────────────

function DecisionLog({
  entries,
  components,
}: {
  entries: DecisionLogEntry[];
  components: string[];
}) {
  const [filter, setFilter] = useState("all");

  const shown = filter === "all" ? entries : entries.filter((e) => e.component === filter);

  if (entries.length === 0) {
    return <Empty msg="No decisions logged yet — run a search to populate" />;
  }

  return (
    <div>
      {/* Component filter */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        <button
          onClick={() => setFilter("all")}
          className={`text-[10px] font-mono px-2 py-1 rounded border transition-colors ${
            filter === "all"
              ? "border-accent/60 text-accent bg-accent-dim"
              : "border-border-default text-zinc-600 hover:border-border-strong hover:text-zinc-400"
          }`}
        >
          all
        </button>
        {components.map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            className={`text-[10px] font-mono px-2 py-1 rounded border transition-colors ${
              filter === c
                ? "border-accent/60 text-accent bg-accent-dim"
                : "border-border-default text-zinc-600 hover:border-border-strong hover:text-zinc-400"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {shown.slice(0, 20).map((entry, i) => (
          <div key={i} className="rounded-lg border border-border-subtle p-3">
            <div className="flex items-start gap-2 mb-1">
              <span className="tag text-[10px] shrink-0">{entry.component}</span>
              <span className="text-xs text-zinc-300 leading-tight">{entry.decision}</span>
              <span className="ml-auto text-[10px] text-zinc-700 font-mono shrink-0">
                {new Date(entry.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <p className="text-[11px] text-zinc-500 leading-relaxed pl-0">{entry.reasoning}</p>
            {entry.alternatives && entry.alternatives.length > 0 && (
              <div className="mt-2 space-y-0.5">
                {entry.alternatives.map((alt, ai) => (
                  <div key={ai} className="text-[10px] font-mono text-zinc-700">
                    <span className="text-zinc-600">{alt.option}</span>
                    <span className="text-zinc-700 mx-1">·</span>
                    <span>{(alt.score * 100).toFixed(0)}%</span>
                    <span className="text-zinc-700 mx-1">·</span>
                    <span>{alt.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {shown.length > 20 && (
          <p className="text-xs text-zinc-700 text-center font-mono">
            + {shown.length - 20} more entries
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────

export default function ObservatoryPage() {
  const [traces, setTraces]     = useState<Span[]>([]);
  const [metrics, setMetrics]   = useState<MetricSnapshot[]>([]);
  const [decisions, setDecisions] = useState<DecisionLogEntry[]>([]);
  const [costSummary, setCostSummary] = useState<CostSummary>({ totalUsd: 0, byModel: {}, byComponent: {}, entryCount: 0 });
  const [costEntries, setCostEntries] = useState<CostEntry[]>([]);
  const [loading, setLoading]   = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, m, d] = await Promise.all([
        api.getTraces(10),
        api.getMetrics(),
        api.getDecisions({ limit: 50 }),
      ]);
      setTraces(t.traces);
      setMetrics(m.metrics);
      setDecisions(d.entries);
      setCostSummary(d.costSummary);
      setCostEntries(d.costEntries);
      setRefreshedAt(new Date());
    } catch {
      // Keep stale data on error; don't wipe the page
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const components = [...new Set(decisions.map((d) => d.component))];

  return (
    <div className="max-w-screen-xl mx-auto px-6 py-8">
      {/* Page header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-sm font-semibold text-zinc-200 font-mono">Observatory</h1>
          {refreshedAt && (
            <p className="text-xs text-zinc-600 font-mono mt-0.5">
              refreshed {refreshedAt.toLocaleTimeString()}
            </p>
          )}
        </div>
        <button
          onClick={() => { setLoading(true); void load(); }}
          disabled={loading}
          className="btn-outline text-xs h-7 disabled:opacity-40"
        >
          {loading ? (
            <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 8a6 6 0 1 0 1-3.5" strokeLinecap="round" />
              <path d="M2 4v4h4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          Refresh
        </button>
      </div>

      <div className="space-y-10">
        {/* Trace Waterfall */}
        <section>
          <SectionHeader title="Trace Waterfall" />
          <TraceWaterfall traces={traces} />
        </section>

        {/* Metrics */}
        <section>
          <SectionHeader title="Metrics" />
          <MetricsTable metrics={metrics} />
        </section>

        {/* Cost Breakdown + Decision Log side by side on wide screens */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
          <section>
            <SectionHeader title="Cost Breakdown" />
            <CostBreakdown summary={costSummary} entries={costEntries} />
          </section>
          <section>
            <SectionHeader title="Decision Log" />
            <DecisionLog entries={decisions} components={components} />
          </section>
        </div>
      </div>
    </div>
  );
}
