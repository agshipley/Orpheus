import Anthropic from "@anthropic-ai/sdk";

export interface ExtractedJobMetadata {
  company: string;
  title: string;
  location?: string;
  remote?: boolean;
}

const FALLBACK: ExtractedJobMetadata = {
  company: "Unknown Company",
  title: "Role",
  location: undefined,
  remote: false,
};

export async function extractJobMetadata(description: string): Promise<ExtractedJobMetadata> {
  const client = new Anthropic();

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `Extract the company name, role title, location, and remote status from the following job posting. Return ONLY a JSON object with fields: company (string), title (string), location (string or null), remote (boolean). No preamble, no explanation. If a field cannot be determined, use an empty string for strings and false for remote.`,
      messages: [{ role: "user", content: description.slice(0, 3000) }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    const parsed = JSON.parse(text) as Partial<ExtractedJobMetadata>;

    return {
      company: typeof parsed.company === "string" && parsed.company.trim() ? parsed.company.trim() : FALLBACK.company,
      title:   typeof parsed.title   === "string" && parsed.title.trim()   ? parsed.title.trim()   : FALLBACK.title,
      location: typeof parsed.location === "string" && parsed.location.trim() ? parsed.location.trim() : undefined,
      remote: typeof parsed.remote === "boolean" ? parsed.remote : false,
    };
  } catch {
    console.warn("[package] extractJobMetadata failed — using fallback values");
    return FALLBACK;
  }
}
