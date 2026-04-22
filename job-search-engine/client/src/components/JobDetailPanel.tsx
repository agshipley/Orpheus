import { useState } from "react";
import ReactMarkdown from "react-markdown";
import * as api from "../api/client";
import type { JobListing, ApplyResult, ContentVariant } from "../types";

type GenType = "resume" | "cover_letter" | "email";
type IdentityKey = "operator" | "legal" | "research" | "applied_ai_operator";

const GEN_BUTTONS: { type: GenType; label: string; loadingMsg: string }[] = [
  { type: "resume",       label: "Tailor Resume",      loadingMsg: "Tailoring resume…"         },
  { type: "cover_letter", label: "Write Cover Letter",  loadingMsg: "Generating variants…"     },
  { type: "email",        label: "Draft Outreach Email", loadingMsg: "Drafting email…"          },
];

// ─── Clipboard button ─────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <button onClick={copy} className="btn-ghost text-xs px-2 py-1 h-7 shrink-0" title="Copy">
      {copied
        ? <span className="text-emerald-400">Copied</span>
        : (
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="5" y="5" width="9" height="9" rx="1.5" />
            <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
          </svg>
        )
      }
    </button>
  );
}

// ─── Variant card ─────────────────────────────────────────────────

function EmailContent({ content }: { content: string }) {
  const lines = content.split("\n");
  const subjectLine = lines.find((l) => l.startsWith("Subject:"));
  const subject = subjectLine ? subjectLine.replace(/^Subject:\s*/i, "") : null;
  const body = lines.filter((l) => !l.startsWith("Subject:")).join("\n").trim();

  return (
    <div className="space-y-3">
      {subject && (
        <div>
          <span className="text-[10px] font-semibold text-zinc-600 tracking-widest uppercase">Subject</span>
          <p className="text-xs text-zinc-300 mt-1 font-medium">{subject}</p>
        </div>
      )}
      <div>
        {subject && <span className="text-[10px] font-semibold text-zinc-600 tracking-widest uppercase">Body</span>}
        <p className="text-xs text-zinc-400 leading-relaxed mt-1 whitespace-pre-wrap">{body}</p>
      </div>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={{
        h1: ({ children }) => <h1 className="text-sm font-bold text-zinc-100 mb-2 mt-1">{children}</h1>,
        h2: ({ children }) => <h2 className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wider mt-4 mb-1">{children}</h2>,
        h3: ({ children }) => <h3 className="text-xs font-semibold text-zinc-300 mt-3 mb-0.5">{children}</h3>,
        p:  ({ children }) => <p className="text-xs text-zinc-400 leading-relaxed mb-2">{children}</p>,
        ul: ({ children }) => <ul className="space-y-0.5 mb-2">{children}</ul>,
        ol: ({ children }) => <ol className="space-y-0.5 mb-2 list-decimal list-inside">{children}</ol>,
        li: ({ children }) => <li className="text-xs text-zinc-400 flex gap-1.5"><span className="text-zinc-600 shrink-0">·</span><span>{children}</span></li>,
        strong: ({ children }) => <strong className="text-zinc-300 font-semibold">{children}</strong>,
        em: ({ children }) => <em className="text-zinc-500 italic">{children}</em>,
        hr: () => <hr className="border-border-subtle my-3" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function VariantCard({
  variant,
  genType,
  defaultExpanded,
}: {
  variant: ContentVariant;
  genType: GenType;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const pct = Math.round(variant.confidence * 100);
  const color = pct >= 80 ? "text-emerald-400" : pct >= 60 ? "text-amber-400" : "text-zinc-500";

  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 bg-elevated cursor-pointer hover:bg-border-subtle transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-xs font-medium text-zinc-300 flex-1 truncate">{variant.strategy}</span>
        <span className={`text-xs font-mono shrink-0 ${color}`}>{pct}%</span>
        <svg
          className={`w-3.5 h-3.5 text-zinc-600 transition-transform shrink-0 ${expanded ? "rotate-180" : ""}`}
          viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <CopyButton text={variant.content} />
      </div>
      {expanded && (
        <div className="px-3 py-3 bg-surface">
          {genType === "email"
            ? <EmailContent content={variant.content} />
            : <MarkdownContent content={variant.content} />
          }
        </div>
      )}
    </div>
  );
}

// ─── Match Analysis ───────────────────────────────────────────────

const IDENTITY_META: Record<IdentityKey, { label: string; color: string; badge: string }> = {
  operator:            { label: "Operator",     color: "text-blue-400",    badge: "OP"  },
  legal:               { label: "Legal",        color: "text-amber-400",   badge: "LEG" },
  research:            { label: "Research",     color: "text-emerald-400", badge: "RES" },
  applied_ai_operator: { label: "Applied AI",   color: "text-teal-400",    badge: "AAI" },
};

function MatchAnalysis({ job }: { job: JobListing }) {
  const [expanded, setExpanded] = useState<IdentityKey | null>(null);
  if (!job.matchedIdentity || !job.identityReasons) return null;

  const winning = job.matchedIdentity;
  const others = (["operator", "legal", "research", "applied_ai_operator"] as IdentityKey[]).filter((k) => k !== winning);

  return (
    <section>
      <h3 className="text-[10px] font-semibold text-zinc-600 tracking-widests uppercase mb-2">Match Analysis</h3>
      <div className="space-y-2">
        {/* Winning identity */}
        <div className="rounded-lg bg-elevated border border-border-subtle px-3 py-2.5">
          <div className="flex items-center gap-2 mb-1.5">
            <span className={`text-[10px] font-semibold font-mono ${IDENTITY_META[winning].color}`}>
              {IDENTITY_META[winning].badge}
            </span>
            <span className={`text-xs font-medium ${IDENTITY_META[winning].color}`}>
              {IDENTITY_META[winning].label}
            </span>
            <span className="text-[10px] text-zinc-600 ml-auto">winning identity</span>
          </div>
          <ul className="space-y-0.5">
            {(job.identityReasons[winning] ?? []).map((r, i) => (
              <li key={i} className="text-[11px] text-zinc-400 flex gap-1.5">
                <span className="text-zinc-600 shrink-0">·</span>{r}
              </li>
            ))}
          </ul>
        </div>

        {/* Other identities — collapsed by default */}
        {others.map((key) => {
          const reasons = job.identityReasons?.[key] ?? [];
          if (reasons.length === 0) return null;
          const isOpen = expanded === key;
          return (
            <div key={key} className="rounded-lg border border-border-subtle overflow-hidden">
              <button
                className="w-full flex items-center gap-2 px-3 py-2 bg-elevated hover:bg-border-subtle transition-colors text-left"
                onClick={() => setExpanded(isOpen ? null : key)}
              >
                <span className={`text-[10px] font-semibold font-mono ${IDENTITY_META[key].color}`}>
                  {IDENTITY_META[key].badge}
                </span>
                <span className="text-xs text-zinc-500 flex-1">{IDENTITY_META[key].label}</span>
                <svg className={`w-3.5 h-3.5 text-zinc-600 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {isOpen && (
                <div className="px-3 py-2.5 bg-surface">
                  <ul className="space-y-0.5">
                    {reasons.map((r, i) => (
                      <li key={i} className="text-[11px] text-zinc-400 flex gap-1.5">
                        <span className="text-zinc-600 shrink-0">·</span>{r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}

        {/* Compound fit */}
        {(job.compound_fit ?? 0) >= 2 && (
          <div className="rounded-lg border border-violet-800/50 bg-violet-950/20 px-3 py-2">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] font-semibold font-mono text-violet-400">×{job.compound_fit}</span>
              <span className="text-xs text-violet-400 font-medium">Why this role spans multiple sides of your profile</span>
            </div>
            <p className="text-[11px] text-zinc-500">
              {job.compound_fit} of 4 identities score ≥ 40 on this role — compound fit bonus applied.
            </p>
          </div>
        )}

        {/* Asymmetry flag */}
        {job.asymmetry_fit === "high" && (
          <div className="rounded-lg border border-orange-800/50 bg-orange-950/20 px-3 py-2">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] font-semibold font-mono text-orange-400">↑</span>
              <span className="text-xs text-orange-400 font-medium">Step-change hire signal</span>
            </div>
            <p className="text-[11px] text-zinc-500">
              Multiple asymmetry signals fired — the company likely needs you more than you need them.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Salary helper ────────────────────────────────────────────────

function fmtSalary(job: JobListing): string {
  if (!job.salary) return "";
  const fmt = (n?: number) => (n ? `$${Math.round(n / 1000)}k` : null);
  const lo = fmt(job.salary.min);
  const hi = fmt(job.salary.max);
  if (lo && hi) return `${lo}–${hi}`;
  return lo ?? hi ?? "";
}

function fmtDate(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

// ─── Panel ────────────────────────────────────────────────────────

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
  const [selectedIdentity, setSelectedIdentity] = useState<IdentityKey | undefined>(
    job.matchedIdentity as IdentityKey | undefined
  );

  const generate = async (type: GenType) => {
    if (generating) return;
    setGenerating(type);
    setErrors((e) => ({ ...e, [type]: undefined }));
    try {
      const res = await api.apply(job.id, [type], { identity: selectedIdentity });
      setResults((r) => ({ ...r, ...res }));

      // Persist each variant to the backend
      const contentKey = type === "cover_letter" ? "coverLetter" : type;
      const generated = res[contentKey as keyof typeof res] as { variants: ContentVariant[] } | undefined;
      if (generated?.variants) {
        for (const v of generated.variants) {
          api.saveGeneratedContent({
            jobId: job.id,
            type,
            strategy: v.strategy,
            content: v.content,
            confidence: v.confidence,
          }).catch(() => {/* non-fatal */});
        }
      }
    } catch (e) {
      setErrors((err) => ({
        ...err,
        [type]: e instanceof Error ? e.message : "Generation failed",
      }));
    } finally {
      setGenerating(null);
    }
  };

  const salary = fmtSalary(job);
  const postedDate = fmtDate(job.postedAt);

  return (
    <div className="fixed right-0 top-12 bottom-0 w-[540px] bg-surface border-l border-border-default flex flex-col z-30 animate-slide-in-right">
      {/* Header */}
      <div className="flex-shrink-0 px-5 pt-5 pb-4 border-b border-border-subtle">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-zinc-100 leading-tight">{job.title}</h2>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-sm text-zinc-400">{job.company}</span>
              {job.location && <><span className="text-zinc-600 text-xs">·</span><span className="text-xs text-zinc-500">{job.location}</span></>}
              {job.remote && <span className="text-[10px] text-emerald-500 font-medium bg-emerald-950/40 px-1.5 py-0.5 rounded">Remote</span>}
              {salary && <span className="text-[10px] text-zinc-500 font-mono">{salary}</span>}
              {postedDate && <span className="text-[10px] text-zinc-600">{postedDate}</span>}
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost w-7 h-7 p-0 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Match score */}
        {job.matchScore !== undefined && (
          <div className="mt-3 flex items-center gap-2">
            <div className="flex-1 h-1 bg-elevated rounded-full overflow-hidden">
              <div className="h-full bg-accent rounded-full" style={{ width: `${Math.round(job.matchScore * 100)}%` }} />
            </div>
            <span className="text-xs font-mono text-zinc-400">{Math.round(job.matchScore * 100)}% match</span>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          {job.matchedIdentity && (
            <select
              value={selectedIdentity ?? ""}
              onChange={(e) => setSelectedIdentity(e.target.value as IdentityKey || undefined)}
              className="bg-elevated border border-border-default text-zinc-400 text-xs rounded-md px-2 h-7 focus:outline-none focus:border-accent/50"
              title="Generate as identity"
            >
              <option value="operator">Generate as: Operator</option>
              <option value="legal">Generate as: Legal</option>
              <option value="research">Generate as: Research</option>
              <option value="applied_ai_operator">Generate as: Applied AI</option>
            </select>
          )}
          {GEN_BUTTONS.map(({ type, label, loadingMsg }) => (
            <button
              key={type}
              onClick={() => generate(type)}
              disabled={generating !== null}
              className="btn-outline text-xs h-7 px-2.5 disabled:opacity-40"
            >
              {generating === type
                ? <><svg className="animate-spin w-3 h-3 mr-1" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>{loadingMsg}</>
                : label
              }
            </button>
          ))}
          {job.url && (
            <a href={job.url} target="_blank" rel="noopener noreferrer" className="btn-ghost text-xs h-7 px-2.5 ml-auto">
              View posting ↗
            </a>
          )}
        </div>

        {/* Inline generation errors — shown here so they're visible without scrolling */}
        {Object.entries(errors).some(([, v]) => v) && (
          <div className="mt-3 space-y-1.5">
            {(["resume", "cover_letter", "email"] as GenType[]).map((type) =>
              errors[type] ? (
                <div key={type} className="flex items-center gap-2 text-xs text-red-400 px-3 py-2 bg-red-950/30 rounded-md">
                  <span className="flex-1 min-w-0 truncate">{errors[type]}</span>
                  <button onClick={() => generate(type)} className="text-red-400 underline shrink-0">Retry</button>
                </div>
              ) : null
            )}
          </div>
        )}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* Match Analysis */}
        <MatchAnalysis job={job} />

        {/* Match reasoning */}
        {job.matchReasoning && (
          <section>
            <h3 className="text-[10px] font-semibold text-zinc-600 tracking-widest uppercase mb-2">Match Reasoning</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">{job.matchReasoning}</p>
          </section>
        )}

        {/* Tags */}
        {job.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {job.tags.map((t) => <span key={t} className="tag">{t}</span>)}
          </div>
        )}

        {/* Description */}
        <section>
          <h3 className="text-[10px] font-semibold text-zinc-600 tracking-widests uppercase mb-2">Description</h3>
          <div className="text-xs text-zinc-400 leading-relaxed space-y-2">
            {job.description.split(/\n{2,}/).map((para, i) => (
              <p key={i}>{para.trim()}</p>
            ))}
          </div>
        </section>

        {/* Requirements */}
        {job.requirements.length > 0 && (
          <section>
            <h3 className="text-[10px] font-semibold text-zinc-600 tracking-widests uppercase mb-2">Requirements</h3>
            <ul className="space-y-1">
              {job.requirements.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-zinc-400">
                  <span className="text-zinc-600 mt-0.5">·</span>{r}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Generated content */}
        {(["resume", "cover_letter", "email"] as GenType[]).map((type) => {
          const key = type === "cover_letter" ? "coverLetter" : type;
          const content = results[key as keyof ApplyResult] as { variants: ContentVariant[] } | undefined;
          const label = type === "cover_letter" ? "Cover Letter" : type === "resume" ? "Resume" : "Outreach Email";
          if (!content) return null;
          return (
            <section key={type}>
              <h3 className="text-[10px] font-semibold text-zinc-600 tracking-widests uppercase mb-2">
                Generated {label}
              </h3>
              {content && (
                <div className="space-y-2">
                  {content.variants.map((v, i) => (
                    <VariantCard key={v.strategy + i} variant={v} genType={type} defaultExpanded={i === 0} />
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
