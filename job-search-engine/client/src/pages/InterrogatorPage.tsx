import { useState, useEffect, useRef, useCallback } from "react";
import * as api from "../api/client";
import type {
  InterrogatorSessionMeta,
  InterrogatorMessage,
  ReaderFrame,
  MotiveFrame,
  SessionDetailResponse,
} from "../types";

// ─── Frame color map (shared with PackagePage) ────────────────────

const FRAME_COLORS: Record<MotiveFrame, string> = {
  profit:  "bg-rose-950/40 text-rose-400 border-rose-800",
  thesis:  "bg-violet-950/40 text-violet-400 border-violet-800",
  market:  "bg-blue-950/40 text-blue-400 border-blue-800",
  mission: "bg-emerald-950/40 text-emerald-400 border-emerald-800",
  craft:   "bg-amber-950/40 text-amber-400 border-amber-800",
  service: "bg-teal-950/40 text-teal-400 border-teal-800",
};

// ─── Helpers ──────────────────────────────────────────────────────

function relativeDate(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(delta / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function modeLabel(mode: "reader_role" | "ambient") {
  return mode === "reader_role" ? "reader-role" : "ambient";
}

// ─── Active session state ─────────────────────────────────────────

interface ActiveSession {
  session_id: string;
  filename: string;
  mode: "reader_role" | "ambient";
  seed: string;
  reader_frame?: ReaderFrame;
  messages: InterrogatorMessage[];
  ended: boolean;
}

// ─── Session list sidebar ─────────────────────────────────────────

function SessionListItem({
  session,
  onSelect,
}: {
  session: InterrogatorSessionMeta;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="w-full text-left px-3 py-2.5 rounded-md hover:bg-zinc-800/60 transition-colors group"
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span className="text-[10px] font-mono font-semibold text-zinc-600 uppercase tracking-wider">
          {modeLabel(session.mode)}
        </span>
        {session.ended_at && (
          <span className="text-[10px] text-zinc-700">✓</span>
        )}
        <span className="ml-auto text-[10px] text-zinc-700">{session.message_count}msg</span>
      </div>
      <div className="text-xs text-zinc-300 truncate">{session.seed_preview}</div>
      <div className="text-[10px] text-zinc-600 mt-0.5">{relativeDate(session.started_at)}</div>
    </button>
  );
}

// ─── Chat bubble ──────────────────────────────────────────────────

function ChatBubble({ msg }: { msg: InterrogatorMessage }) {
  const isInterrogator = msg.role === "interrogator";
  return (
    <div className={`flex ${isInterrogator ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[78%] rounded-lg px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
          isInterrogator
            ? "bg-zinc-900 border border-border-subtle text-zinc-200"
            : "bg-zinc-800 text-zinc-300"
        }`}
      >
        {msg.text}
      </div>
    </div>
  );
}

// ─── Reader frame collapsible ─────────────────────────────────────

function ReaderFrameBadge({ frame }: { frame: ReaderFrame }) {
  const [open, setOpen] = useState(false);
  const pillClass = FRAME_COLORS[frame.primary] ?? "bg-zinc-900 text-zinc-400 border-zinc-700";

  return (
    <div className="border border-border-subtle rounded-md overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold border ${pillClass}`}>
          {frame.primary}
        </span>
        <span className="text-zinc-500">{frame.reader_role_guess}</span>
        <span className="ml-auto text-zinc-700">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 bg-zinc-950/30">
          <div className="text-[11px] text-zinc-500">{frame.frame_rationale}</div>
          <ul className="space-y-0.5">
            {frame.reader_concerns.map((c, i) => (
              <li key={i} className="text-[11px] text-zinc-500 flex items-start gap-1.5">
                <span className="shrink-0 mt-1 text-zinc-700">·</span>
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Past session view ────────────────────────────────────────────

function PastSessionView({
  detail,
  onNewFromTopic,
}: {
  detail: SessionDetailResponse;
  onNewFromTopic: () => void;
}) {
  const { metadata, messages } = detail;
  const dur = metadata.ended_at
    ? Math.round(
        (new Date(metadata.ended_at).getTime() - new Date(metadata.started_at).getTime()) / 60000
      )
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono font-semibold text-zinc-600 uppercase tracking-wider">
            {modeLabel(metadata.mode)}
          </span>
          <span className="text-sm text-zinc-300">
            {metadata.seed.slice(0, 60)}{metadata.seed.length > 60 ? "…" : ""}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-zinc-600">
            {metadata.message_count} messages
            {dur !== null ? ` · ${dur}m` : ""}
          </span>
          <button
            onClick={onNewFromTopic}
            className="text-[11px] text-zinc-400 hover:text-zinc-200 border border-border-subtle rounded px-2.5 py-1 transition-colors"
          >
            Start new on this topic
          </button>
        </div>
      </div>

      {/* Reader frame */}
      {metadata.reader_frame && (
        <div className="px-6 py-3 border-b border-border-subtle">
          <ReaderFrameBadge frame={metadata.reader_frame} />
        </div>
      )}

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.map((msg, i) => (
          <ChatBubble key={i} msg={msg} />
        ))}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────

export default function InterrogatorPage() {
  const [sessions, setSessions] = useState<InterrogatorSessionMeta[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  // view: "setup" | "session" | "past"
  const [view, setView] = useState<"setup" | "session" | "past">("setup");
  const [setupTab, setSetupTab] = useState<"reader_role" | "ambient">("reader_role");

  // Setup form
  const [posting, setPosting] = useState("");
  const [domain, setDomain] = useState("");

  // Active session
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Past session
  const [pastDetail, setPastDetail] = useState<SessionDetailResponse | null>(null);
  const [pastSeed, setPastSeed] = useState<{ mode: "reader_role" | "ambient"; seed: string } | null>(null);

  const chatBottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load sessions on mount
  useEffect(() => {
    api.listInterrogatorSessions()
      .then((r) => setSessions(r.sessions))
      .catch(() => {})
      .finally(() => setSessionsLoading(false));
  }, []);

  // Scroll to bottom when messages change
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages.length, thinking]);

  // Focus input when entering session
  useEffect(() => {
    if (view === "session" && !thinking && !active?.ended) {
      inputRef.current?.focus();
    }
  }, [view, thinking, active?.ended]);

  const refreshSessions = useCallback(() => {
    api.listInterrogatorSessions()
      .then((r) => setSessions(r.sessions))
      .catch(() => {});
  }, []);

  const handleStartSession = async () => {
    setStarting(true);
    setSessionError(null);
    try {
      const params =
        setupTab === "reader_role"
          ? { mode: "reader_role" as const, posting }
          : { mode: "ambient" as const, prompt: domain };

      const r = await api.startInterrogatorSession(params);

      const seedDisplay =
        setupTab === "reader_role"
          ? (posting.match(/company[:\s]+([^\n]{1,40})/i)?.[1]?.trim() ?? "Posting")
          : domain.slice(0, 40);

      setActive({
        session_id: r.session_id,
        filename: r.filename,
        mode: setupTab,
        seed: seedDisplay,
        reader_frame: r.reader_frame,
        messages: [{ role: "interrogator", text: r.opening_message }],
        ended: false,
      });
      setView("session");
      refreshSessions();
    } catch (e) {
      setSessionError(e instanceof Error ? e.message : "Failed to start session");
    } finally {
      setStarting(false);
    }
  };

  const handleSend = async () => {
    if (!active || !input.trim() || thinking || active.ended) return;
    const text = input.trim();
    setInput("");
    setThinking(true);
    setSessionError(null);

    const userMsg: InterrogatorMessage = { role: "andrew", text };
    setActive((a) => a ? { ...a, messages: [...a.messages, userMsg] } : a);

    try {
      const r = await api.sendInterrogatorResponse(active.session_id, text);
      const interrogatorMsg: InterrogatorMessage = { role: "interrogator", text: r.interrogator_message };
      setActive((a) => {
        if (!a) return a;
        const newMessages = [...a.messages, interrogatorMsg];
        if (newMessages.length >= 40) {
          api.endInterrogatorSession(a.session_id).catch(() => {});
          refreshSessions();
          return { ...a, messages: newMessages, ended: true };
        }
        return { ...a, messages: newMessages };
      });
    } catch (e) {
      setSessionError(e instanceof Error ? e.message : "Response failed — try again.");
      setActive((a) => a ? { ...a, messages: a.messages.slice(0, -1) } : a);
      setInput(text);
    } finally {
      setThinking(false);
    }
  };

  const handleEndSession = async () => {
    if (!active) return;
    try {
      await api.endInterrogatorSession(active.session_id);
    } catch {
      // best-effort
    }
    setActive((a) => a ? { ...a, ended: true } : a);
    refreshSessions();
  };

  const handleViewPast = async (session: InterrogatorSessionMeta) => {
    try {
      const detail = await api.getInterrogatorSession(session.filename);
      setPastDetail(detail);
      setPastSeed({ mode: session.mode, seed: session.seed_preview });
      setView("past");
    } catch {
      // ignore
    }
  };

  const handleNewFromTopic = () => {
    if (!pastSeed) return;
    if (pastSeed.mode === "reader_role") {
      setSetupTab("reader_role");
    } else {
      setSetupTab("ambient");
      setDomain(pastSeed.seed);
    }
    setView("setup");
    setPastDetail(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const canStart =
    setupTab === "reader_role"
      ? posting.length >= 100
      : domain.length >= 10;

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* ── Left sidebar: session list ─────────────────────────────── */}
      <aside className="w-72 shrink-0 border-r border-border-subtle flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <span className="text-xs font-semibold text-zinc-400">Past sessions</span>
          <button
            onClick={() => { setView("setup"); setActive(null); }}
            className="text-[11px] text-zinc-500 hover:text-zinc-200 border border-border-subtle rounded px-2 py-0.5 transition-colors"
          >
            New session
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {sessionsLoading && (
            <div className="text-[11px] text-zinc-700 px-2 py-2">Loading...</div>
          )}
          {!sessionsLoading && sessions.length === 0 && (
            <div className="text-[11px] text-zinc-700 px-2 py-2">No sessions yet.</div>
          )}
          {sessions.map((s) => (
            <SessionListItem
              key={s.session_id}
              session={s}
              onSelect={() => handleViewPast(s)}
            />
          ))}
        </div>
      </aside>

      {/* ── Main area ─────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* SETUP view */}
        {view === "setup" && (
          <div className="flex-1 overflow-y-auto px-8 py-8 max-w-2xl">
            <h1 className="text-xl font-semibold text-zinc-100 mb-1">Interrogator</h1>
            <p className="text-sm text-zinc-500 mb-6">
              Extract tacit operating knowledge through structured interview. Reader-role mode plays the hiring reader for a posted role. Ambient mode explores any domain you name.
            </p>

            {/* Mode tabs */}
            <div className="flex gap-1 mb-6 border border-border-subtle rounded-md p-1 w-fit">
              {(["reader_role", "ambient"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setSetupTab(tab)}
                  className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                    setupTab === tab
                      ? "bg-zinc-700 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {tab === "reader_role" ? "Reader-role" : "Ambient"}
                </button>
              ))}
            </div>

            {setupTab === "reader_role" && (
              <div className="space-y-4">
                <textarea
                  value={posting}
                  onChange={(e) => setPosting(e.target.value)}
                  rows={12}
                  placeholder="Paste the full job posting — the system will infer the reader and play that role."
                  className="w-full rounded-lg border border-border-subtle bg-surface px-4 py-3 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 resize-y font-mono"
                />
                <p className="text-[11px] text-zinc-600">
                  The reader-frame is inferred automatically. The interrogator will state who they are playing before asking the first question.
                </p>
              </div>
            )}

            {setupTab === "ambient" && (
              <div className="space-y-4">
                <input
                  type="text"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="e.g. the SOC II process at Trace Machina, or the EeroQ outside-counsel to CoS transition"
                  className="w-full rounded-lg border border-border-subtle bg-surface px-4 py-3 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
                />
                <p className="text-[11px] text-zinc-600">
                  The interrogator will interpret your domain and commit — no clarifying questions.
                </p>
              </div>
            )}

            {sessionError && (
              <div className="mt-4 px-4 py-3 rounded-lg bg-red-950/30 border border-red-900/40 text-red-400 text-sm">
                {sessionError}
              </div>
            )}

            <button
              onClick={handleStartSession}
              disabled={!canStart || starting}
              className="mt-6 w-full rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-border-subtle text-sm font-medium text-zinc-100 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {starting ? "Starting session..." : "Start session"}
            </button>
          </div>
        )}

        {/* SESSION view */}
        {view === "session" && active && (
          <div className="flex flex-col h-full">
            {/* Session header */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-border-subtle shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-mono font-semibold text-zinc-600 uppercase tracking-wider">
                  {modeLabel(active.mode)}
                </span>
                <span className="text-sm text-zinc-400 truncate max-w-xs">{active.seed}</span>
                {active.ended && (
                  <span className="text-[10px] text-zinc-600 font-mono">· ended</span>
                )}
              </div>
              {!active.ended && (
                <button
                  onClick={handleEndSession}
                  className="text-[11px] text-zinc-600 hover:text-zinc-400 border border-border-subtle rounded px-2.5 py-1 transition-colors"
                >
                  End session
                </button>
              )}
            </div>

            {/* Reader frame (collapsible) */}
            {active.reader_frame && (
              <div className="px-6 py-2 border-b border-border-subtle shrink-0">
                <ReaderFrameBadge frame={active.reader_frame} />
              </div>
            )}

            {/* Chat transcript */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {active.messages.map((msg, i) => (
                <ChatBubble key={i} msg={msg} />
              ))}
              {thinking && (
                <div className="flex justify-start">
                  <div className="bg-zinc-900 border border-border-subtle rounded-lg px-4 py-3 text-sm text-zinc-600 animate-pulse">
                    Thinking...
                  </div>
                </div>
              )}
              {active.ended && active.messages.length >= 40 && (
                <div className="text-center text-[11px] text-zinc-600 py-2">
                  Session complete (40 messages). Starting a new session continues the extraction.
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>

            {/* Error banner */}
            {sessionError && (
              <div className="mx-6 mb-2 px-3 py-2 rounded bg-red-950/30 border border-red-900/40 text-red-400 text-xs">
                {sessionError}
              </div>
            )}

            {/* Input */}
            {!active.ended && (
              <div className="shrink-0 border-t border-border-subtle px-6 py-4 flex gap-3 items-end">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={thinking}
                  rows={3}
                  placeholder="Answer here — ⌘↵ to send, ⇧↵ for newline"
                  className="flex-1 rounded-lg border border-border-subtle bg-surface px-3 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 resize-none disabled:opacity-40"
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || thinking}
                  className="shrink-0 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-border-subtle text-sm font-medium text-zinc-100 px-4 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Send
                </button>
              </div>
            )}
          </div>
        )}

        {/* PAST SESSION view */}
        {view === "past" && pastDetail && (
          <PastSessionView
            detail={pastDetail}
            onNewFromTopic={handleNewFromTopic}
          />
        )}
      </div>
    </div>
  );
}
