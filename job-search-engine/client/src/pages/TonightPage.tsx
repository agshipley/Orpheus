import { useState, useEffect, useCallback } from "react";
import * as api from "../api/client";
import type { TonightResponse, TonightPick } from "../types";

// ─── Score bar ────────────────────────────────────────────────────

const IDENTITY_META: Record<string, { label: string; color: string; barColor: string }> = {
  operator:            { label: "OP",  color: "text-blue-400",    barColor: "bg-blue-500"    },
  legal:               { label: "LEG", color: "text-amber-400",   barColor: "bg-amber-500"   },
  research:            { label: "RES", color: "text-emerald-400", barColor: "bg-emerald-500" },
  applied_ai_operator: { label: "AAI", color: "text-teal-400",    barColor: "bg-teal-500"    },
};

const MAX_RAW = 160;

function ScoreBars({ scores }: { scores: Record<string, number> }) {
  const keys: (keyof typeof IDENTITY_META)[] = ["operator", "legal", "research", "applied_ai_operator"];
  return (
    <div className="grid grid-cols-4 gap-2 mt-3">
      {keys.map((key) => {
        const meta = IDENTITY_META[key];
        const raw = scores[key] ?? 0;
        const pct = Math.min(100, Math.round((raw / MAX_RAW) * 100));
        const fired = raw >= 40;
        return (
          <div key={key} className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className={`text-[9px] font-mono font-semibold tracking-wider ${fired ? meta.color : "text-zinc-700"}`}>
                {meta.label}
              </span>
              <span className="text-[9px] font-mono text-zinc-600">{pct}%</span>
            </div>
            <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${fired ? meta.barColor : "bg-zinc-700"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Compound / Asymmetry badges ──────────────────────────────────

function CompoundBadge({ count }: { count?: number }) {
  if (!count || count < 2) return null;
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold font-mono tracking-wider border text-violet-400 border-violet-800 bg-violet-950/30">
      ×{count}
    </span>
  );
}

function AsymmetryBadge({ fit }: { fit?: string }) {
  if (fit !== "high") return null;
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold font-mono tracking-wider border text-orange-400 border-orange-800 bg-orange-950/30">
      ↑ asymmetry
    </span>
  );
}

function WinnerBadge({ identity }: { identity?: string }) {
  if (!identity) return null;
  const meta = IDENTITY_META[identity];
  if (!meta) return null;
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono tracking-wider border ${meta.color} border-current/30`}>
      {meta.label}
    </span>
  );
}

// ─── Salary / location helpers ────────────────────────────────────

function fmtSalary(pick: TonightPick): string {
  const { salary } = pick.job;
  if (!salary?.min) return "";
  const min = Math.round(salary.min / 1000);
  const max = salary.max ? Math.round(salary.max / 1000) : null;
  return max ? `$${min}–${max}k` : `$${min}k+`;
}

function fmtDate(isoDate?: string): string {
  if (!isoDate) return "";
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return "";
  const daysAgo = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (daysAgo === 0) return "today";
  if (daysAgo === 1) return "1d ago";
  if (daysAgo < 7) return `${daysAgo}d ago`;
  if (daysAgo < 30) return `${Math.floor(daysAgo / 7)}w ago`;
  return `${Math.floor(daysAgo / 30)}mo ago`;
}

// ─── Pick card ────────────────────────────────────────────────────

function PickCard({ pick, rank }: { pick: TonightPick; rank: number }) {
  const { job } = pick;
  const salary = fmtSalary(pick);
  const posted = fmtDate(job.postedAt);
  const score = Math.round((job.matchScore ?? 0) * 100);
  const isAsymmetry = job.asymmetry_fit === "high";

  return (
    <div
      className={`relative rounded-lg border transition-colors duration-200 ${
        isAsymmetry
          ? "border-orange-900/60 bg-orange-950/5"
          : "border-border-subtle bg-surface"
      } p-5`}
    >
      {/* Rank number */}
      <div className="absolute top-4 right-4 text-[11px] font-mono text-zinc-700">
        #{rank}
      </div>

      {/* Header */}
      <div className="pr-6">
        <a
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-block"
        >
          <h2 className="text-base font-semibold text-zinc-100 group-hover:text-teal-300 transition-colors leading-snug">
            {job.title}
          </h2>
        </a>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
          <span className="text-sm text-zinc-400 font-medium">{job.company}</span>
          {job.location && (
            <>
              <span className="text-zinc-700">·</span>
              <span className="text-sm text-zinc-500">{job.location}</span>
            </>
          )}
          {job.remote && (
            <>
              <span className="text-zinc-700">·</span>
              <span className="text-xs text-emerald-500 font-medium">Remote</span>
            </>
          )}
          {salary && (
            <>
              <span className="text-zinc-700">·</span>
              <span className="text-xs font-mono text-zinc-500">{salary}</span>
            </>
          )}
          {posted && (
            <>
              <span className="text-zinc-700">·</span>
              <span className="text-xs text-zinc-600">{posted}</span>
            </>
          )}
        </div>
      </div>

      {/* Badges */}
      <div className="flex flex-wrap items-center gap-1.5 mt-3">
        <WinnerBadge identity={job.matchedIdentity} />
        <CompoundBadge count={job.compound_fit} />
        <AsymmetryBadge fit={job.asymmetry_fit} />
        <span className="text-[10px] font-mono text-zinc-700 ml-auto">{score}%</span>
      </div>

      {/* Why paragraph */}
      <p className="mt-3 text-sm text-zinc-300 leading-relaxed">
        {pick.why_paragraph}
      </p>

      {/* GitHub signal hits */}
      {pick.github_signal_hits.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {pick.github_signal_hits.map((hit, i) => (
            <span
              key={i}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono text-zinc-500 bg-zinc-900 border border-zinc-800"
            >
              {hit}
            </span>
          ))}
        </div>
      )}

      {/* Score bars */}
      <ScoreBars scores={pick.identityScores} />

      {/* Actions */}
      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-border-subtle/50">
        <a
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors font-medium"
        >
          View posting →
        </a>
      </div>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="text-xs text-zinc-600 animate-pulse">
        Scanning 6 sources · scoring across 4 identities · generating analysis...
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-border-subtle bg-surface p-5 space-y-3 animate-pulse"
          style={{ opacity: 1 - i * 0.2 }}
        >
          <div className="h-4 w-2/3 rounded bg-zinc-800" />
          <div className="h-3 w-1/3 rounded bg-zinc-800" />
          <div className="h-3 w-full rounded bg-zinc-800" />
          <div className="h-3 w-4/5 rounded bg-zinc-800" />
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────

export default function TonightPage() {
  const [data, setData] = useState<TonightResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.getTonight()
      .then((r) => {
        setData(r);
        setLoadedAt(new Date());
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Search failed"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold text-zinc-100">Tonight's Five</h1>
          {data && (
            <span className="text-xs text-zinc-600">
              {data.meta.date}
            </span>
          )}
        </div>

        {data && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
            <span className="text-[11px] text-zinc-600">
              {data.meta.agentsSucceeded}/{data.meta.agentsQueried} agents
            </span>
            <span className="text-zinc-700 text-[11px]">·</span>
            <span className="text-[11px] text-zinc-600">
              {data.meta.rawResults} raw
            </span>
            <span className="text-zinc-700 text-[11px]">·</span>
            <span className="text-[11px] text-zinc-600">
              {data.meta.afterDedup} deduped
            </span>
            <span className="text-zinc-700 text-[11px]">·</span>
            <span className="text-[11px] text-zinc-600">
              {data.picks.length} curated
            </span>
            <span className="text-zinc-700 text-[11px]">·</span>
            <span className="text-[11px] text-zinc-600">
              {(data.meta.durationMs / 1000).toFixed(1)}s
            </span>
            {data.meta.mode !== "curated" && (
              <>
                <span className="text-zinc-700 text-[11px]">·</span>
                <span className="text-[11px] text-amber-600 font-medium">
                  {data.meta.mode === "best_available" ? "best available" : "empty"}
                </span>
              </>
            )}
          </div>
        )}

        {data?.meta.corpus_note && (
          <p className="mt-2 text-[11px] text-zinc-600 border border-border-subtle rounded px-3 py-2 bg-surface">
            {data.meta.corpus_note}
          </p>
        )}
      </div>

      {/* Refresh + load time */}
      <div className="flex items-center justify-between mb-5">
        <div className="text-[11px] text-zinc-700">
          {loadedAt && !loading && `Loaded at ${loadedAt.toLocaleTimeString()}`}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-[11px] text-zinc-500 hover:text-zinc-300 border border-border-subtle rounded px-2.5 py-1 transition-colors disabled:opacity-40"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {/* States */}
      {loading && <Skeleton />}

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-950/30 border border-red-900/40 text-red-400 text-sm">
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <div className="space-y-4">
          {data.picks.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-zinc-500 text-sm">No picks returned tonight.</p>
              <p className="text-zinc-600 text-xs mt-1">
                Try refreshing — sources may be warming up.
              </p>
            </div>
          ) : (
            data.picks.map((pick, i) => (
              <PickCard key={pick.job.id} pick={pick} rank={i + 1} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
