import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type {
  JobListing,
  UserProfile,
  Config,
  IdentityKey,
  ResumeStructured,
  CoverLetterStructured,
} from "../types.js";
import type { ReaderFrame } from "./reader_frame.js";

type GithubSignalEntry = NonNullable<Config["github_signal"]>[number];

const NO_HALLUCINATION = `Do not invent facts. Every company name, counterparty, number, date, and achievement you reference must appear explicitly in the profile, portfolio, or prior work materials provided as context. If you cannot verify a fact against the source materials, do not include it. Prefer specificity grounded in source over impressive-sounding embellishment. If the source says "research universities," do not write "Fortune 500 counterpart." If the source gives no specific number, do not invent one.`;

function readPositioningContext(): string {
  const path = join(process.cwd(), "POSITIONING.md");
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return "";
  return content;
}

function buildGithubSignalContext(
  identity: IdentityKey | undefined,
  githubSignal?: GithubSignalEntry[]
): string {
  if (!identity || !githubSignal || githubSignal.length === 0) return "";
  const relevant = githubSignal.filter((e) => e.identity_boosts.includes(identity));
  if (relevant.length === 0) return "";
  return relevant.map((e) => `- **${e.name}**: ${e.summary}`).join("\n");
}

function buildIdentityContext(profile: UserProfile, identity?: IdentityKey): string {
  if (!identity || !profile.identities) return "";
  const cfg = profile.identities[identity];
  if (!cfg) return "";
  const lines: string[] = [];
  if (cfg.positioning_guidance) lines.push(`IDENTITY POSITIONING:\n${cfg.positioning_guidance.trim()}`);
  if (cfg.resume_emphasis)      lines.push(`RESUME EMPHASIS:\n${cfg.resume_emphasis.trim()}`);
  if (cfg.key_credentials?.length) lines.push(`KEY CREDENTIALS: ${cfg.key_credentials.join(", ")}`);
  return lines.join("\n\n");
}

function frameContext(frame?: ReaderFrame): string {
  if (!frame) return "";
  const lines = [
    `READER FRAME: ${frame.primary}${frame.secondary ? ` (secondary: ${frame.secondary})` : ""}`,
    `Likely reader: ${frame.reader_role_guess}`,
    `Reader concerns:\n${frame.reader_concerns.map((c) => `  - ${c}`).join("\n")}`,
    `Reader vocabulary (use these terms naturally): ${frame.reader_vocabulary.join(", ")}`,
    `Anti-vocabulary (do not use — signals category error): ${frame.anti_vocabulary.join(", ")}`,
    `Frame rationale: ${frame.frame_rationale}`,
  ];
  return lines.join("\n");
}

// ─── Resume ───────────────────────────────────────────────────────

const RESUME_SYSTEM = `You are generating a structured resume for Andrew Shipley, tailored to a specific role. Output ONLY valid JSON — no markdown, no fences, no commentary.

${NO_HALLUCINATION}

CANDIDATE POSTURE — NON-NEGOTIABLE:
Andrew is evaluating whether this role is worth his time, not applying for it. Write from that posture.
- Open the summary with his operating shape and the problem type he solves
- Cite shipped systems by name (first-agent, charlie, mrkt, NLSAFE, Orpheus) when relevant and verifiable from source materials
- Use declarative framing: "ships production AI systems," "deployed for named clients"
- Never use: "excited to apply," "passionate about," "results-driven"

Output this exact JSON shape:
{
  "header": {
    "name": "string",
    "email": "string",
    "phone": "string or omit",
    "location": "string or omit",
    "linkedin": "string or omit",
    "github": "string or omit",
    "website": "string or omit"
  },
  "summary": "3-4 sentence summary in evaluator register",
  "experience": [
    {
      "role": "string",
      "company": "string",
      "location": "string or omit",
      "dates": "string e.g. Jan 2022 – Present",
      "bullets": ["achievement-focused bullet", "..."]
    }
  ],
  "education": [
    {
      "degree": "string",
      "institution": "string",
      "dates": "string",
      "honors": ["string or omit array"]
    }
  ],
  "selected_projects": [
    {
      "name": "string",
      "summary": "one-sentence summary",
      "bullets": ["bullet", "..."]
    }
  ],
  "publications": [
    { "citation": "full citation string" }
  ],
  "skills": ["skill1", "skill2"]
}`;

