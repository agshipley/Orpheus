/**
 * Pylon Metrics — Lightweight metrics collection.
 *
 * Supports counters, gauges, and histograms without requiring
 * a full Prometheus client. Exportable to console, Prometheus
 * exposition format, or OTLP.
 */

import type { Metric } from "../types.js";

interface HistogramBucket {
  le: number;
  count: number;
}

interface MetricEntry {
  name: string;
  type: Metric["type"];
  help: string;
  labels: Map<string, number>;
  buckets?: HistogramBucket[];
  values?: number[];  // for histogram percentile calculations
}

export class MetricsCollector {
  private metrics = new Map<string, MetricEntry>();

  /**
   * Register a new metric. Idempotent.
   */
  register(name: string, type: Metric["type"], help: string): void {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, {
        name,
        type,
        help,
        labels: new Map(),
        buckets: type === "histogram"
          ? [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000].map(
              (le) => ({ le, count: 0 })
            )
          : undefined,
        values: type === "histogram" ? [] : undefined,
      });
    }
  }

  /**
   * Increment a counter.
   */
  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = this.labelKey(labels);
    const entry = this.getOrCreate(name, "counter");
    entry.labels.set(key, (entry.labels.get(key) ?? 0) + value);
  }

  /**
   * Set a gauge value.
   */
  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.labelKey(labels);
    const entry = this.getOrCreate(name, "gauge");
    entry.labels.set(key, value);
  }

  /**
   * Observe a histogram value.
   */
  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.labelKey(labels);
    const entry = this.getOrCreate(name, "histogram");
    entry.labels.set(key, (entry.labels.get(key) ?? 0) + 1);

    if (entry.buckets) {
      for (const bucket of entry.buckets) {
        if (value <= bucket.le) {
          bucket.count++;
        }
      }
    }
    entry.values?.push(value);
  }

  /**
   * Get a snapshot of all metrics.
   */
  snapshot(): MetricSnapshot[] {
    const results: MetricSnapshot[] = [];

    for (const [, entry] of this.metrics) {
      const snapshot: MetricSnapshot = {
        name: entry.name,
        type: entry.type,
        help: entry.help,
        series: [],
      };

      for (const [labelKey, value] of entry.labels) {
        snapshot.series.push({
          labels: this.parseLabels(labelKey),
          value,
        });
      }

      if (entry.type === "histogram" && entry.values && entry.values.length > 0) {
        const sorted = [...entry.values].sort((a, b) => a - b);
        snapshot.percentiles = {
          p50: this.percentile(sorted, 0.5),
          p90: this.percentile(sorted, 0.9),
          p95: this.percentile(sorted, 0.95),
          p99: this.percentile(sorted, 0.99),
          count: sorted.length,
          sum: sorted.reduce((a, b) => a + b, 0),
        };
      }

      results.push(snapshot);
    }

    return results;
  }

  /**
   * Export in Prometheus exposition format.
   */
  toPrometheus(): string {
    const lines: string[] = [];

    for (const metric of this.snapshot()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      for (const series of metric.series) {
        const labelStr = Object.entries(series.labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(",");
        const suffix = labelStr ? `{${labelStr}}` : "";
        lines.push(`${metric.name}${suffix} ${series.value}`);
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Pretty-print to console.
   */
  toConsole(): string {
    const snap = this.snapshot();
    const lines: string[] = ["", "═══ Orpheus Metrics ═══", ""];

    for (const metric of snap) {
      lines.push(`  ${metric.name} (${metric.type}): ${metric.help}`);

      for (const series of metric.series) {
        const labels = Object.entries(series.labels)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        lines.push(`    ${labels || "(default)"}: ${series.value}`);
      }

      if (metric.percentiles) {
        lines.push(
          `    p50=${metric.percentiles.p50.toFixed(1)}ms ` +
            `p90=${metric.percentiles.p90.toFixed(1)}ms ` +
            `p95=${metric.percentiles.p95.toFixed(1)}ms ` +
            `p99=${metric.percentiles.p99.toFixed(1)}ms ` +
            `count=${metric.percentiles.count} ` +
            `sum=${metric.percentiles.sum.toFixed(1)}ms`
        );
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Reset all metrics (useful for testing).
   */
  reset(): void {
    this.metrics.clear();
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private getOrCreate(name: string, type: Metric["type"]): MetricEntry {
    if (!this.metrics.has(name)) {
      this.register(name, type, `Auto-registered ${type}: ${name}`);
    }
    return this.metrics.get(name)!;
  }

  private labelKey(labels: Record<string, string>): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join("|");
  }

  private parseLabels(key: string): Record<string, string> {
    if (!key) return {};
    return Object.fromEntries(
      key.split("|").map((pair) => {
        const idx = pair.indexOf(":");
        return [pair.slice(0, idx), pair.slice(idx + 1)];
      })
    );
  }

  private percentile(sorted: number[], p: number): number {
    const idx = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, idx)];
  }
}

export interface MetricSnapshot {
  name: string;
  type: Metric["type"];
  help: string;
  series: Array<{
    labels: Record<string, string>;
    value: number;
  }>;
  percentiles?: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    count: number;
    sum: number;
  };
}

// ─── Singleton ────────────────────────────────────────────────────

let globalMetrics: MetricsCollector | null = null;

export function getMetrics(): MetricsCollector {
  if (!globalMetrics) {
    globalMetrics = new MetricsCollector();
    registerDefaultMetrics(globalMetrics);
  }
  return globalMetrics;
}

function registerDefaultMetrics(m: MetricsCollector): void {
  m.register("orpheus_searches_total", "counter", "Total search operations");
  m.register("orpheus_agent_calls_total", "counter", "Total agent invocations");
  m.register("orpheus_agent_errors_total", "counter", "Total agent errors");
  m.register("orpheus_jobs_found_total", "counter", "Total jobs discovered");
  m.register("orpheus_jobs_deduplicated_total", "counter", "Jobs removed by dedup");
  m.register("orpheus_search_latency_ms", "histogram", "Search latency in ms");
  m.register("orpheus_agent_latency_ms", "histogram", "Per-agent latency in ms");
  m.register("orpheus_llm_tokens_total", "counter", "Total LLM tokens used");
  m.register("orpheus_llm_cost_usd", "counter", "Cumulative LLM cost in USD");
  m.register("orpheus_content_generations_total", "counter", "Content generation count");
  m.register("orpheus_tool_calls_total", "counter", "MCP tool calls");
  m.register("orpheus_cache_hits_total", "counter", "Cache hit count");
  m.register("orpheus_cache_misses_total", "counter", "Cache miss count");
}
