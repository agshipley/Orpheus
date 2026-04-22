import type { Request, Response } from "express";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadConfig } from "../config.js";
import { inferReaderFrame } from "../../content/reader_frame.js";
import type { ReaderFrame } from "../../content/reader_frame.js";
import { buildInterrogatorSystemPrompt } from "../../content/interrogator_prompts.js";
import { extractJobMetadata } from "../../content/extract_job_metadata.js";

// ─── Directory resolution ─────────────────────────────────────────

function getInterrogatorDir(): string {
  const config = loadConfig();
  const dataDir = dirname(config.storage.dbPath);
  return join(dataDir, "interrogator");
}

export function ensureInterrogatorDir(): void {
  mkdirSync(getInterrogatorDir(), { recursive: true });
}

// ─── Index ────────────────────────────────────────────────────────

interface IndexEntry {
  session_id: string;
  filename: string;
  mode: "reader_role" | "ambient";
  seed_preview: string;
  started_at: string;
  ended_at: string | null;
  message_count: number;
}

function indexPath(): string {
  return join(getInterrogatorDir(), "_index.json");
}

function loadIndex(): IndexEntry[] {
  const p = indexPath();
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as IndexEntry[];
  } catch {
    return [];
  }
}

function saveIndex(index: IndexEntry[]): void {
  writeFileSync(indexPath(), JSON.stringify(index, null, 2), "utf-8");
}

function upsertIndex(entry: IndexEntry): void {
  const index = loadIndex();
  const i = index.findIndex((e) => e.session_id === entry.session_id);
  if (i >= 0) {
    index[i] = entry;
  } else {
    index.unshift(entry);
  }
  saveIndex(index);
}

// ─── In-memory session registry (session_id → filename) ──────────

interface SessionRecord {
  filename: string;
  mode: "reader_role" | "ambient";
  seed: string;
  reader_frame?: ReaderFrame;
  started_at: string;
  system_prompt: string;
}

const sessionRegistry = new Map<string, SessionRecord>();

// ─── Transcript file I/O ──────────────────────────────────────────

interface Frontmatter {
  mode: "reader_role" | "ambient";
  seed: string;
  reader_frame: ReaderFrame | null;
  started_at: string;
  ended_at: string | null;
  message_count: number;
}

interface TranscriptMessage {
  role: "interrogator" | "andrew";
  text: string;
}

