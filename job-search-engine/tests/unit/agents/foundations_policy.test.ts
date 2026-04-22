import { describe, it, expect } from "vitest";
import { FoundationsPolicyAgent } from "../../../src/agents/foundations_policy_agent.js";
import type { AgentConfig } from "../../../src/types.js";

// ─── Agent instance ───────────────────────────────────────────────

function makeAgent() {
  return new FoundationsPolicyAgent({
    source: "foundations_policy",
    enabled: true,
    timeoutMs: 5000,
    maxRetries: 0,
    rateLimitRpm: 10,
  } as Partial<AgentConfig>);
}

// ─── HTML fixtures ────────────────────────────────────────────────

const CAREERS_PAGE_HTML = `
<!DOCTYPE html>
<html>
<body>
  <h1>Careers at GovAI</h1>
  <ul>
    <li><a href="/jobs/position/senior-research-fellow">Senior Research Fellow</a></li>
    <li><a href="/jobs/position/program-manager">Program Manager — AI Governance</a></li>
    <li><a href="/about">About Us</a></li>
    <li><a href="/jobs/opening/research-analyst">Research Analyst</a></li>
    <li><a href="https://external.com/jobs/career/policy-lead">Policy Lead</a></li>
  </ul>
</body>
</html>
`;

const EMPTY_PAGE_HTML = `
<!DOCTYPE html>
<html><body><p>No open positions at this time.</p></body></html>
`;

const PAGE_WITH_EXTERNAL_LINKS = `
<!DOCTYPE html>
<html>
<body>
  <a href="https://apply.workable.com/openphilanthropy/j/program-officer">
    Program Officer — AI Safety
  </a>
  <a href="https://boards.greenhouse.io/rand/jobs/12345">
    Senior Policy Analyst
  </a>
  <a href="/random-page">Something else</a>
</body>
</html>
`;

// ─── Tests ────────────────────────────────────────────────────────

describe("FoundationsPolicyAgent.parseScrapedJobs", () => {
  const agent = makeAgent();

  it("extracts job links from a careers page", () => {
    const jobs = agent.parseScrapedJobs(
      CAREERS_PAGE_HTML,
      "GovAI",
      "https://www.governance.ai/opportunities"
    );
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    const titles = jobs.map((j) => j.title);
    expect(titles).toContain("Senior Research Fellow");
    expect(titles).toContain("Program Manager — AI Governance");
  });

  it("sets source='foundations_policy' on all results", () => {
    const jobs = agent.parseScrapedJobs(
      CAREERS_PAGE_HTML,
      "GovAI",
      "https://www.governance.ai/opportunities"
    );
    expect(jobs.every((j) => j.source === "foundations_policy")).toBe(true);
  });

  it("resolves relative URLs to absolute using the base URL origin", () => {
    const jobs = agent.parseScrapedJobs(
      CAREERS_PAGE_HTML,
      "GovAI",
      "https://www.governance.ai/opportunities"
    );
    jobs.forEach((j) => {
      expect(j.url).toMatch(/^https?:\/\//);
    });
  });

  it("passes through absolute external job links", () => {
    const jobs = agent.parseScrapedJobs(
      PAGE_WITH_EXTERNAL_LINKS,
      "Open Philanthropy",
      "https://www.openphilanthropy.org/careers"
    );
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const urls = jobs.map((j) => j.url);
    expect(urls.some((u) => u.includes("apply.workable.com") || u.includes("greenhouse.io"))).toBe(true);
  });

  it("returns empty array when no job links are found", () => {
    const jobs = agent.parseScrapedJobs(
      EMPTY_PAGE_HTML,
      "RAND",
      "https://www.rand.org/jobs.html"
    );
    expect(jobs).toHaveLength(0);
  });

  it("does not duplicate jobs when the same URL appears twice", () => {
    const dupHtml = `
      <html><body>
        <a href="/jobs/position/analyst">Research Analyst</a>
        <a href="/jobs/position/analyst">Research Analyst</a>
      </body></html>
    `;
    const jobs = agent.parseScrapedJobs(dupHtml, "CSET", "https://cset.georgetown.edu/careers");
    expect(jobs).toHaveLength(1);
  });
});
