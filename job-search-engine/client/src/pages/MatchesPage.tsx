import { useState, useEffect } from "react";
import * as api from "../api/client";
import type { JobListing } from "../types";
import JobDetailPanel from "../components/JobDetailPanel";

function fmtSalary(job: JobListing): string {
  if (!job.salary?.min) return "—";
  const min = Math.round(job.salary.min / 1000);
  const max = job.salary.max ? Math.round(job.salary.max / 1000) : null;
  return max ? `$${min}–${max}k` : `$${min}k+`;
}

function CompoundBadge({ count }: { count?: number }) {
  if (!count || count < 2) return null;
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold font-mono tracking-wider border text-violet-400 border-violet-800 bg-violet-950/30">
      ×{count}
    </span>
  );
}

function IdentityChip({ identity }: { identity?: string }) {
  if (!identity) return null;
  const map: Record<string, { label: string; color: string }> = {
    operator:            { label: "OP",  color: "text-blue-400 border-blue-800"       },
    legal:               { label: "LEG", color: "text-amber-400 border-amber-800"     },
    research:            { label: "RES", color: "text-emerald-400 border-emerald-800" },
    applied_ai_operator: { label: "AAI", color: "text-teal-400 border-teal-800"       },
  };
  const { label, color } = map[identity] ?? { label: "—", color: "text-zinc-500 border-zinc-700" };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono tracking-wider border ${color}`}>
      {label}
    </span>
  );
}

export default function MatchesPage() {
  const [jobs, setJobs] = useState<JobListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<JobListing | null>(null);

  useEffect(() => {
    setLoading(true);
    api.getMatches()
      .then((r) => setJobs(r.jobs))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load matches"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* Main column */}
      <div className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${selected ? "mr-[540px]" : ""}`}>
        {/* Header */}
        <div className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-border-subtle">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold text-zinc-100">Matches</h1>
            <span className="text-xs text-zinc-600">Step-change hire signals — roles where the company needs you more than you need them</span>
          </div>
          {!loading && !error && (
            <p className="text-[11px] text-zinc-600 mt-1">
              {jobs.length > 0
                ? `${jobs.length} job${jobs.length !== 1 ? "s" : ""} flagged across stored results · sorted by compound fit`
                : "No asymmetry-flagged jobs found yet — run searches to populate the store"}
            </p>
          )}
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex-1 px-6 py-5 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-14 rounded-md bg-surface animate-pulse" style={{ opacity: 1 - i * 0.15 }} />
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="m-6 px-4 py-3 rounded-lg bg-red-950/30 border border-red-900/40 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Results */}
        {!loading && !error && jobs.length > 0 && (
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-void/98 backdrop-blur-sm z-10">
                <tr className="border-b border-border-subtle">
                  <th className="px-6 py-3 text-left text-[11px] font-medium text-zinc-600 tracking-widest uppercase">Role</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-zinc-600 tracking-widest uppercase">Company</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-zinc-600 tracking-widest uppercase hidden md:table-cell">Location</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-zinc-600 tracking-widest uppercase hidden lg:table-cell">Salary</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-zinc-600 tracking-widest uppercase">Fit</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-zinc-600 tracking-widest uppercase">Id</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={job.id}
                    onClick={() => setSelected(selected?.id === job.id ? null : job)}
                    className={`border-b border-border-subtle/40 cursor-pointer transition-colors duration-100 ${
                      selected?.id === job.id
                        ? "bg-accent-dim border-l-2 border-l-accent"
                        : "hover:bg-elevated/50"
                    }`}
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium text-zinc-100 leading-tight">{job.title}</span>
                        <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-semibold font-mono tracking-wider border text-orange-400 border-orange-800 bg-orange-950/30">↑</span>
                        <CompoundBadge count={job.compound_fit} />
                      </div>
                      {job.remote && (
                        <span className="text-[10px] text-emerald-500 font-medium mt-0.5 block">Remote</span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-zinc-400">{job.company}</td>
                    <td className="px-4 py-4 text-zinc-500 hidden md:table-cell">{job.location || "—"}</td>
                    <td className="px-4 py-4 text-zinc-500 font-mono text-xs hidden lg:table-cell">{fmtSalary(job)}</td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-1">
                        <IdentityChip identity={job.matchedIdentity} />
                        {(job.compound_fit ?? 0) >= 2 && (
                          <CompoundBadge count={job.compound_fit} />
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-zinc-600 font-mono text-[10px]">
                      {job.matchScore ? `${Math.round(job.matchScore * 100)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && jobs.length === 0 && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-xs">
              <p className="text-zinc-500 text-sm mb-2">No asymmetry-flagged jobs yet.</p>
              <p className="text-zinc-600 text-xs">
                Run searches to populate the job store. Jobs where ≥ 2 step-change signals fire will appear here.
              </p>
            </div>
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
