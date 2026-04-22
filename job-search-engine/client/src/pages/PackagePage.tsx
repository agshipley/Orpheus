import { useState, useRef } from "react";
import * as api from "../api/client";
import type { PackageResponse } from "../types";

// ─── Identity meta (shared with TonightPage) ──────────────────────

const IDENTITY_META: Record<string, { label: string; color: string; barColor: string }> = {
  operator:            { label: "OP",  color: "text-blue-400",    barColor: "bg-blue-500"    },
  legal:               { label: "LEG", color: "text-amber-400",   barColor: "bg-amber-500"   },
  research:            { label: "RES", color: "text-emerald-400", barColor: "bg-emerald-500" },
  applied_ai_operator: { label: "AAI", color: "text-teal-400",    barColor: "bg-teal-500"    },
};

const MAX_RAW = 160;

function ScoreBars({ scores }: { scores: Record<string, { score: number }> }) {
  const keys = ["operator", "legal", "research", "applied_ai_operator"] as const;
  return (
    <div className="grid grid-cols-4 gap-2 mt-3">
      {keys.map((key) => {
        const meta = IDENTITY_META[key];
        const raw = scores[key]?.score ?? 0;
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

// ─── Signal pill ──────────────────────────────────────────────────

function SignalPill({ signal }: { signal: "strong" | "moderate" | "weak" }) {
  const styles = {
    strong:   "bg-emerald-950/40 text-emerald-400 border-emerald-800",
    moderate: "bg-amber-950/40  text-amber-400  border-amber-800",
    weak:     "bg-zinc-900      text-zinc-400   border-zinc-700",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold font-mono tracking-wider border ${styles[signal]}`}>
      {signal}
    </span>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────

function PackageSkeleton() {
  return (
    <div className="space-y-6 mt-8">
      <div className="text-xs text-zinc-600 animate-pulse">Generating package · ~20s...</div>
      {["Structural Read", "Identity Scoring", "Resume", "Cover Letter", "Outreach Email"].map((label) => (
        <div key={label} className="rounded-lg border border-border-subtle bg-surface p-5 space-y-3 animate-pulse">
          <div className="h-3 w-32 rounded bg-zinc-800" />
          <div className="h-3 w-full rounded bg-zinc-800" />
          <div className="h-3 w-4/5 rounded bg-zinc-800" />
          <div className="text-[10px] text-zinc-700">{label}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Section wrapper ──────────────────────────────────────────────

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

// ─── Copy button ──────────────────────────────────────────────────

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(getText()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={handleCopy}
      className="text-[11px] text-zinc-400 hover:text-zinc-200 border border-border-subtle rounded px-2.5 py-1 transition-colors"
    >
      {copied ? "Copied ✓" : "Copy to clipboard"}
    </button>
  );
}

// ─── Download button ──────────────────────────────────────────────

function DownloadButton({ onClick, label }: { onClick: () => void; label: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setLoading(true);
    setError(null);
    try {
      await onClick();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        onClick={handleClick}
        disabled={loading}
        className="text-[11px] text-zinc-400 hover:text-zinc-200 border border-border-subtle rounded px-2.5 py-1 transition-colors disabled:opacity-40"
      >
        {loading ? "Generating..." : label}
      </button>
      {error && <span className="text-[10px] text-red-400">{error}</span>}
    </div>
  );
}

// ─── Form ─────────────────────────────────────────────────────────

interface FormState {
  description: string;
  company: string;
  title: string;
  location: string;
  remote: boolean;
}

const EMPTY_FORM: FormState = { description: "", company: "", title: "", location: "", remote: false };

// ─── Main page ────────────────────────────────────────────────────

export default function PackagePage() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PackageResponse | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  const handleGenerate = async () => {
    setError(null);
    setLoading(true);
    try {
      const r = await api.generatePackage({
        company: form.company,
        title: form.title,
        description: form.description,
        location: form.location || undefined,
        remote: form.remote || undefined,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Package generation failed");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setForm(EMPTY_FORM);
    setResult(null);
    setError(null);
    topRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const sr = result?.structural_read;
  const scoring = result?.scoring;
  const resume = result?.resume;
  const cl = result?.cover_letter;
  const email = result?.outreach_email;
  const company = result?.synthetic_job.company ?? form.company;

  return (
    <div ref={topRef} className="max-w-2xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-100">Package</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Paste a job posting. Receive a structural read, tailored resume, cover letter, and outreach email.
        </p>
      </div>

      {/* Form */}
      <div className="space-y-4 mb-6">
        <textarea
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          rows={12}
          placeholder="Paste the full job posting — title, company, description, requirements. More detail produces a better package."
          className="w-full rounded-lg border border-border-subtle bg-surface px-4 py-3 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 resize-y font-mono"
        />
        <div className="grid grid-cols-2 gap-3">
          <input
            type="text"
            value={form.company}
            onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
            placeholder="Company *"
            className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          />
          <input
            type="text"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="Role title *"
            className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          />
        </div>
        <div className="grid grid-cols-2 gap-3 items-center">
          <input
            type="text"
            value={form.location}
            onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
            placeholder="Location (optional)"
            className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          />
          <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.remote}
              onChange={(e) => setForm((f) => ({ ...f, remote: e.target.checked }))}
              className="accent-teal-500"
            />
            Remote
          </label>
        </div>

        <button
          onClick={handleGenerate}
          disabled={loading || !form.company.trim() || !form.title.trim() || form.description.length < 100}
          className="w-full rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-border-subtle text-sm font-medium text-zinc-100 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? "Generating package... (~20s)" : "Generate Package"}
        </button>

        {error && (
          <div className="px-4 py-3 rounded-lg bg-red-950/30 border border-red-900/40 text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>

      {/* Loading skeleton */}
      {loading && <PackageSkeleton />}

      {/* Results */}
      {!loading && result && (
        <div className="space-y-5">
          {/* Section 1: Structural Read */}
          <Section title="Structural Read">
            {sr && (
              <>
                <div className="flex flex-wrap gap-2 mb-4">
                  {scoring?.winning_identity && (
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono tracking-wider border ${IDENTITY_META[scoring.winning_identity]?.color ?? "text-zinc-400"} border-current/30`}>
                      {IDENTITY_META[scoring.winning_identity]?.label ?? scoring.winning_identity}
                    </span>
                  )}
                  {(scoring?.compound_fit ?? 0) >= 2 && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold font-mono tracking-wider border text-violet-400 border-violet-800 bg-violet-950/30">
                      ×{scoring!.compound_fit}
                    </span>
                  )}
                  {scoring?.asymmetry_fit === "high" && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold font-mono tracking-wider border text-orange-400 border-orange-800 bg-orange-950/30">
                      ↑ asymmetry
                    </span>
                  )}
                  <SignalPill signal={sr.should_pursue_signal} />
                </div>

                <div className="space-y-3">
                  <div>
                    <div className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">The company problem</div>
                    <p className="text-sm text-zinc-300 leading-relaxed">{sr.company_problem}</p>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">Why this identity</div>
                    <p className="text-sm text-zinc-300 leading-relaxed">{sr.identity_rationale}</p>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">The asymmetry</div>
                    <p className="text-sm text-zinc-300 leading-relaxed">{sr.asymmetry_summary}</p>
                  </div>
                </div>
                <p className="text-[11px] text-zinc-600 mt-3">{sr.signal_rationale}</p>
              </>
            )}
          </Section>

          {/* Section 2: Identity Scoring */}
          {scoring && (
            <Section title="Identity Scoring">
              <ScoreBars scores={scoring.identity_scores} />
              {scoring.github_signal_hits.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {scoring.github_signal_hits.map((hit, i) => (
                    <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono text-zinc-500 bg-zinc-900 border border-zinc-800">
                      {hit}
                    </span>
                  ))}
                </div>
              )}
            </Section>
          )}

          {/* Section 3: Resume */}
          <Section
            title="Resume"
            action={
              resume?.structured && !resume.error ? (
                <DownloadButton
                  label="Download .docx"
                  onClick={() => api.downloadResumeDocx(resume.structured, company)}
                />
              ) : undefined
            }
          >
            {resume?.error ? (
              <p className="text-sm text-red-400">{resume.error}</p>
            ) : resume?.html ? (
              <div
                className="rounded border border-border-subtle bg-white overflow-auto max-h-[600px] text-sm"
                dangerouslySetInnerHTML={{ __html: resume.html }}
              />
            ) : null}
          </Section>

          {/* Section 4: Cover Letter */}
          <Section
            title="Cover Letter"
            action={
              cl?.structured && !cl.error ? (
                <DownloadButton
                  label="Download .docx"
                  onClick={() => api.downloadCoverLetterDocx(cl.structured, company)}
                />
              ) : undefined
            }
          >
            {cl?.error ? (
              <p className="text-sm text-red-400">{cl.error}</p>
            ) : cl?.html ? (
              <div
                className="rounded border border-border-subtle bg-white overflow-auto max-h-[600px] text-sm"
                dangerouslySetInnerHTML={{ __html: cl.html }}
              />
            ) : null}
          </Section>

          {/* Section 5: Outreach Email */}
          <Section
            title="Outreach Email"
            action={
              email && !email.error ? (
                <CopyButton
                  getText={() => `Subject: ${email.subject}\n\n${email.body}`}
                />
              ) : undefined
            }
          >
            {email?.error ? (
              <p className="text-sm text-red-400">{email.error}</p>
            ) : email ? (
              <div className="space-y-3">
                <div className="px-3 py-2 rounded border border-border-subtle bg-zinc-900 text-sm text-zinc-300 font-medium">
                  {email.subject}
                </div>
                <div className="px-3 py-3 rounded border border-border-subtle bg-zinc-900 text-sm text-zinc-400 whitespace-pre-wrap leading-relaxed">
                  {email.body}
                </div>
              </div>
            ) : null}
          </Section>

          {/* Section 6: Actions */}
          <div className="flex items-center gap-3 pt-2">
            <button
              disabled
              title="Coming soon"
              className="text-sm text-zinc-600 border border-border-subtle rounded px-4 py-2 cursor-not-allowed"
            >
              Save to Tracker
            </button>
            <button
              onClick={handleReset}
              className="text-sm text-zinc-400 hover:text-zinc-200 border border-border-subtle rounded px-4 py-2 transition-colors"
            >
              Generate another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
