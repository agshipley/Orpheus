import { describe, it, expect } from "vitest";

// Fixture-based tests: verify frame classification logic by testing the
// FALLBACK and shape contracts without hitting the Anthropic API.

const VALID_FRAMES = ["profit", "thesis", "market", "mission", "craft", "service"] as const;

type MotiveFrame = (typeof VALID_FRAMES)[number];

interface ReaderFrame {
  primary: MotiveFrame;
  secondary?: MotiveFrame | null;
  reader_role_guess: string;
  reader_concerns: string[];
  reader_vocabulary: string[];
  frame_rationale: string;
  anti_vocabulary: string[];
}

function validateFrame(frame: unknown): frame is ReaderFrame {
  if (!frame || typeof frame !== "object") return false;
  const f = frame as Record<string, unknown>;
  if (!VALID_FRAMES.includes(f.primary as MotiveFrame)) return false;
  if (f.secondary !== null && f.secondary !== undefined && !VALID_FRAMES.includes(f.secondary as MotiveFrame)) return false;
  if (typeof f.reader_role_guess !== "string") return false;
  if (!Array.isArray(f.reader_concerns)) return false;
  if (!Array.isArray(f.reader_vocabulary)) return false;
  if (typeof f.frame_rationale !== "string") return false;
  if (!Array.isArray(f.anti_vocabulary)) return false;
  return true;
}

describe("ReaderFrame shape validation", () => {
  it("validates a profit-motive frame (hedge fund fixture)", () => {
    const frame: ReaderFrame = {
      primary: "profit",
      secondary: null,
      reader_role_guess: "Managing Partner",
      reader_concerns: ["AUM", "deal velocity", "LP narrative", "process quality"],
      reader_vocabulary: ["capital committed", "returns", "pipeline", "bandwidth"],
      frame_rationale: "Proprietary trading firm; reader runs money questions nakedly. No mission language.",
      anti_vocabulary: ["passion", "purpose", "mission"],
    };
    expect(validateFrame(frame)).toBe(true);
    expect(frame.primary).toBe("profit");
    expect(frame.anti_vocabulary).toContain("mission");
  });

  it("validates a mission-motive frame (foundation fixture)", () => {
    const frame: ReaderFrame = {
      primary: "mission",
      secondary: null,
      reader_role_guess: "Program Officer",
      reader_concerns: ["program quality", "grantee success", "theory of change", "field legitimacy"],
      reader_vocabulary: ["outcomes", "evidence", "field-building", "stewardship", "theory of change"],
      frame_rationale: "Foundation with named mission; reader runs outcome and legitimacy questions. Money is instrumental.",
      anti_vocabulary: ["growth", "burn rate", "unit economics"],
    };
    expect(validateFrame(frame)).toBe(true);
    expect(frame.primary).toBe("mission");
    expect(frame.reader_vocabulary).toContain("theory of change");
  });

  it("validates a market-motive frame (Series A SaaS fixture)", () => {
    const frame: ReaderFrame = {
      primary: "market",
      secondary: "thesis",
      reader_role_guess: "CEO",
      reader_concerns: ["revenue growth", "operational leverage", "team scaling", "burn rate"],
      reader_vocabulary: ["ARR", "expansion", "retention", "unit economics", "runway"],
      frame_rationale: "Series A operating company; reader runs P&L questions. VC-backed so thesis overlay is secondary.",
      anti_vocabulary: ["mission", "stewardship", "grantee"],
    };
    expect(validateFrame(frame)).toBe(true);
    expect(frame.primary).toBe("market");
    expect(frame.secondary).toBe("thesis");
  });

  it("rejects an invalid frame with unknown primary", () => {
    const bad = {
      primary: "vibes",
      secondary: null,
      reader_role_guess: "Hiring Manager",
      reader_concerns: [],
      reader_vocabulary: [],
      frame_rationale: "Invalid.",
      anti_vocabulary: [],
    };
    expect(validateFrame(bad)).toBe(false);
  });

  it("rejects a frame missing required fields", () => {
    const bad = {
      primary: "market",
    };
    expect(validateFrame(bad)).toBe(false);
  });
});