function parseTranscript(content: string): { frontmatter: Frontmatter; messages: TranscriptMessage[] } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    return {
      frontmatter: {
        mode: "ambient",
        seed: "",
        reader_frame: null,
        started_at: new Date().toISOString(),
        ended_at: null,
        message_count: 0,
      },
      messages: [],
    };
  }

  const frontmatter = parseYaml(fmMatch[1]) as Frontmatter;
  const body = fmMatch[2];

  const messages: TranscriptMessage[] = [];
  const sections = body.split(/\n### /).filter(Boolean);
  for (const section of sections) {
    const newline = section.indexOf("\n");
    if (newline === -1) continue;
    const header = section.slice(0, newline).replace(/^### /, "").trim();
    const text = section.slice(newline + 1).trim();
    if (!text) continue;
    if (header === "Interrogator") {
      messages.push({ role: "interrogator", text });
    } else if (header === "Andrew") {
      messages.push({ role: "andrew", text });
    }
  }

  return { frontmatter, messages };
}

function serializeTranscript(frontmatter: Frontmatter, messages: TranscriptMessage[]): string {
  const fm = stringifyYaml(frontmatter).trim();
  const body = messages
    .map((m) => `### ${m.role === "interrogator" ? "Interrogator" : "Andrew"}\n${m.text}`)
    .join("\n\n");
  return `---\n${fm}\n---\n\n${body}`;
}

function readSession(filename: string): { frontmatter: Frontmatter; messages: TranscriptMessage[] } | null {
  const p = join(getInterrogatorDir(), filename);
  if (!existsSync(p)) return null;
  return parseTranscript(readFileSync(p, "utf-8"));
}

function writeSession(filename: string, frontmatter: Frontmatter, messages: TranscriptMessage[]): void {
  const p = join(getInterrogatorDir(), filename);
  writeFileSync(p, serializeTranscript(frontmatter, messages), "utf-8");
}

// ─── Filename generation ──────────────────────────────────────────

function makeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function makeFilename(_mode: "reader_role" | "ambient", seed: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const hhmm = now.toISOString().slice(11, 16).replace(":", "");
  const slug = makeSlug(seed);
  return `${date}-${hhmm}-${slug}.md`;
}

// ─── Rate limiting ────────────────────────────────────────────────

interface RateEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateEntry>();
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ─── Claude call with prompt caching ─────────────────────────────

const MAX_MESSAGES_PER_SESSION = 40;

async function callInterrogator(
  systemPrompt: string,
  messages: TranscriptMessage[]
): Promise<{ text: string; cacheHit: boolean }> {
  const client = new Anthropic();
  const config = loadConfig();
  const model = config.content.model ?? "claude-sonnet-4-6";

  // Build Anthropic message array
  // Roles: interrogator → assistant, andrew → user
  const anthropicMessages: Array<{
    role: "user" | "assistant";
    content: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  }> = messages.map((m) => ({
    role: m.role === "interrogator" ? "assistant" : "user",
    content: [{ type: "text" as const, text: m.text }],
  }));

  // Mark the second-to-last message with cache_control so cumulative history
  // is cached on each subsequent turn (the last message is the current user input).
  if (anthropicMessages.length >= 2) {
    const secondToLast = anthropicMessages[anthropicMessages.length - 2];
    secondToLast.content[0] = {
      ...secondToLast.content[0],
      cache_control: { type: "ephemeral" },
    };
  }

  const response = await client.messages.create(
    {
      model,
      max_tokens: 600,
      system: [
        {
          type: "text" as const,
          text: systemPrompt,
          cache_control: { type: "ephemeral" as const },
        },
      ],
      messages: anthropicMessages,
    },
    { headers: { "anthropic-beta": "prompt-caching-2024-07-31" } }
  );

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const usage = response.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  const cacheHit = (usage.cache_read_input_tokens ?? 0) > 0;

  return { text, cacheHit };
}

// ─── POST /api/interrogator/start ────────────────────────────────

export async function startInterrogatorHandler(req: Request, res: Response): Promise<void> {
  const ip = req.ip ?? "unknown";
  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: "Rate limit exceeded. Max 5 sessions per hour." });
    return;
  }

  const { mode, posting, prompt: ambientPrompt } = req.body as {
    mode?: unknown;
    posting?: unknown;
    prompt?: unknown;
  };

  if (mode !== "reader_role" && mode !== "ambient") {
    res.status(400).json({ error: "mode must be reader_role or ambient" });
    return;
  }

  if (mode === "reader_role") {
    if (typeof posting !== "string" || posting.length < 100 || posting.length > 20000) {
      res.status(400).json({ error: "reader_role mode requires posting (100–20000 chars)" });
      return;
    }
  } else {
    if (typeof ambientPrompt !== "string" || ambientPrompt.length < 10 || ambientPrompt.length > 500) {
      res.status(400).json({ error: "ambient mode requires prompt (10–500 chars)" });
      return;
    }
  }

  const config = loadConfig();
  const session_id = nanoid(12);

  let frame: ReaderFrame | undefined;
  let seedRaw: string;
  let systemPrompt: string;

  if (mode === "reader_role") {
    const postingStr = posting as string;
    const extracted = await extractJobMetadata(postingStr);
    frame = await inferReaderFrame({
      company: extracted.company,
      title: extracted.title,
      description: postingStr,
      config,
    });
    seedRaw = extracted.company || "Unknown Company";
    systemPrompt = buildInterrogatorSystemPrompt({
      mode: "reader_role",
      company: extracted.company,
      title: extracted.title,
      frame,
    });
  } else {
    seedRaw = (ambientPrompt as string).slice(0, 40);
    systemPrompt = buildInterrogatorSystemPrompt({
      mode: "ambient",
      domain: ambientPrompt as string,
    });
  }

  // Generate opening message (no prior history)
  let openingMessage: string;
  try {
    const result = await callInterrogator(systemPrompt, []);
    openingMessage = result.text;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to generate opening message", detail });
    return;
  }

  const filename = makeFilename(mode, seedRaw);
  const started_at = new Date().toISOString();

  const frontmatter: Frontmatter = {
    mode,
    seed: mode === "reader_role" ? (posting as string).slice(0, 300) : (ambientPrompt as string),
    reader_frame: frame ?? null,
    started_at,
    ended_at: null,
    message_count: 1,
  };

  const messages: TranscriptMessage[] = [{ role: "interrogator", text: openingMessage }];
  writeSession(filename, frontmatter, messages);

  sessionRegistry.set(session_id, {
    filename,
    mode,
    seed: seedRaw,
    reader_frame: frame,
    started_at,
    system_prompt: systemPrompt,
  });

  upsertIndex({
    session_id,
    filename,
    mode,
    seed_preview: seedRaw.slice(0, 40),
    started_at,
    ended_at: null,
    message_count: 1,
  });

  console.log(`[interrogator] start session_id=${session_id} mode=${mode} file=${filename}`);

  res.json({
    session_id,
    filename,
    opening_message: openingMessage,
    ...(frame ? { reader_frame: frame } : {}),
  });
}