export async function generatePackageResume(
  job: JobListing,
  profile: UserProfile,
  config: Config,
  identity: IdentityKey | undefined,
  frame?: ReaderFrame
): Promise<{ structured: ResumeStructured; html: string }> {
  const client = new Anthropic();
  const model = config.content.model ?? "claude-sonnet-4-6";

  const githubCtx = buildGithubSignalContext(identity, config.github_signal ?? []);
  const identityCtx = buildIdentityContext(profile, identity);
  const positioningCtx = readPositioningContext();
  const frameCtx = frameContext(frame);

  const systemFull = [
    RESUME_SYSTEM,
    positioningCtx ? `\nPOSITIONING CONTEXT:\n${positioningCtx.slice(0, 2000)}` : "",
    identityCtx ? `\n\n${identityCtx}` : "",
    frameCtx ? `\n\nREADER FRAME CONTEXT (tailor emphasis to this reader's concerns):\n${frameCtx}` : "",
    githubCtx ? `\n\nRelevant portfolio projects (cite authentically when role context warrants, using exact language from source):\n${githubCtx}` : "",
    profile.voice?.avoidPhrases?.length
      ? `\n\nNEVER USE: ${profile.voice.avoidPhrases.join(", ")}`
      : "",
  ].join("");

  const userMsg = `TARGET ROLE: ${job.title} at ${job.company}
LOCATION: ${job.location}
JOB DESCRIPTION:
${job.description.slice(0, 3000)}

CANDIDATE PROFILE:
Name: ${profile.name}
Email: ${profile.email ?? ""}
Phone: ${profile.phone ?? ""}
Location: ${profile.location ?? ""}
LinkedIn: ${profile.linkedin ?? ""}
GitHub: ${profile.github ?? ""}
Website: ${profile.website ?? ""}
Summary: ${profile.summary ?? ""}
Skills: ${profile.skills.join(", ")}

Experience:
${profile.experience.map((e) =>
  `${e.title} at ${e.company} (${e.startDate} – ${e.endDate ?? "Present"})\n${e.description}\nHighlights: ${e.highlights.join("; ")}`
).join("\n\n")}

Education:
${profile.education.map((e) =>
  `${e.degree}${e.field ? " in " + e.field : ""}, ${e.institution}${e.graduationDate ? " (" + e.graduationDate + ")" : ""}`
).join("\n")}

Projects:
${(profile.projects ?? []).map((p) => `${p.name}: ${p.description}`).join("\n")}`;

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    system: systemFull,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  const structured = JSON.parse(text) as ResumeStructured;
  const html = renderResumeHtml(structured);
  return { structured, html };
}

// ─── Cover Letter ─────────────────────────────────────────────────

const COVER_LETTER_SYSTEM = `You are writing a cover letter for Andrew Shipley. The reader-frame for this role has been inferred and is provided as context. Every substantive sentence in this letter must connect to one of the reader's stated concerns, stated in the reader's own vocabulary.

${NO_HALLUCINATION}

Hard rules:
1. Do not use any term from the anti_vocabulary list. Those terms signal category error for this reader-frame.
2. Do not write diagnosis paragraphs that have the rhythm of insight without naming something specific the organization actually does. Real diagnosis names a specific thing this organization does that creates the specific problem the role addresses.
3. Do not describe Andrew's posture, approach, or what would make the role worth his commitment. Answer the reader's concerns.
4. Every paragraph answers one of the reader's concerns directly, with evidence, in their vocabulary. If a paragraph does neither, cut it.

Structure:
- Opening: Name the specific concern the reader is most likely running, in their vocabulary, and state Andrew's answer to it.
- Middle paragraphs (1-2): Evidence. Specific prior work that demonstrates Andrew has produced the outcome the reader wants, under conditions comparable to theirs. Cite portfolio projects by name when directly relevant and only using language from source materials.
- Close: What the reader gets in the first ninety days if they hire him. Concrete, not aspirational.

The letter is short. Four paragraphs, not six. Readers are busy. Length without substance is worse than brevity.

Andrew's arc is in the profile and positioning materials. Use it for evidence, not for self-description. The reader does not want to read about Andrew. The reader wants to know whether Andrew produces the outcome they need.

Output ONLY valid JSON — no markdown, no fences, no commentary:
{
  "date": "Month DD, YYYY",
  "recipient": { "name": "string or omit", "title": "string or omit", "company": "string", "address": "string or omit" },
  "sender": { "name": "string", "email": "string", "location": "string or omit" },
  "salutation": "Dear [Name/Hiring Team],",
  "paragraphs": ["paragraph text", "..."],
  "closing": "Sincerely,",
  "signature": "Andrew Shipley"
}`;

