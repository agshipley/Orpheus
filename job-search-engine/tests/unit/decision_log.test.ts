/**
 * Tests for the Pylon decision log.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DecisionLog } from "../../src/observability/decision_log.js";

describe("DecisionLog", () => {
  let log: DecisionLog;

  beforeEach(() => {
    log = new DecisionLog("detailed");
  });

  it("logs a decision with full context", () => {
    log.logDecision({
      traceId: "arc_test123",
      component: "conductor.ranker",
      decision: "Selected heuristic ranking over LLM ranking",
      reasoning: "Result set too small (< 10) to justify LLM cost",
      inputs: { resultCount: 7 },
      output: { method: "heuristic" },
      alternatives: [
        { option: "heuristic", score: 0.9, reason: "Fast, no cost" },
        { option: "llm", score: 0.7, reason: "Better quality but slow for small sets" },
      ],
    });

    const entries = log.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].component).toBe("conductor.ranker");
    expect(entries[0].timestamp).toBeTruthy();
  });

  it("queries by component", () => {
    log.logDecision({
      traceId: "t1",
      component: "agent.linkedin",
      decision: "d1",
      reasoning: "r1",
      inputs: {},
      output: null,
    });
    log.logDecision({
      traceId: "t2",
      component: "agent.indeed",
      decision: "d2",
      reasoning: "r2",
      inputs: {},
      output: null,
    });
    log.logDecision({
      traceId: "t3",
      component: "agent.linkedin",
      decision: "d3",
      reasoning: "r3",
      inputs: {},
      output: null,
    });

    const linkedin = log.getByComponent("agent.linkedin");
    expect(linkedin).toHaveLength(2);
  });

  it("queries by trace ID", () => {
    log.logDecision({
      traceId: "arc_abc",
      component: "c1",
      decision: "d1",
      reasoning: "r1",
      inputs: {},
      output: null,
    });
    log.logDecision({
      traceId: "arc_abc",
      component: "c2",
      decision: "d2",
      reasoning: "r2",
      inputs: {},
      output: null,
    });
    log.logDecision({
      traceId: "arc_xyz",
      component: "c3",
      decision: "d3",
      reasoning: "r3",
      inputs: {},
      output: null,
    });

    const trace = log.getByTrace("arc_abc");
    expect(trace).toHaveLength(2);
  });

  it("tracks LLM costs per trace", () => {
    log.logCost({
      traceId: "arc_abc",
      model: "claude-sonnet-4-20250514",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.0045,
      component: "conductor",
      timestamp: new Date().toISOString(),
    });
    log.logCost({
      traceId: "arc_abc",
      model: "claude-sonnet-4-20250514",
      inputTokens: 2000,
      outputTokens: 800,
      costUsd: 0.0084,
      component: "resume_tailor",
      timestamp: new Date().toISOString(),
    });

    const cost = log.getTraceCost("arc_abc");
    expect(cost.totalUsd).toBeCloseTo(0.0129);
    expect(cost.totalInputTokens).toBe(3000);
    expect(cost.totalOutputTokens).toBe(1300);
    expect(cost.breakdown).toHaveLength(2);
  });

  it("provides aggregate cost summary", () => {
    log.logCost({
      traceId: "t1",
      model: "claude-sonnet-4-20250514",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.005,
      component: "search",
      timestamp: new Date().toISOString(),
    });
    log.logCost({
      traceId: "t2",
      model: "claude-sonnet-4-20250514",
      inputTokens: 3000,
      outputTokens: 1000,
      costUsd: 0.012,
      component: "content",
      timestamp: new Date().toISOString(),
    });

    const summary = log.getCostSummary();
    expect(summary.totalUsd).toBeCloseTo(0.017);
    expect(summary.byComponent["search"]).toBeCloseTo(0.005);
    expect(summary.byComponent["content"]).toBeCloseTo(0.012);
  });

  it("formats decision entries as readable strings", () => {
    const formatted = DecisionLog.format({
      traceId: "arc_test",
      timestamp: "2025-01-15T10:30:00Z",
      component: "conductor.ranker",
      decision: "Used LLM ranking",
      reasoning: "Large result set benefits from semantic ranking",
      inputs: {},
      output: null,
      alternatives: [
        { option: "heuristic", score: 0.6, reason: "Fast but imprecise" },
        { option: "llm", score: 0.9, reason: "Slower but better quality" },
      ],
    });

    expect(formatted).toContain("Decision: Used LLM ranking");
    expect(formatted).toContain("Component: conductor.ranker");
    expect(formatted).toContain("heuristic");
    expect(formatted).toContain("0.600");
  });

  describe("Log levels", () => {
    it("minimal level strips inputs and alternatives", () => {
      const minLog = new DecisionLog("minimal");
      minLog.logDecision({
        traceId: "t1",
        component: "c1",
        decision: "d1",
        reasoning: "r1",
        inputs: { sensitiveData: "should be stripped" },
        output: null,
        alternatives: [{ option: "a", score: 1, reason: "r" }],
      });

      const entries = minLog.getAll();
      expect(Object.keys(entries[0].inputs)).toHaveLength(0);
      expect(entries[0].alternatives).toBeUndefined();
    });
  });
});