// ─── POST /api/interrogator/respond ──────────────────────────────

export async function respondInterrogatorHandler(req: Request, res: Response): Promise<void> {
  const { session_id, user_message } = req.body as {
    session_id?: unknown;
    user_message?: unknown;
  };

  if (typeof session_id !== "string" || !session_id) {
    res.status(400).json({ error: "session_id required" });
    return;
  }
  if (typeof user_message !== "string" || !user_message.trim()) {
    res.status(400).json({ error: "user_message required" });
    return;
  }

  const record = sessionRegistry.get(session_id);
  if (!record) {
    res.status(404).json({ error: "Session not found. It may have expired or been lost on server restart." });
    return;
  }

  const session = readSession(record.filename);
  if (!session) {
    res.status(404).json({ error: "Session file not found." });
    return;
  }

  const { frontmatter, messages } = session;

  if (frontmatter.ended_at) {
    res.status(400).json({ error: "Session has already ended." });
    return;
  }

  if (frontmatter.message_count >= MAX_MESSAGES_PER_SESSION) {
    res.status(400).json({ error: "Session message limit reached (40 messages)." });
    return;
  }

  // Append user message
  const updatedMessages: TranscriptMessage[] = [
    ...messages,
    { role: "andrew", text: user_message.trim() },
  ];

  // Generate interrogator response
  let interrogatorMessage: string;
  let cacheHit: boolean;
  try {
    const result = await callInterrogator(record.system_prompt, updatedMessages);
    interrogatorMessage = result.text;
    cacheHit = result.cacheHit;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to generate interrogator response", detail });
    return;
  }

  const finalMessages: TranscriptMessage[] = [
    ...updatedMessages,
    { role: "interrogator", text: interrogatorMessage },
  ];

  const newCount = frontmatter.message_count + 2;
  const updatedFrontmatter: Frontmatter = { ...frontmatter, message_count: newCount };
  writeSession(record.filename, updatedFrontmatter, finalMessages);

  upsertIndex({
    session_id,
    filename: record.filename,
    mode: record.mode,
    seed_preview: record.seed.slice(0, 40),
    started_at: record.started_at,
    ended_at: null,
    message_count: newCount,
  });

  console.log(`[interrogator] turn session_id=${session_id} messages=${newCount} cache_hit=${cacheHit}`);

  res.json({ interrogator_message: interrogatorMessage });
}

// ─── POST /api/interrogator/end ──────────────────────────────────

export async function endInterrogatorHandler(req: Request, res: Response): Promise<void> {
  const { session_id } = req.body as { session_id?: unknown };

  if (typeof session_id !== "string" || !session_id) {
    res.status(400).json({ error: "session_id required" });
    return;
  }

  const record = sessionRegistry.get(session_id);
  if (!record) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  const session = readSession(record.filename);
  if (!session) {
    res.status(404).json({ error: "Session file not found." });
    return;
  }

  const { frontmatter, messages } = session;
  const ended_at = new Date().toISOString();
  const duration_ms = new Date(ended_at).getTime() - new Date(record.started_at).getTime();

  const updatedFrontmatter: Frontmatter = { ...frontmatter, ended_at };
  writeSession(record.filename, updatedFrontmatter, messages);

  upsertIndex({
    session_id,
    filename: record.filename,
    mode: record.mode,
    seed_preview: record.seed.slice(0, 40),
    started_at: record.started_at,
    ended_at,
    message_count: frontmatter.message_count,
  });

  sessionRegistry.delete(session_id);

  console.log(`[interrogator] end session_id=${session_id} messages=${frontmatter.message_count} duration_ms=${duration_ms}`);

  res.json({
    filename: record.filename,
    message_count: frontmatter.message_count,
    duration_ms,
  });
}

// ─── GET /api/interrogator/sessions ──────────────────────────────

export function listInterrogatorSessionsHandler(_req: Request, res: Response): void {
  const index = loadIndex();
  res.json({ sessions: index });
}

// ─── GET /api/interrogator/session/:filename ──────────────────────

export function getInterrogatorSessionHandler(req: Request, res: Response): void {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;

  if (!filename || filename.includes("..") || filename.includes("/")) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }

  const session = readSession(filename);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const p = join(getInterrogatorDir(), filename);
  const content = readFileSync(p, "utf-8");

  res.json({
    content,
    metadata: session.frontmatter,
    messages: session.messages,
  });
}