export async function generatePackageCoverLetter(
  job: JobListing,
  profile: UserProfile,
  config: Config,
  identity: IdentityKey | undefined,
  frame?: ReaderFrame
): Promise<{ structured: CoverLetterStructured; html: string }> {
  const client = new Anthropic();
  const model = config.content.model ?? "claude-sonnet-4-6";

  const githubCtx = buildGithubSignalContext(identity, config.github_signal ?? []);
  const identityCtx = (() => {
    if (!identity || !profile.identities) return "";
    const cfg = profile.identities[identity];
    if (!cfg) return "";
    const lines: string[] = [];
    if (cfg.positioning_guidance) lines.push(`IDENTITY POSITIONING:\n${cfg.positioning_guidance.trim()}`);
    if (cfg.cover_letter_emphasis) lines.push(`COVER LETTER EMPHASIS:\n${cfg.cover_letter_emphasis.trim()}`);
    if (cfg.key_credentials?.length) lines.push(`KEY CREDENTIALS: ${cfg.key_credentials.join(", ")}`);
    return lines.join("\n\n");
  })();
  const positioningCtx = readPositioningContext();
  const frameCtx = frameContext(frame);

  const systemFull = [
    COVER_LETTER_SYSTEM,
    positioningCtx ? `\nPOSITIONING CONTEXT:\n${positioningCtx.slice(0, 2000)}` : "",
    identityCtx ? `\n\n${identityCtx}` : "",
    frameCtx ? `\n\nREADER FRAME — BINDING CONTEXT (write every sentence in the reader's vocabulary, answer their concerns):\n${frameCtx}` : "",
    githubCtx ? `\n\nPortfolio projects (cite by exact name only when directly relevant to reader's specific concerns):\n${githubCtx}` : "",
    profile.voice?.avoidPhrases?.length
      ? `\n\nNEVER USE: ${profile.voice.avoidPhrases.join(", ")}`
      : "",
  ].join("");

  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const userMsg = `DATE: ${today}
TARGET ROLE: ${job.title} at ${job.company}
LOCATION: ${job.location}${job.remote ? " (Remote)" : ""}
JOB DESCRIPTION:
${job.description.slice(0, 3000)}

CANDIDATE:
Name: ${profile.name}
Email: ${profile.email ?? ""}
Location: ${profile.location ?? ""}
Most recent role: ${profile.experience[0]?.title ?? ""} at ${profile.experience[0]?.company ?? ""}
Key achievements: ${profile.experience.slice(0, 2).flatMap((e) => e.highlights.slice(0, 2)).join("; ")}
Summary: ${profile.summary ?? ""}`;

  const response = await client.messages.create({
    model,
    max_tokens: 2500,
    system: systemFull,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  const structured = JSON.parse(text) as CoverLetterStructured;
  const html = renderCoverLetterHtml(structured);
  return { structured, html };
}

// ─── Outreach Email ───────────────────────────────────────────────

const EMAIL_SYSTEM = `You are writing a cold outreach email for Andrew Shipley. The reader-frame for this role has been inferred and is provided as context. The email is 4-6 sentences, direct, assumes the reader is busy.

${NO_HALLUCINATION}

Hard rules: no invented facts, no anti-vocabulary terms from the reader frame, no template-diagnosis phrases, no self-description. Every sentence answers a reader concern in the reader's vocabulary.

The email is human, not formal. It names the role, names the specific reason Andrew's profile is relevant to the reader's actual concerns (not to the posting's bullet points), offers a next step (a short call, a materials review), and signs off. No "I am excited" or "I am passionate." No "I believe my background makes me uniquely qualified."

Subject line must be specific. "Interested in your opening" is generic. "Re: [Role] — quick note" is acceptable. "Re: [Role] — [one specific thing relevant to this reader's concerns]" is better.

Output ONLY valid JSON: { "subject": "string", "body": "string" }. No markdown, no fences.`;

export async function generatePackageEmail(
  job: JobListing,
  profile: UserProfile,
  config: Config,
  identity: IdentityKey | undefined,
  frame?: ReaderFrame
): Promise<{ subject: string; body: string }> {
  const client = new Anthropic();
  const model = config.content.model ?? "claude-sonnet-4-6";

  const githubCtx = buildGithubSignalContext(identity, config.github_signal ?? []);
  const positioningCtx = readPositioningContext();
  const frameCtx = frameContext(frame);

  const systemFull = [
    EMAIL_SYSTEM,
    positioningCtx ? `\nPOSITIONING CONTEXT:\n${positioningCtx.slice(0, 1000)}` : "",
    frameCtx ? `\n\nREADER FRAME — BINDING CONTEXT:\n${frameCtx}` : "",
    githubCtx ? `\n\nRelevant portfolio projects:\n${githubCtx}` : "",
  ].join("");

  const userMsg = `FROM: ${profile.name}
ROLE: ${job.title} at ${job.company}
IDENTITY: ${identity ?? "operator"}
PROFILE SUMMARY: ${profile.summary ?? ""}
RECENT ROLE: ${profile.experience[0]?.title ?? ""} at ${profile.experience[0]?.company ?? ""}`;

  const response = await client.messages.create({
    model,
    max_tokens: 600,
    system: systemFull,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  const parsed = JSON.parse(text) as { subject: string; body: string };
  return { subject: parsed.subject, body: parsed.body };
}

// ─── HTML Renderers ───────────────────────────────────────────────

export function renderResumeHtml(s: ResumeStructured): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const contactParts = [
    s.header.email ? `<a href="mailto:${esc(s.header.email)}" class="hover:underline">${esc(s.header.email)}</a>` : "",
    s.header.phone ? esc(s.header.phone) : "",
    s.header.location ? esc(s.header.location) : "",
    s.header.linkedin ? `<a href="${esc(s.header.linkedin)}" target="_blank" rel="noopener" class="hover:underline">LinkedIn</a>` : "",
    s.header.github ? `<a href="${esc(s.header.github)}" target="_blank" rel="noopener" class="hover:underline">GitHub</a>` : "",
    s.header.website ? `<a href="${esc(s.header.website)}" target="_blank" rel="noopener" class="hover:underline">Website</a>` : "",
  ].filter(Boolean).join(" · ");

  const divider = `<div class="border-t border-gray-200 my-4"></div>`;

  const experienceHtml = s.experience.map((exp) => `
    <div class="mb-5">
      <div class="flex justify-between items-baseline">
        <span class="font-semibold text-gray-900">${esc(exp.role)}</span>
        <span class="text-sm text-gray-500 font-mono">${esc(exp.dates)}</span>
      </div>
      <div class="text-sm text-gray-600 mb-1.5">${esc(exp.company)}${exp.location ? ` · ${esc(exp.location)}` : ""}</div>
      <ul class="list-disc list-outside ml-4 space-y-0.5">
        ${exp.bullets.map((b) => `<li class="text-sm text-gray-700 leading-snug">${esc(b)}</li>`).join("")}
      </ul>
    </div>`).join("");

  const educationHtml = s.education.map((edu) => `
    <div class="mb-3">
      <div class="flex justify-between items-baseline">
        <span class="font-semibold text-gray-900">${esc(edu.degree)}</span>
        <span class="text-sm text-gray-500 font-mono">${esc(edu.dates)}</span>
      </div>
      <div class="text-sm text-gray-600">${esc(edu.institution)}</div>
      ${edu.honors?.length ? `<ul class="list-disc list-outside ml-4 mt-1">${edu.honors.map((h) => `<li class="text-sm text-gray-600">${esc(h)}</li>`).join("")}</ul>` : ""}
    </div>`).join("");

  const projectsHtml = s.selected_projects?.length ? `
    ${divider}
    <h2 class="text-xs font-bold tracking-widest uppercase text-gray-400 mb-3">Selected Projects</h2>
    ${s.selected_projects.map((p) => `
      <div class="mb-4">
        <div class="font-semibold text-gray-900">${esc(p.name)}</div>
        <div class="text-sm text-gray-600 mb-1">${esc(p.summary)}</div>
        <ul class="list-disc list-outside ml-4 space-y-0.5">
          ${p.bullets.map((b) => `<li class="text-sm text-gray-700 leading-snug">${esc(b)}</li>`).join("")}
        </ul>
      </div>`).join("")}` : "";

  const publicationsHtml = s.publications?.length ? `
    ${divider}
    <h2 class="text-xs font-bold tracking-widest uppercase text-gray-400 mb-3">Publications</h2>
    <ul class="space-y-1">
      ${s.publications.map((p) => `<li class="text-sm text-gray-700">${esc(p.citation)}</li>`).join("")}
    </ul>` : "";

  const skillsHtml = s.skills?.length ? `
    ${divider}
    <h2 class="text-xs font-bold tracking-widest uppercase text-gray-400 mb-2">Skills</h2>
    <p class="text-sm text-gray-700">${s.skills.map(esc).join(" · ")}</p>` : "";

  return `
<div class="font-sans text-gray-900 max-w-2xl mx-auto p-8 bg-white print:p-0">
  <div class="text-center mb-6">
    <h1 class="text-2xl font-bold tracking-tight text-gray-900">${esc(s.header.name)}</h1>
    <div class="text-sm text-gray-500 mt-1">${contactParts}</div>
  </div>

  ${divider}
  <h2 class="text-xs font-bold tracking-widest uppercase text-gray-400 mb-3">Summary</h2>
  <p class="text-sm text-gray-700 leading-relaxed">${esc(s.summary)}</p>

  ${divider}
  <h2 class="text-xs font-bold tracking-widest uppercase text-gray-400 mb-3">Experience</h2>
  ${experienceHtml}

  ${divider}
  <h2 class="text-xs font-bold tracking-widest uppercase text-gray-400 mb-3">Education</h2>
  ${educationHtml}
  ${projectsHtml}
  ${publicationsHtml}
  ${skillsHtml}
</div>`.trim();
}

export function renderCoverLetterHtml(s: CoverLetterStructured): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const recipientBlock = s.recipient ? `
    <div class="mb-6 text-sm text-gray-700">
      ${s.recipient.name ? `<div>${esc(s.recipient.name)}${s.recipient.title ? `, ${esc(s.recipient.title)}` : ""}</div>` : ""}
      <div>${esc(s.recipient.company)}</div>
      ${s.recipient.address ? `<div>${esc(s.recipient.address)}</div>` : ""}
    </div>` : "";

  return `
<div class="font-serif text-gray-900 max-w-2xl mx-auto p-8 bg-white print:p-0">
  <div class="flex justify-between items-start mb-8">
    <div class="text-sm text-gray-700">
      <div class="font-semibold">${esc(s.sender.name)}</div>
      <div>${esc(s.sender.email)}</div>
      ${s.sender.location ? `<div>${esc(s.sender.location)}</div>` : ""}
    </div>
    <div class="text-sm text-gray-500">${esc(s.date)}</div>
  </div>

  ${recipientBlock}

  <div class="mb-4 text-sm text-gray-900 font-medium">${esc(s.salutation)}</div>

  <div class="space-y-4">
    ${s.paragraphs.map((p) => `<p class="text-sm text-gray-800 leading-relaxed">${esc(p)}</p>`).join("")}
  </div>

  <div class="mt-8 text-sm text-gray-900">
    <div class="mb-4">${esc(s.closing)}</div>
    <div class="font-semibold">${esc(s.signature)}</div>
  </div>
</div>`.trim();
}
