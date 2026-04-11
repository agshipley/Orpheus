/**
 * Tests for the Pylon tracing system.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Tracer, resetTracer } from "../../src/observability/tracer.js";

describe("Tracer", () => {
  let tracer: Tracer;

  beforeEach(() => {
    resetTracer();
    tracer = new Tracer(1.0);
  });

  it("creates a trace with a root span", () => {
    const span = tracer.startTrace("test.operation");
    expect(span.traceId).toMatch(/^arc_/);
    expect(span.spanId).toBeTruthy();

    const completed = span.end();
    expect(completed.name).toBe("test.operation");
    expect(completed.status).toBe("ok");
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("supports nested child spans", () => {
    const root = tracer.startTrace("parent");
    const child = root.startChild("child");
    const grandchild = child.startChild("grandchild");

    grandchild.end();
    child.end();
    const rootSpan = root.end();

    expect(rootSpan.children).toHaveLength(1);
    expect(rootSpan.children[0].name).toBe("child");
    expect(rootSpan.children[0].children).toHaveLength(1);
    expect(rootSpan.children[0].children[0].name).toBe("grandchild");
  });

  it("sets attributes on spans", () => {
    const span = tracer.startTrace("test");
    span.setAttribute("key", "value");
    span.setAttributes({ num: 42, flag: true });

    const completed = span.end();
    expect(completed.attributes).toEqual({
      key: "value",
      num: 42,
      flag: true,
    });
  });

  it("records span events", () => {
    const span = tracer.startTrace("test");
    span.addEvent("step.start", { step: "1" });
    span.addEvent("step.end", { step: "1", duration: 100 });

    const completed = span.end();
    expect(completed.events).toHaveLength(2);
    expect(completed.events[0].name).toBe("step.start");
    expect(completed.events[1].name).toBe("step.end");
  });

  it("captures errors on spans", () => {
    const span = tracer.startTrace("test");
    span.setError("Something went wrong");

    const completed = span.end();
    expect(completed.status).toBe("error");
    expect(completed.attributes["error.message"]).toBe("Something went wrong");
  });

  it("wraps async functions with traced()", async () => {
    const result = await tracer.traced(
      "async.operation",
      undefined,
      async (span) => {
        span.setAttribute("step", "1");
        await new Promise((r) => setTimeout(r, 10));
        return 42;
      }
    );

    expect(result).toBe(42);

    const traces = tracer.getTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0].name).toBe("async.operation");
    expect(traces[0].durationMs).toBeGreaterThanOrEqual(10);
  });

  it("captures errors in traced() and rethrows", async () => {
    await expect(
      tracer.traced("failing.operation", undefined, async () => {
        throw new Error("Test error");
      })
    ).rejects.toThrow("Test error");

    const traces = tracer.getTraces();
    expect(traces[0].status).toBe("error");
  });

  it("emits events on span lifecycle", () => {
    const startEvents: string[] = [];
    const endEvents: string[] = [];

    tracer.on("span:start", (span) => startEvents.push(span.name));
    tracer.on("span:end", (span) => endEvents.push(span.name));

    const span = tracer.startTrace("test");
    span.end();

    expect(startEvents).toEqual(["test"]);
    expect(endEvents).toEqual(["test"]);
  });

  it("retrieves traces by ID", () => {
    const span = tracer.startTrace("test");
    const traceId = span.traceId;
    span.end();

    const trace = tracer.getTrace(traceId);
    expect(trace).toBeDefined();
    expect(trace?.name).toBe("test");
  });

  it("returns recent traces in order", () => {
    tracer.startTrace("first").end();
    tracer.startTrace("second").end();
    tracer.startTrace("third").end();

    const recent = tracer.getTraces(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].name).toBe("third");
    expect(recent[1].name).toBe("second");
  });
});
