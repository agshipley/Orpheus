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
  if (score === undefined) return <span className="text-zinc-600">—</span>;
  const pct = Math.round(score * 100);
  const color =
    pct >= 80 ? "text-emerald-400" :
    pct >= 60 ? "text-amber-400"  :
               "text-zinc-500";
  const barW = `${pct}%`;
  return (
    <span className={`flex items-center gap-1.5 font-mono text-xs ${color}`}>
      <span className="w-14 h-1 rounded-full bg-elevated overflow-hidden">
        <span className="block h-full rounded-full bg-current" style={{ width: barW }} />
      </span>
      {pct}%
    </span>
  );
}

function SourceBadge({ source }: { source: string }) {
  const map: Record<string, string> = {
    ycombinator: "YC",
    linkedin: "LI",
    indeed: "IN",
    github: "GH",
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
    <span className="flex items-center gap-1 text-xs text-zinc-500">
      <span className="text-zinc-600">{label}</span>
      <span className="text-zinc-300 font-medium">{value}</span>
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

  // Focus search on mount
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Stagger-reveal rows after results arrive
  useEffect(() => {
    if (!result) return;
    setVisibleCount(0);
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    result.jobs.forEach((_, i) => {
      timeouts.push(setTimeout(() => setVisibleCount(i + 1), i * 40));
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
    if (e.key === "Escape") { setSelected(null); }
  };

  const hasResults = result && result.jobs.length > 0;

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* Main column */}
      <div className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${selected ? "mr-[520px]" : ""}`}>

        {/* Search header */}
        <div className={`flex-shrink-0 px-6 transition-all duration-500 ${hasResults ? "pt-6 pb-4" : "pt-32 pb-8"}`}>
          <div className={`mx-auto transition-all duration-500 ${hasResults ? "max-w-none" : "max-w-xl text-center"}`}>
            {!hasResults && !loading && !error && (
              <h1 className="text-2xl font-semibold text-zinc-200 mb-6 tracking-tight">
                Find your next role
              </h1>
            )}
            <div className="relative flex items-center gap-2">
              <div className="relative flex-1">
                <svg
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 pointer-events-none"
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
                  className="w-full input pl-9 pr-4 py-2.5 text-sm bg-elevated border border-border-default
                             focus:border-accent/70 focus:ring-1 focus:ring-accent/20 transition-all"
                />
              </div>
              <button
                onClick={handleSearch}
                disabled={loading || !query.trim()}
                className="btn-primary h-[38px] px-4 disabled:opacity-40 disabled:cursor-not-allowed"
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
          <div className="flex-shrink-0 flex items-center gap-4 px-6 py-2 border-b border-border-subtle text-xs">
            <StatChip label="found" value={result.stats.afterDedup} />
            <StatChip label="raw" value={result.stats.totalFound} />
            <StatChip label="agents" value={`${result.stats.agentsSucceeded}/${result.stats.agentsQueried}`} />
            <StatChip label="time" value={`${result.stats.durationMs}ms`} />
            <StatChip label="cost" value={`$${result.stats.estimatedCostUsd.toFixed(4)}`} />
            {result.traceId && (
              <span className="ml-auto font-mono text-zinc-600 text-[10px]">{result.traceId}</span>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="m-6 px-4 py-3 rounded-lg bg-red-950/40 border border-red-900/60 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="flex-1 px-6 py-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-11 rounded-md bg-surface animate-pulse" style={{ opacity: 1 - i * 0.1 }} />
            ))}
          </div>
        )}

        {/* Results table */}
        {hasResults && !loading && (
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-void/95 backdrop-blur-sm z-10">
                <tr className="text-left border-b border-border-subtle">
                  <th className="px-6 py-2.5 text-xs font-medium text-zinc-600 tracking-widest uppercase">Role</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-zinc-600 tracking-widest uppercase">Company</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-zinc-600 tracking-widest uppercase hidden md:table-cell">Location</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-zinc-600 tracking-widest uppercase hidden lg:table-cell">Salary</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-zinc-600 tracking-widest uppercase">Score</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-zinc-600 tracking-widest uppercase hidden sm:table-cell">Source</th>
                </tr>
              </thead>
              <tbody>
                {result.jobs.map((job, i) => (
                  <tr
                    key={job.id}
                    onClick={() => setSelected(selected?.id === job.id ? null : job)}
                    className={`border-b border-border-subtle/50 cursor-pointer transition-colors duration-100 row-reveal ${
                      selected?.id === job.id
                        ? "bg-accent-dim border-l-2 border-l-accent"
                        : "hover:bg-elevated/60"
                    } ${i >= visibleCount ? "opacity-0" : ""}`}
                    style={{ animationDelay: `${i * 30}ms` }}
                  >
                    <td className="px-6 py-3">
                      <div className="font-medium text-zinc-200 leading-tight">{job.title}</div>
                      {job.remote && (
                        <span className="text-[10px] text-emerald-500 font-medium">Remote</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-400">{job.company}</td>
                    <td className="px-4 py-3 text-zinc-500 hidden md:table-cell">{job.location || "—"}</td>
                    <td className="px-4 py-3 text-zinc-400 font-mono text-xs hidden lg:table-cell">{fmtSalary(job)}</td>
                    <td className="px-4 py-3"><ScoreBadge score={job.matchScore} /></td>
                    <td className="px-4 py-3 hidden sm:table-cell"><SourceBadge source={job.source} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && !result && (
          <div className="flex-1 flex items-start justify-center px-6 pt-4">
            <p className="text-zinc-600 text-sm text-center max-w-xs">
              Search across job boards. Results stream in as agents respond.
            </p>
          </div>
        )}

        {result && result.jobs.length === 0 && !loading && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-zinc-600 text-sm">No results found for "{query}"</p>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <JobDetailPanel
          job={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
