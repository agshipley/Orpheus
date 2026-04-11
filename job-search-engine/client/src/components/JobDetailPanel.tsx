import { useState } from "react";
import * as api from "../api/client";
import type { JobListing, ApplyResult, ContentVariant } from "../types";

type GenType = "resume" | "cover_letter" | "email";

const GEN_BUTTONS: { type: GenType; label: string }[] = [
  { type: "resume",       label: "Resume"       },
  { type: "cover_letter", label: "Cover Letter" },
  { type: "email",        label: "Email"        },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <button
      onClick={copy}
      className="btn-ghost text-xs px-2 py-1 h-7 shrink-0"
      title="Copy to clipboard"
    >
      {copied ? (
        <span className="text-emerald-400">Copied</span>
      ) : (
        <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="5" y="5" width="9" height="9" rx="1.5" />
          <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
        </svg>
      )}
    </button>
  );
}

function VariantCard({ variant }: { variant: ContentVariant }) {
  const [expanded, setExpanded] = useState(true);
  const pct = Math.round(variant.confidence * 100);
  const color = pct >= 80 ? "text-emerald-400" : pct >= 60 ? "text-amber-400" : "text-zinc-500";

  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 bg-elevated cursor-pointer hover:bg-border-subtle transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-xs font-medium text-zinc-300 flex-1">{variant.strategy}</span>
        <span className={`text-xs font-mono ${color}`}>{pct}%</span>
        <svg
          className={`w-3.5 h-3.5 text-zinc-600 transition-transform ${expanded ? "rotate-180" : ""}`}
          viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <CopyButton text={variant.content} />
      </div>
      {expanded && (
        <div className="px-3 py-3 bg-surface">
          <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-sans leading-relaxed">
            {variant.content}
          </pre>
        </div>
      )}
    </div>
  );
}

function SalaryStr(job: JobListing): string {
  if (!job.salary) return "";
  const fmt = (n?: number) => n ? `$${Math.round(n / 1000)}k` : null;
  const lo = fmt(job.salary.min);
  const hi = fmt(job.salary.max);
  if (lo && hi) return `${lo}–${hi}`;
  return lo ?? hi ?? "";
}

export default function JobDetailPanel({
  job,
  onClose,
}: {
  job: JobListing;
  onClose: () => void;
}) {
  const [generating, setGenerating] = useState<GenType | null>(null);
  const [results, setResults] = useState<Partial<ApplyResult>>({});
  const [errors, setErrors] = useState<Partial<Record<GenType, string>>>({});

  const generate = async (type: GenType) => {
    if (generating) return;
    setGenerating(type);
    setErrors((e) => ({ ...e, [type]: undefined }));
    try {
      const res = await api.apply(job.id, [type]);
      setResults((r) => ({ ...r, ...res }));
    } catch (e) {
      setErrors((err) => ({
        ...err,
        [type]: e instanceof Error ? e.message : "Generation failed",
      }));
    } finally {
      setGenerating(null);
    }
  };

  const salary = SalaryStr(job);

  return (
    <div className="fixed right-0 top-12 bottom-0 w-[520px] bg-surface border-l border-border-default flex flex-col z-30 animate-slide-in-right">
      {/* Header */}
      <div className="flex-shrink-0 px-5 pt-5 pb-4 border-b border-border-subtle">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-zinc-100 leading-tight">{job.title}</h2>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-sm text-zinc-400">{job.company}</span>
              {job.location && <span className="text-zinc-600 text-xs">·</span>}
              {job.location && <span className="text-xs text-zinc-500">{job.location}</span>}
              {job.remote && <span className="text-[10px] text-emerald-500 font-medium bg-emerald-950/40 px-1.5 py-0.5 rounded">Remote</span>}
              {salary && <span className="text-[10px] text-zinc-500 font-mono">{salary}</span>}
            </div>
          </div>
          <button
            onClick={onClose}
            className="btn-ghost w-7 h-7 p-0 flex items-center justify-center shrink-0"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Match score */}
        {job.matchScore !== undefined && (
          <div className="mt-3 flex items-center gap-2">
            <div className="flex-1 h-1 bg-elevated rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full"
                style={{ width: `${Math.round(job.matchScore * 100)}%` }}
              />
            </div>
            <span className="text-xs font-mono text-zinc-400">
              {Math.round(job.matchScore * 100)}% match
            </span>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 mt-4">
          {GEN_BUTTONS.map(({ type, label }) => (
            <button
              key={type}
              onClick={() => generate(type)}
              disabled={generating !== null}
              className="btn-outline text-xs h-7 px-2.5 disabled:opacity-40"
            >
              {generating === type ? (
                <svg className="animate-spin w-3 h-3 mr-1" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
              ) : (
                <svg className="w-3 h-3 mr-1" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M8 2v12M2 8h12" strokeLinecap="round" />
                </svg>
              )}
              {label}
            </button>
          ))}
          {job.url && (
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost text-xs h-7 px-2.5 ml-auto"
            >
              View posting ↗
            </a>
          )}
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* Match reasoning */}
        {job.matchReasoning && (
          <section>
            <h3 className="text-[10px] font-semibold text-zinc-600 tracking-widest uppercase mb-2">
              Match Reasoning
            </h3>
            <p className="text-xs text-zinc-400 leading-relaxed">{job.matchReasoning}</p>
          </section>
        )}

        {/* Tags */}
        {job.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {job.tags.map((t) => (
              <span key={t} className="tag">{t}</span>
            ))}
          </div>
        )}

        {/* Description */}
        <section>
          <h3 className="text-[10px] font-semibold text-zinc-600 tracking-widest uppercase mb-2">
            Description
          </h3>
          <div className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">
            {job.description}
          </div>
        </section>

        {/* Requirements */}
        {job.requirements.length > 0 && (
          <section>
            <h3 className="text-[10px] font-semibold text-zinc-600 tracking-widest uppercase mb-2">
              Requirements
            </h3>
            <ul className="space-y-1">
              {job.requirements.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-zinc-400">
                  <span className="text-zinc-600 mt-0.5">·</span>
                  {r}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Generated content sections */}
        {(["resume", "cover_letter", "email"] as GenType[]).map((type) => {
          const key = type === "cover_letter" ? "coverLetter" : type;
          const content = results[key as keyof ApplyResult] as
            | { variants: ContentVariant[] }
            | undefined;
          const err = errors[type];
          const label = type === "cover_letter" ? "Cover Letter" : type === "resume" ? "Resume" : "Email";

          if (!content && !err) return null;
          return (
            <section key={type}>
              <h3 className="text-[10px] font-semibold text-zinc-600 tracking-widest uppercase mb-2">
                Generated {label}
              </h3>
              {err && (
                <p className="text-xs text-red-400 px-3 py-2 bg-red-950/30 rounded-md">{err}</p>
              )}
              {content && (
                <div className="space-y-2">
                  {content.variants.map((v, i) => (
                    <VariantCard key={i} variant={v} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
