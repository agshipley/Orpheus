/**
 * Pylon Decision Log — Structured logging for AI decision explainability.
 *
 * Every time the system makes a non-trivial decision (ranking, filtering,
 * content strategy selection, etc.), it's captured here with full context
 * so you can understand *why* the system did what it did.
 */

import type { DecisionLogEntry, CostEntry } from "../types.js";

type LogLevel = "minimal" | "standard" | "detailed";

export class DecisionLog {
  private entries: DecisionLogEntry[] = [];
  private costs: CostEntry[] = [];
  private level: LogLevel;

  constructor(level: LogLevel = "standard") {
    this.level = level;
  }

  /**
   * Log a decision with full context.
   */
  logDecision(entry: Omit<DecisionLogEntry, "timestamp">): void {
    const full: DecisionLogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    // Filter detail based on log level
    if (this.level === "minimal") {
      full.inputs = {};
      full.alternatives = undefined;
    } else if (this.level === "standard") {
      // Keep alternatives but truncate large inputs
      full.inputs = this.truncateInputs(full.inputs);
    }

    this.entries.push(full);
  }

  /**
   * Log an LLM cost entry.
   */
  logCost(entry: CostEntry): void {
    this.costs.push(entry);
  }

  /**
   * Query decisions by component.
   */
  getByComponent(component: string): DecisionLogEntry[] {
    return this.entries.filter((e) => e.component === component);
  }

  /**
   * Query decisions by trace.
   */
  getByTrace(traceId: string): DecisionLogEntry[] {
    return this.entries.filter((e) => e.traceId === traceId);
  }

  /**
   * Get total cost for a trace.
   */
  getTraceCost(traceId: string): {
    totalUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    breakdown: CostEntry[];
  } {
    const traceCosts = this.costs.filter((c) => c.traceId === traceId);
    return {
      totalUsd: traceCosts.reduce((sum, c) => sum + c.costUsd, 0),
      totalInputTokens: traceCosts.reduce((sum, c) => sum + c.inputTokens, 0),
      totalOutputTokens: traceCosts.reduce((sum, c) => sum + c.outputTokens, 0),
      breakdown: traceCosts,
    };
  }

  /**
   * Get aggregate cost stats.
   */
  getCostSummary(): {
    totalUsd: number;
    byModel: Record<string, number>;
    byComponent: Record<string, number>;
    entryCount: number;
  } {
    const byModel: Record<string, number> = {};
    const byComponent: Record<string, number> = {};
    let totalUsd = 0;

    for (const cost of this.costs) {
      totalUsd += cost.costUsd;
      byModel[cost.model] = (byModel[cost.model] ?? 0) + cost.costUsd;
      byComponent[cost.component] =
        (byComponent[cost.component] ?? 0) + cost.costUsd;
    }

    return { totalUsd, byModel, byComponent, entryCount: this.costs.length };
  }

  /**
   * Get all entries (most recent first).
   */
  getAll(limit?: number): DecisionLogEntry[] {
    const sorted = [...this.entries].reverse();
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /**
   * Format a decision log entry as a readable string.
   */
  static format(entry: DecisionLogEntry): string {
    const lines = [
      `┌─ Decision: ${entry.decision}`,
      `│  Component: ${entry.component}`,
      `│  Trace: ${entry.traceId}`,
      `│  Time: ${entry.timestamp}`,
      `│  Reasoning: ${entry.reasoning}`,
    ];

    if (entry.alternatives && entry.alternatives.length > 0) {
      lines.push(`│  Alternatives considered:`);
      for (const alt of entry.alternatives) {
        lines.push(
          `│    • ${alt.option} (score: ${alt.score.toFixed(3)}) — ${alt.reason}`
        );
      }
    }

    lines.push(`└${"─".repeat(60)}`);
    return lines.join("\n");
  }

  /**
   * Export the full log as JSON.
   */
  toJSON(): { decisions: DecisionLogEntry[]; costs: CostEntry[] } {
    return {
      decisions: this.entries,
      costs: this.costs,
    };
  }

  /**
   * Clear all entries (useful for testing).
   */
  clear(): void {
    this.entries = [];
    this.costs = [];
  }

  private truncateInputs(
    inputs: Record<string, unknown>
  ): Record<string, unknown> {
    const truncated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value === "string" && value.length > 500) {
        truncated[key] = value.slice(0, 500) + "... (truncated)";
      } else {
        truncated[key] = value;
      }
    }
    return truncated;
  }
}

// ─── Singleton ────────────────────────────────────────────────────

let globalDecisionLog: DecisionLog | null = null;

export function getDecisionLog(level?: LogLevel): DecisionLog {
  if (!globalDecisionLog) {
    globalDecisionLog = new DecisionLog(level);
  }
  return globalDecisionLog;
}
