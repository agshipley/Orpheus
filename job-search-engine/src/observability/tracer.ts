/**
 * Pylon Tracer — Distributed tracing for the Orpheus pipeline.
 *
 * Provides OpenTelemetry-inspired tracing without the dependency weight.
 * Every operation (search, agent dispatch, tool call, LLM inference, content
 * generation) is captured as a Span in a trace tree.
 *
 * Design decisions:
 * - In-process tracing (no collector needed for dev)
 * - Structured span events for decision logging
 * - Automatic duration calculation on span end
 * - Export hooks for Prometheus/OTLP when needed
 */

import { nanoid } from "nanoid";
import { EventEmitter } from "eventemitter3";
import type { Span, SpanEvent, Metric, CostEntry } from "../types.js";

// ─── Trace Store ──────────────────────────────────────────────────

interface TracerEvents {
  "span:start": (span: Span) => void;
  "span:end": (span: Span) => void;
  "metric": (metric: Metric) => void;
  "cost": (cost: CostEntry) => void;
}

class TraceStore {
  private traces = new Map<string, Span>();
  private spans = new Map<string, Span>();

  addRootSpan(span: Span): void {
    this.traces.set(span.traceId, span);
    this.spans.set(span.spanId, span);
  }

  addChildSpan(span: Span): void {
    this.spans.set(span.spanId, span);
    if (span.parentSpanId) {
      const parent = this.spans.get(span.parentSpanId);
      if (parent) {
        parent.children.push(span);
      }
    }
  }

  getTrace(traceId: string): Span | undefined {
    return this.traces.get(traceId);
  }

  getSpan(spanId: string): Span | undefined {
    return this.spans.get(spanId);
  }

  getAllTraces(): Span[] {
    return Array.from(this.traces.values());
  }

  getRecentTraces(limit: number): Span[] {
    return Array.from(this.traces.values())
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit);
  }
}

// ─── Span Builder ─────────────────────────────────────────────────

export class SpanBuilder {
  private span: Span;
  private emitter: EventEmitter<TracerEvents>;
  private store: TraceStore;

  constructor(
    name: string,
    traceId: string,
    emitter: EventEmitter<TracerEvents>,
    store: TraceStore,
    parentSpanId?: string
  ) {
    this.emitter = emitter;
    this.store = store;
    this.span = {
      traceId,
      spanId: nanoid(12),
      parentSpanId,
      name,
      startTime: performance.now(),
      status: "ok",
      attributes: {},
      events: [],
      children: [],
    };

    if (parentSpanId) {
      store.addChildSpan(this.span);
    } else {
      store.addRootSpan(this.span);
    }

    emitter.emit("span:start", this.span);
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.span.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Record<string, string | number | boolean>): this {
    Object.assign(this.span.attributes, attrs);
    return this;
  }

  addEvent(name: string, attrs?: Record<string, string | number | boolean>): this {
    this.span.events.push({
      name,
      timestamp: performance.now(),
      attributes: attrs ?? {},
    });
    return this;
  }

  setError(message: string): this {
    this.span.status = "error";
    this.span.attributes["error.message"] = message;
    return this;
  }

  /**
   * Create a child span. The child's lifetime is independent —
   * you must call .end() on it separately.
   */
  startChild(name: string): SpanBuilder {
    return new SpanBuilder(
      name,
      this.span.traceId,
      this.emitter,
      this.store,
      this.span.spanId
    );
  }

  end(): Span {
    this.span.endTime = performance.now();
    this.span.durationMs = Math.round(this.span.endTime - this.span.startTime);
    this.emitter.emit("span:end", this.span);
    return this.span;
  }

  get spanId(): string {
    return this.span.spanId;
  }

  get traceId(): string {
    return this.span.traceId;
  }
}

// ─── Tracer ───────────────────────────────────────────────────────

export class Tracer {
  private emitter = new EventEmitter<TracerEvents>();
  private store = new TraceStore();
  private samplingRate: number;

  constructor(samplingRate: number = 1.0) {
    this.samplingRate = samplingRate;
  }

  /**
   * Start a new trace with a root span.
   */
  startTrace(name: string): SpanBuilder {
    if (Math.random() > this.samplingRate) {
      // Return a no-op span for unsampled traces
      return this.createNoOpSpan(name);
    }
    const traceId = `orp_${nanoid(16)}`;
    return new SpanBuilder(name, traceId, this.emitter, this.store);
  }

  /**
   * Start a child span within an existing trace.
   */
  startSpan(name: string, traceId: string, parentSpanId: string): SpanBuilder {
    return new SpanBuilder(
      name,
      traceId,
      this.emitter,
      this.store,
      parentSpanId
    );
  }

  /**
   * Record a metric value.
   */
  recordMetric(
    name: string,
    value: number,
    type: Metric["type"] = "gauge",
    labels: Record<string, string> = {}
  ): void {
    const metric: Metric = {
      name,
      type,
      value,
      labels,
      timestamp: Date.now(),
    };
    this.emitter.emit("metric", metric);
  }

  /**
   * Record an LLM cost entry.
   */
  recordCost(entry: CostEntry): void {
    this.emitter.emit("cost", entry);
  }

  /**
   * Subscribe to tracer events for export/logging.
   */
  on<E extends keyof TracerEvents>(event: E, handler: TracerEvents[E]): void {
    this.emitter.on(event, handler);
  }

  /**
   * Get all recorded traces.
   */
  getTraces(limit?: number): Span[] {
    return limit ? this.store.getRecentTraces(limit) : this.store.getAllTraces();
  }

  /**
   * Get a specific trace by ID.
   */
  getTrace(traceId: string): Span | undefined {
    return this.store.getTrace(traceId);
  }

  /**
   * Wrap an async function with automatic span tracking.
   */
  async traced<T>(
    name: string,
    parentSpan: SpanBuilder | undefined,
    fn: (span: SpanBuilder) => Promise<T>
  ): Promise<T> {
    const span = parentSpan
      ? parentSpan.startChild(name)
      : this.startTrace(name);

    try {
      const result = await fn(span);
      span.end();
      return result;
    } catch (error) {
      span.setError(
        error instanceof Error ? error.message : String(error)
      );
      span.end();
      throw error;
    }
  }

  private createNoOpSpan(name: string): SpanBuilder {
    // Even for no-op, we still track minimally for cost accounting
    const traceId = `orp_noop_${nanoid(8)}`;
    return new SpanBuilder(name, traceId, this.emitter, this.store);
  }
}

// ─── Singleton ────────────────────────────────────────────────────

let globalTracer: Tracer | null = null;

export function getTracer(samplingRate?: number): Tracer {
  if (!globalTracer) {
    globalTracer = new Tracer(samplingRate);
  }
  return globalTracer;
}

export function resetTracer(): void {
  globalTracer = null;
}
