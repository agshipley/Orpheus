import { useState, useEffect, useRef, useCallback } from "react";
import * as api from "../api/client";
import type { JobListing, SearchResult } from "../types";
import JobDetailPanel from "../components/JobDetailPanel";

function fmtSalary(job: JobListing): string {
  if (!job.salary) return "—";
  const fmt = (n?: number) => n ? `$${Math.round(n / 1000)}k` : null;
  const lo = fmt(job.salary.min);
  const hi = fmt(job.salary.max);
  if (lo && hi) return `${lo}–${hi}`;
  return lo ?? hi ?? "—";
}

function ScoreBadge({ score }: { score?: number }) {
  if (score === undefined) return <span className="text-zinc-700">—</span>;
  const pct = Math.round(score * 100);
  const color =
    pct >= 80 ? "text-emerald-400" :
    pct >= 60 ? "text-amber-400"  :
               "text-zinc-600";
  return (
    <span className={`flex items-center gap-2 ${color}`}>
      <span className="w-16 h-1 rounded-full bg-elevated overflow-hidden">
        <span className="block h-full rounded-full bg-current" style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono text-xs">{pct}%</span>
    </span>
  );
}

function SourceBadge({ source }: { source: string }) {
  const map: Record<string, string> = {
    ycombinator: "YC",
    linkedin: "LI",
    indeed: "IN",
    github: "GH",
    waas: "WS",
    jobicy: "JB",
    getro: "GT",
    pallet: "PL",
    custom: "—",
  };
  return (
    <span className="tag font-mono text-[10px] tracking-wider">
      {map[source] ?? source.slice(0, 2).toUpperCase()}
    </span>
  );
}

function StatChip({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-zinc-500">
      <span className="text-zinc-700">{label}</span>
      <span className="text-zinc-300 font-medium tabular-nums">{value}</span>
    </span>
  );
}

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [visibleCount, setVisibleCount] = useState(0);
  const [selected, setSelected] = useState<JobListing | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (!result) return;
    setVisibleCount(0);
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    result.jobs.forEach((_, i) => {
      timeouts.push(setTimeout(() => setVisibleCount(i + 1), i * 35));
    });
    return () => timeouts.forEach(clearTimeout);
  }, [result]);

  const handleSearch = useCallback(async () => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setSelected(null);
    try {
      const res = await api.search(query.trim());
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [query, loading]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
    if (e.key === "Escape") setSelected(null);
  };

  const hasResults = result && result.jobs.length > 0;

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* Main column */}
      <div className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${selected ? "mr-[540px]" : ""}`}>

        {/* Search header */}
        <div className={`flex-shrink-0 px-6 transition-all duration-500 ${hasResults ? "pt-5 pb-4" : "pt-36 pb-10"}`}>
          <div className={`mx-auto transition-all duration-500 ${hasResults ? "max-w-none" : "max-w-lg text-center"}`}>
            {!hasResults && !loading && !error && (
              <>
                <h1 className="text-[28px] font-semibold text-zinc-50 mb-2 tracking-tight leading-snug">
                  Find your next role
                </h1>
                <p className="text-sm text-zinc-500 mb-8">
                  AI agents search across job boards in parallel
                </p>
              </>
            )}
            <div className="relative flex items-center gap-3">
              <div className="relative flex-1">
                <svg
                  className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 pointer-events-none"
                  viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
                >
                  <circle cx="6.5" cy="6.5" r="4" />
                  <path d="M11 11l3 3" strokeLinecap="round" />
                </svg>
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="chief of staff, AI startup, remote…"
                  className={`w-full bg-elevated border border-border-default rounded-lg pl-11 pr-4 text-zinc-100
                             placeholder-zinc-600 transition-all focus:outline-none
                             focus:border-accent/50 focus:ring-1 focus:ring-accent/15
                             ${hasResults ? "py-2.5 text-sm" : "py-4 text-[15px]"}`}
                />
              </div>
              <button
                onClick={handleSearch}
                disabled={loading || !query.trim()}
                className={`btn-primary shrink-0 disabled:opacity-40 disabled:cursor-not-allowed
                           ${hasResults ? "h-[40px] px-4" : "h-[52px] px-6"}`}
              >
                {loading ? (
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                ) : "Search"}
              </button>
            </div>
          </div>
        </div>

        {/* Status bar */}
        {result && (
          <div className="flex-shrink-0 flex items-center gap-5 px-6 py-2.5 border-b border-border-subtle text-xs">
            <StatChip label="results" value={result.stats.afterDedup} />
            <StatChip label="raw" value={result.stats.totalFound} />
            <StatChip label="agents" value={`${result.stats.agentsSucceeded}/${result.stats.agentsQueried}`} />
            <StatChip label="time" value={`${result.stats.durationMs}ms`} />
            <StatChip label="cost" value={`$${result.stats.estimatedCostUsd.toFixed(4)}`} />
            {result.traceId && (
              <span className="ml-auto font-mono text-zinc-700 text-[10px]">{result.traceId}</span>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="m-6 px-4 py-3 rounded-lg bg-red-950/30 border border-red-900/40 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="flex-1 px-6 py-5 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-12 rounded-md bg-surface animate-pulse" style={{ opacity: 1 - i * 0.1 }} />
            ))}
          </div>
        )}

        {/* Results table */}
        {hasResults && !loading && (
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-void/98 backdrop-blur-sm z-10">
                <tr className="border-b border-border-subtle">
                  <th className="px-6 py-3 text-left text-[11px] font-medium text-zinc-600 tracking-widest uppercase">Role</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-zinc-600 tracking-widest uppercase">Company</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-zinc-600 tracking-widest uppercase hidden md:table-cell">Location</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-zinc-600 tracking-widest uppercase hidden lg:table-cell">Salary</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-zinc-600 tracking-widest uppercase">Score</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-zinc-600 tracking-widests uppercase hidden sm:table-cell">Src</th>
                </tr>
              </thead>
              <tbody>
                {result.jobs.map((job, i) => (
                  <tr
                    key={job.id}
                    onClick={() => setSelected(selected?.id === job.id ? null : job)}
                    className={`border-b border-border-subtle/40 cursor-pointer transition-colors duration-100 row-reveal ${
                      selected?.id === job.id
                        ? "bg-accent-dim border-l-2 border-l-accent"
                        : "hover:bg-elevated/50"
                    } ${i >= visibleCount ? "opacity-0" : ""}`}
                    style={{ animationDelay: `${i * 28}ms` }}
                  >
                    <td className="px-6 py-4">
                      <div className="font-medium text-zinc-100 leading-tight">{job.title}</div>
                      {job.remote && (
                        <span className="text-[10px] text-emerald-500 font-medium mt-0.5 block">Remote</span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-zinc-400">{job.company}</td>
                    <td className="px-4 py-4 text-zinc-500 hidden md:table-cell">{job.location || "—"}</td>
                    <td className="px-4 py-4 text-zinc-500 font-mono text-xs hidden lg:table-cell">{fmtSalary(job)}</td>
                    <td className="px-4 py-4"><ScoreBadge score={job.matchScore} /></td>
                    <td className="px-4 py-4 hidden sm:table-cell"><SourceBadge source={job.source} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && !result && (
          <div className="flex-1 flex items-start justify-center px-6 pt-2">
            <p className="text-zinc-600 text-sm text-center max-w-xs">
              Search across job boards. Results stream in as agents respond.
            </p>
          </div>
        )}

        {result && result.jobs.length === 0 && !loading && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-zinc-600 text-sm">No results for "{query}"</p>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <JobDetailPanel job={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
