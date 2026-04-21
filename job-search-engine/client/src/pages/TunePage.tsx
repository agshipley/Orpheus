import { useState, useEffect, useCallback } from "react";
import * as api from "../api/client";
import type { JobListing, SearchResult, FeedbackStatus, RankerWeight } from "../types";

// ─── Rating labels ────────────────────────────────────────────────

const RATINGS = [
  { value: 2,  key: "1", label: "Love it",     color: "text-emerald-400 border-emerald-700 bg-emerald-900/30" },
  { value: 1,  key: "2", label: "Interested",  color: "text-blue-400 border-blue-700 bg-blue-900/30" },
  { value: 0,  key: "3", label: "Neutral",      color: "text-zinc-400 border-zinc-700 bg-zinc-800/40" },
  { value: -1, key: "4", label: "Not for me",  color: "text-amber-400 border-amber-700 bg-amber-900/20" },
  { value: -2, key: "5", label: "Never",        color: "text-red-400 border-red-700 bg-red-900/20" },
] as const;

const IDENTITY_KEYS = ["operator", "legal", "research"] as const;

// ─── Identity badge ───────────────────────────────────────────────

function IdentityBadge({ identity }: { identity?: string }) {
  if (!identity) return null;
  const map: Record<string, { label: string; color: string }> = {
    operator: { label: "OP",  color: "text-blue-400 border-blue-800" },
    legal:    { label: "LEG", color: "text-amber-400 border-amber-800" },
    research: { label: "RES", color: "text-emerald-400 border-emerald-800" },
  };
  const { label, color } = map[identity] ?? { label: "?", color: "text-zinc-500 border-zinc-700" };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono tracking-wider border ${color}`}>
      {label}
    </span>
  );
}

// ─── Distribution bar ─────────────────────────────────────────────

function DistributionBar({ distribution, total }: { distribution: Record<string, number>; total: number }) {
  if (total === 0) return <span className="text-zinc-600 text-xs">No ratings yet</span>;
  const colorMap: Record<string, string> = {
    "2":  "bg-emerald-500",
    "1":  "bg-blue-500",
    "0":  "bg-zinc-500",
    "-1": "bg-amber-500",
    "-2": "bg-red-500",
  };
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-2 rounded-full overflow-hidden w-48 bg-elevated">
        {[2, 1, 0, -1, -2].map((v) => {
          const count = distribution[String(v)] ?? 0;
          const pct = total > 0 ? (count / total) * 100 : 0;
          if (pct === 0) return null;
          return <div key={v} className={`${colorMap[String(v)]} h-full`} style={{ width: `${pct}%` }} />;
        })}
      </div>
      <span className="text-zinc-500 text-xs tabular-nums">{total} rated</span>
    </div>
  );
}

// ─── Weights table ────────────────────────────────────────────────

function WeightsPanel({
  weights,
  onRetune,
  onReset,
  retuning,
}: {
  weights: RankerWeight[];
  onRetune: () => void;
  onReset: () => void;
  retuning: boolean;
}) {
  const byIdentity: Record<string, RankerWeight[]> = {};
  for (const w of weights) {
    if (!byIdentity[w.identity]) byIdentity[w.identity] = [];
    byIdentity[w.identity].push(w);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-zinc-300">Learned Weights</h3>
        <button
          onClick={onRetune}
          disabled={retuning}
          className="ml-auto px-2.5 py-1 rounded text-xs border border-blue-700 text-blue-400 hover:bg-blue-900/30 disabled:opacity-50"
        >
          {retuning ? "Retuning…" : "Retune now"}
        </button>
        <button
          onClick={onReset}
          className="px-2.5 py-1 rounded text-xs border border-zinc-700 text-zinc-400 hover:bg-elevated"
        >
          Reset all
        </button>
      </div>

      {weights.length === 0 ? (
        <p className="text-zinc-600 text-xs">No weight data yet — need ≥10 ratings per feature/identity.</p>
      ) : (
        Object.entries(byIdentity).map(([identity, rows]) => (
          <div key={identity}>
            <div className="text-xs font-mono text-zinc-500 uppercase tracking-wider mb-1.5">
              {identity}
            </div>
            <div className="border border-border-subtle rounded overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-elevated border-b border-border-subtle">
                    <th className="text-left px-3 py-1.5 text-zinc-500 font-normal">Feature</th>
                    <th className="text-right px-3 py-1.5 text-zinc-500 font-normal">Weight</th>
                    <th className="text-right px-3 py-1.5 text-zinc-500 font-normal">Base</th>
                    <th className="text-right px-3 py-1.5 text-zinc-500 font-normal">Corr.</th>
                    <th className="text-right px-3 py-1.5 text-zinc-500 font-normal">N</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w) => {
                    const drift = w.weight - w.baseWeight;
                    const driftColor = drift > 0.05 ? "text-emerald-400" : drift < -0.05 ? "text-red-400" : "text-zinc-400";
                    return (
                      <tr key={w.featureName} className="border-t border-border-subtle/50">
                        <td className="px-3 py-1.5 text-zinc-300 font-mono">{w.featureName}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums font-mono ${driftColor}`}>
                          {w.weight.toFixed(3)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-mono text-zinc-600">
                          {w.baseWeight.toFixed(3)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-mono text-zinc-500">
                          {w.correlation !== null ? w.correlation.toFixed(3) : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-zinc-600">{w.sampleSize}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ─── Job card ─────────────────────────────────────────────────────

function JobCard({
  job,
  index,
  total,
  onRate,
  rating,
  status,
}: {
  job: JobListing;
  index: number;
  total: number;
  onRate: (rating: number, correctedIdentity?: string) => void;
  rating: number | null;
  status: "idle" | "saving" | "saved";
}) {
  const [correctedIdentity, setCorrectedIdentity] = useState<string>("");
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border-subtle rounded-lg bg-elevated overflow-hidden">
      {/* Card header */}
      <div className="px-5 pt-4 pb-3 space-y-1">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-zinc-100 leading-snug truncate">{job.title}</h2>
            <div className="flex items-center gap-2 mt-0.5 text-sm text-zinc-400">
              <span>{job.company}</span>
              {job.location && <span className="text-zinc-600">·</span>}
              {job.location && <span>{job.location}</span>}
              {job.remote && <span className="tag text-[10px]">Remote</span>}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <IdentityBadge identity={job.matchedIdentity} />
            {job.matchScore !== undefined && (
              <span className="text-xs font-mono text-zinc-500">
                {Math.round(job.matchScore * 100)}%
              </span>
            )}
          </div>
        </div>

        {/* Score reasons */}
        {job.identityReasons && job.matchedIdentity && (
          <div className="flex flex-wrap gap-1 mt-1">
            {(job.identityReasons[job.matchedIdentity] ?? []).slice(0, 4).map((r, i) => (
              <span key={i} className="tag text-[10px] text-zinc-500">{r}</span>
            ))}
          </div>
        )}
      </div>

      {/* Description */}
      <div className="px-5 pb-3">
        <p className={`text-sm text-zinc-400 leading-relaxed ${expanded ? "" : "line-clamp-3"}`}>
          {job.description}
        </p>
        {job.description.length > 200 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-zinc-600 hover:text-zinc-400 mt-1"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>

      {/* Identity correction */}
      <div className="px-5 pb-3 flex items-center gap-2">
        <span className="text-xs text-zinc-600">Matched as:</span>
        <IdentityBadge identity={job.matchedIdentity} />
        <span className="text-xs text-zinc-600 ml-2">Correct to:</span>
        <select
          value={correctedIdentity}
          onChange={(e) => setCorrectedIdentity(e.target.value)}
          className="text-xs bg-void border border-border-subtle rounded px-2 py-0.5 text-zinc-400"
        >
          <option value="">— keep —</option>
          {IDENTITY_KEYS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>

      {/* Rating buttons */}
      <div className="px-5 pb-4 border-t border-border-subtle/50 pt-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-600 w-24 shrink-0">
            {index + 1} / {total}
          </span>
          <div className="flex gap-1.5 flex-1">
            {RATINGS.map(({ value, key, label, color }) => (
              <button
                key={value}
                onClick={() => onRate(value, correctedIdentity || undefined)}
                disabled={status === "saving"}
                className={`flex-1 px-2 py-1.5 rounded border text-xs font-medium transition-all ${
                  rating === value
                    ? color
                    : "border-border-subtle text-zinc-600 hover:border-zinc-600 hover:text-zinc-400"
                } disabled:opacity-50`}
                title={`[${key}] ${label}`}
              >
                {label}
              </button>
            ))}
          </div>
          {status === "saving" && <span className="text-xs text-zinc-600">Saving…</span>}
          {status === "saved" && <span className="text-xs text-emerald-600">✓</span>}
          {job.url && (
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-zinc-600 hover:text-zinc-400 ml-1 shrink-0"
            >
              ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────

export default function TunePage() {
  const [identity, setIdentity] = useState<"operator" | "legal" | "research">("operator");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobListing[]>([]);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [saveStatus, setSaveStatus] = useState<Record<string, "idle" | "saving" | "saved">>({});
  const [status, setStatus] = useState<FeedbackStatus | null>(null);
  const [retuning, setRetuning] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Load feedback status on mount
  useEffect(() => {
    api.getFeedbackStatus().then(setStatus).catch(() => {});
  }, []);

  // Keyboard shortcuts: 1-5 for rating current unrated card, arrow keys to scroll
  useEffect(() => {
    const firstUnrated = jobs.find((j) => ratings[j.id] === undefined);
    if (!firstUnrated) return;

    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      const ratingMap: Record<string, number> = { "1": 2, "2": 1, "3": 0, "4": -1, "5": -2 };
      if (ratingMap[e.key] !== undefined) {
        e.preventDefault();
        handleRate(firstUnrated.id, firstUnrated, ratingMap[e.key]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [jobs, ratings]);

  async function handleSearch() {
    setLoading(true);
    setError(null);
    setRatings({});
    setSaveStatus({});
    try {
      const result: SearchResult = await api.searchWide(identity);
      setJobs(result.jobs);
      setSearchQuery(result.query.raw);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  const handleRate = useCallback(async (
    jobId: string,
    job: JobListing,
    rating: number,
    correctedIdentity?: string
  ) => {
    setRatings((prev) => ({ ...prev, [jobId]: rating }));
    setSaveStatus((prev) => ({ ...prev, [jobId]: "saving" }));
    try {
      const resp = await api.submitFeedback({
        jobId,
        rating,
        matchedIdentity: job.matchedIdentity,
        correctedIdentity: correctedIdentity || undefined,
        searchQuery,
        identityReasons: job.identityReasons,
      });
      setSaveStatus((prev) => ({ ...prev, [jobId]: "saved" }));
      // Refresh status after auto-retune/summarize
      if (resp.autoRetuned || resp.autoSummarized) {
        api.getFeedbackStatus().then(setStatus).catch(() => {});
      }
    } catch {
      setSaveStatus((prev) => ({ ...prev, [jobId]: "idle" }));
    }
  }, [searchQuery]);

  async function handleRetune() {
    setRetuning(true);
    try {
      await api.retuneWeights();
      const updated = await api.getFeedbackStatus();
      setStatus(updated);
    } finally {
      setRetuning(false);
    }
  }

  async function handleReset() {
    // Call retune with an explicit reset — we don't have a reset endpoint,
    // so we just refresh the status; user can use the server-side reset button.
    const updated = await api.getFeedbackStatus().catch(() => null);
    if (updated) setStatus(updated);
  }

  async function handleRegenerateSummary() {
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      await api.regenerateSummary();
      const updated = await api.getFeedbackStatus();
      setStatus(updated);
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : "Failed to regenerate summary");
    } finally {
      setSummaryLoading(false);
    }
  }

  const ratedCount = Object.keys(ratings).length;

  return (
    <div className="max-w-screen-lg mx-auto px-6 py-6 space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-zinc-100">Tune</h1>
        <p className="text-sm text-zinc-500">
          Rate jobs to teach Orpheus your preferences. Weights adjust automatically every 20 votes.
        </p>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        <div className="flex border border-border-subtle rounded overflow-hidden">
          {IDENTITY_KEYS.map((k) => (
            <button
              key={k}
              onClick={() => setIdentity(k)}
              className={`px-3 py-1.5 text-sm transition-colors ${
                identity === k
                  ? "bg-elevated text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <button
          onClick={handleSearch}
          disabled={loading}
          className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load jobs"}
        </button>
        {jobs.length > 0 && (
          <span className="text-xs text-zinc-500">
            {ratedCount} / {jobs.length} rated
          </span>
        )}
      </div>

      {/* Progress bar */}
      {jobs.length > 0 && (
        <div className="h-1 rounded-full bg-elevated overflow-hidden">
          <div
            className="h-full rounded-full bg-blue-600 transition-all duration-300"
            style={{ width: `${(ratedCount / jobs.length) * 100}%` }}
          />
        </div>
      )}

      {error && (
        <div className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded px-4 py-2">
          {error}
        </div>
      )}

      {/* Stats bar */}
      {status && (
        <div className="flex items-center gap-4 py-2 border-b border-border-subtle">
          <DistributionBar distribution={status.stats.distribution} total={status.stats.total} />
          <span className="text-xs text-zinc-600 ml-auto">
            {status.stats.correctionCount} corrections
          </span>
        </div>
      )}

      {/* Main two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        {/* Left: job cards */}
        <div className="space-y-4">
          {jobs.length === 0 && !loading && (
            <div className="text-center py-16 text-zinc-600 text-sm">
              Select an identity and load jobs to start rating.
            </div>
          )}
          {jobs.map((job, i) => (
            <JobCard
              key={job.id}
              job={job}
              index={i}
              total={jobs.length}
              onRate={(rating, correctedIdentity) => handleRate(job.id, job, rating, correctedIdentity)}
              rating={ratings[job.id] ?? null}
              status={saveStatus[job.id] ?? "idle"}
            />
          ))}
        </div>

        {/* Right: weights + summary panel */}
        <div className="space-y-6">
          {status && (
            <WeightsPanel
              weights={status.weights}
              onRetune={handleRetune}
              onReset={handleReset}
              retuning={retuning}
            />
          )}

          {/* Preference summary */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-zinc-300">Preference Summary</h3>
              <button
                onClick={handleRegenerateSummary}
                disabled={summaryLoading}
                className="ml-auto px-2.5 py-1 rounded text-xs border border-zinc-700 text-zinc-400 hover:bg-elevated disabled:opacity-50"
              >
                {summaryLoading ? "Generating…" : "Regenerate"}
              </button>
            </div>
            {summaryError && (
              <p className="text-xs text-red-400">{summaryError}</p>
            )}
            {status?.latestSummary ? (
              <div className="text-xs space-y-2 border border-border-subtle rounded p-3 bg-void">
                <div className="text-zinc-600 font-mono">
                  {new Date(status.latestSummary.generatedAt).toLocaleDateString()} · {status.latestSummary.sampleSize} votes
                </div>
                {(() => {
                  try {
                    const parsed = JSON.parse(status.latestSummary.summaryJson);
                    return (
                      <div className="space-y-2">
                        {parsed.strong_likes?.length > 0 && (
                          <div>
                            <div className="text-emerald-500 font-medium mb-0.5">Strong likes</div>
                            <ul className="space-y-0.5">
                              {parsed.strong_likes.map((s: string, i: number) => (
                                <li key={i} className="text-zinc-400">· {s}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {parsed.strong_dislikes?.length > 0 && (
                          <div>
                            <div className="text-red-400 font-medium mb-0.5">Strong dislikes</div>
                            <ul className="space-y-0.5">
                              {parsed.strong_dislikes.map((s: string, i: number) => (
                                <li key={i} className="text-zinc-400">· {s}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {parsed.divergence_from_stated?.length > 0 && (
                          <div>
                            <div className="text-amber-400 font-medium mb-0.5">Divergence from stated prefs</div>
                            <ul className="space-y-0.5">
                              {parsed.divergence_from_stated.map((s: string, i: number) => (
                                <li key={i} className="text-zinc-400">· {s}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  } catch {
                    return <pre className="text-zinc-500 whitespace-pre-wrap text-[11px]">{status.latestSummary?.summaryJson}</pre>;
                  }
                })()}
              </div>
            ) : (
              <p className="text-xs text-zinc-600">
                No summary yet — generate one after ≥10 ratings.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
