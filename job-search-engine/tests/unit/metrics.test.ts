/**
 * Tests for the Pylon metrics collector.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MetricsCollector } from "../../src/observability/metrics.js";

describe("MetricsCollector", () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector();
  });

  describe("Counter", () => {
    it("increments a counter", () => {
      metrics.increment("requests_total");
      metrics.increment("requests_total");
      metrics.increment("requests_total");

      const snap = metrics.snapshot();
      const counter = snap.find((m) => m.name === "requests_total");
      expect(counter).toBeDefined();
      expect(counter!.series[0].value).toBe(3);
    });

    it("increments with labels", () => {
      metrics.increment("requests_total", { method: "GET" });
      metrics.increment("requests_total", { method: "POST" });
      metrics.increment("requests_total", { method: "GET" });

      const snap = metrics.snapshot();
      const counter = snap.find((m) => m.name === "requests_total");
      expect(counter!.series).toHaveLength(2);

      const getSeries = counter!.series.find(
        (s) => s.labels["method"] === "GET"
      );
      expect(getSeries!.value).toBe(2);
    });

    it("increments by custom value", () => {
      metrics.increment("tokens_total", {}, 1500);

      const snap = metrics.snapshot();
      const counter = snap.find((m) => m.name === "tokens_total");
      expect(counter!.series[0].value).toBe(1500);
    });
  });

  describe("Gauge", () => {
    it("sets a gauge value", () => {
      metrics.gauge("active_agents", 5);
      metrics.gauge("active_agents", 3);

      const snap = metrics.snapshot();
      const gauge = snap.find((m) => m.name === "active_agents");
      expect(gauge!.series[0].value).toBe(3); // Last write wins
    });
  });

  describe("Histogram", () => {
    it("observes values and computes percentiles", () => {
      const values = [10, 20, 30, 40, 50, 100, 200, 500, 1000, 2000];
      for (const v of values) {
        metrics.observe("latency_ms", v);
      }

      const snap = metrics.snapshot();
      const hist = snap.find((m) => m.name === "latency_ms");
      expect(hist!.percentiles).toBeDefined();
      expect(hist!.percentiles!.count).toBe(10);
      expect(hist!.percentiles!.p50).toBeDefined();
      expect(hist!.percentiles!.p99).toBeDefined();
    });
  });

  describe("Export", () => {
    it("exports Prometheus format", () => {
      metrics.register("test_counter", "counter", "A test counter");
      metrics.increment("test_counter", { source: "linkedin" });

      const prom = metrics.toPrometheus();
      expect(prom).toContain("# HELP test_counter A test counter");
      expect(prom).toContain("# TYPE test_counter counter");
      expect(prom).toContain('test_counter{source="linkedin"} 1');
    });

    it("exports console format", () => {
      metrics.register("test_gauge", "gauge", "A test gauge");
      metrics.gauge("test_gauge", 42);

      const console = metrics.toConsole();
      expect(console).toContain("test_gauge");
      expect(console).toContain("42");
    });
  });

  describe("Reset", () => {
    it("clears all metrics", () => {
      metrics.increment("counter");
      metrics.gauge("gauge", 42);
      metrics.reset();

      const snap = metrics.snapshot();
      expect(snap).toHaveLength(0);
    });
  });
});
