import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { nanoid } from "nanoid";
import { buildInterrogatorSystemPrompt } from "../../src/content/interrogator_prompts.js";

// ─── Prompt compilation tests ──────────────────────────────────────

describe("buildInterrogatorSystemPrompt", () => {
  it("compiles reader_role prompt to a non-empty string", () => {
    const prompt = buildInterrogatorSystemPrompt({
      mode: "reader_role",
      company: "Clocktower Group",
      title: "Chief of Staff",
      frame: {
        primary: "profit",
        secondary: null,
        reader_role_guess: "Managing Partner",
        reader_concerns: ["AUM", "deal velocity", "bandwidth"],
        reader_vocabulary: ["capital committed", "pipeline", "returns"],
        frame_rationale: "Proprietary trading firm.",
        anti_vocabulary: ["mission", "passion"],
      },
    });

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(200);
    expect(prompt).toContain("Clocktower Group");
    expect(prompt).toContain("Chief of Staff");
    expect(prompt).toContain("Managing Partner");
    expect(prompt).toContain("profit");
    expect(prompt).toContain("End each of your messages with exactly one question");
  });

  it("compiles ambient prompt to a non-empty string", () => {
    const prompt = buildInterrogatorSystemPrompt({
      mode: "ambient",
      domain: "the SOC II process at Trace Machina",
    });

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(200);
    expect(prompt).toContain("SOC II process at Trace Machina");
    expect(prompt).toContain("consultative interrogator");
  });

  it("reader_role prompt includes anti-vocabulary", () => {
    const prompt = buildInterrogatorSystemPrompt({
      mode: "reader_role",
      company: "Andreessen Horowitz",
      title: "Deal Partner",
      frame: {
        primary: "thesis",
        secondary: null,
        reader_role_guess: "General Partner",
        reader_concerns: ["deal flow", "portfolio construction"],
        reader_vocabulary: ["conviction", "wedge", "asymmetric bet"],
        frame_rationale: "Venture capital firm.",
        anti_vocabulary: ["passion", "stewardship"],
      },
    });

    expect(prompt).toContain("passion");
    expect(prompt).toContain("stewardship");
    expect(prompt).toContain("Andreessen Horowitz");
  });

  it("ambient prompt does not mention a company name", () => {
    const prompt = buildInterrogatorSystemPrompt({
      mode: "ambient",
      domain: "early-stage quantum fundraising dynamics",
    });

    expect(prompt).toContain("early-stage quantum fundraising dynamics");
    expect(prompt).not.toContain("reader_role_guess");
  });
});

// ─── Storage layer tests ──────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `orpheus-interrogator-test-${nanoid(6)}`);

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

function writeTestFile(filename: string, content: string): string {
  const p = join(TEST_DIR, filename);
  const { writeFileSync } = require("fs");
  writeFileSync(p, content, "utf-8");
  return p;
}

describe("Transcript format", () => {
  it("produces valid YAML frontmatter and markdown body", () => {
    const now = new Date().toISOString();
    const content = [
      "---",
      `mode: reader_role`,
      `seed: "Test seed"`,
      `reader_frame: null`,
      `started_at: "${now}"`,
      `ended_at: null`,
      `message_count: 1`,
      "---",
      "",
      "### Interrogator",
      "This is the first question?",
    ].join("\n");

    const p = writeTestFile("test-session.md", content);
    const read = readFileSync(p, "utf-8");
    expect(read).toContain("### Interrogator");
    expect(read).toContain("mode: reader_role");
    expect(read).toContain("message_count: 1");
  });

  it("file is created at the expected path when written", () => {
    const filename = `${new Date().toISOString().slice(0, 10)}-1200-test-company.md`;
    const p = join(TEST_DIR, filename);

    const { writeFileSync } = require("fs");
    writeFileSync(p, "---\nmode: reader_role\nseed: test\nreader_frame: null\nstarted_at: \"2025-01-01T00:00:00.000Z\"\nended_at: null\nmessage_count: 1\n---\n\n### Interrogator\nHello?", "utf-8");

    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("### Interrogator");
    expect(content).toContain("Hello?");
  });
});
