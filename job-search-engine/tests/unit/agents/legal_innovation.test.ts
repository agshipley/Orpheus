import { describe, it, expect } from "vitest";
import { LegalInnovationAgent } from "../../../src/agents/legal_innovation_agent.js";
import {
  parseGreenhouseJob,
  isLegalOrComplianceRole,
  isExcludedEngineeringRole,
  type GreenhouseJob,
} from "../../../src/agents/fetch_utils.js";
import type { AgentConfig } from "../../../src/types.js";

// ─── Agent instance ───────────────────────────────────────────────

function makeAgent() {
  return new LegalInnovationAgent({
    source: "legal_innovation",
    enabled: true,
    timeoutMs: 5000,
    maxRetries: 0,
    rateLimitRpm: 10,
  } as Partial<AgentConfig>);
}

// ─── Fixtures ─────────────────────────────────────────────────────

const GH_GENERAL_COUNSEL: GreenhouseJob = {
  id: 5551234,
  title: "General Counsel",
  absolute_url: "https://boards.greenhouse.io/harvey/jobs/5551234",
  location: { name: "San Francisco, CA" },
  departments: [{ id: 5, name: "Legal" }],
  updated_at: "2024-02-20T00:00:00Z",
};

const GH_ASSOC_GC: GreenhouseJob = {
  id: 5551235,
  title: "Associate General Counsel — Privacy",
  absolute_url: "https://boards.greenhouse.io/ironclad/jobs/5551235",
  location: { name: "Remote" },
  updated_at: "2024-03-01T00:00:00Z",
};

const GH_PRODUCT_MANAGER: GreenhouseJob = {
  id: 5551236,
  title: "Product Manager",
  absolute_url: "https://boards.greenhouse.io/relativity/jobs/5551236",
  location: { name: "Chicago, IL" },
  updated_at: "2024-02-01T00:00:00Z",
};

const HTML_LEGAL_JOBS = `
<!DOCTYPE html>
<html><body>
  <a href="/jobs/position/legal-operations-manager">Legal Operations Manager</a>
  <a href="/jobs/career/compliance-counsel">Compliance Counsel</a>
  <a href="/jobs/opening/software-engineer">Software Engineer</a>
  <a href="/about">About</a>
</body></html>
`;

// ─── Tests ────────────────────────────────────────────────────────

describe("isLegalOrComplianceRole", () => {
  it("matches 'General Counsel'", () => {
    expect(isLegalOrComplianceRole("General Counsel")).toBe(true);
  });
  it("matches 'Associate General Counsel — Privacy'", () => {
    expect(isLegalOrComplianceRole("Associate General Counsel — Privacy")).toBe(true);
  });
  it("matches 'Compliance Manager'", () => {
    expect(isLegalOrComplianceRole("Compliance Manager")).toBe(true);
  });
  it("matches 'Head of Policy'", () => {
    expect(isLegalOrComplianceRole("Head of Policy")).toBe(true);
  });
  it("does NOT match 'Product Manager'", () => {
    expect(isLegalOrComplianceRole("Product Manager")).toBe(false);
  });
  it("does NOT match 'Software Engineer'", () => {
    expect(isLegalOrComplianceRole("Software Engineer")).toBe(false);
  });
});

describe("isExcludedEngineeringRole", () => {
  it("matches 'Software Engineer'", () => {
    expect(isExcludedEngineeringRole("Software Engineer")).toBe(true);
  });
  it("matches 'ML Engineer'", () => {
    expect(isExcludedEngineeringRole("ML Engineer")).toBe(true);
  });
  it("matches 'Staff Engineer'", () => {
    expect(isExcludedEngineeringRole("Staff Engineer")).toBe(true);
  });
  it("does NOT match 'Head of Operations'", () => {
    expect(isExcludedEngineeringRole("Head of Operations")).toBe(false);
  });
  it("does NOT match 'General Counsel'", () => {
    expect(isExcludedEngineeringRole("General Counsel")).toBe(false);
  });
});

describe("LegalInnovationAgent parses Greenhouse legal jobs", () => {
  it("parses General Counsel at a legal-tech company", () => {
    const job = parseGreenhouseJob(GH_GENERAL_COUNSEL, "Harvey", "legal_innovation", false);
    expect(job).not.toBeNull();
    expect(job!.title).toBe("General Counsel");
    expect(job!.source).toBe("legal_innovation");
    expect(job!.tags).toContain("Legal");
  });

  it("parses remote AGC role with correct remote flag", () => {
    const job = parseGreenhouseJob(GH_ASSOC_GC, "Ironclad", "legal_innovation", false);
    expect(job).not.toBeNull();
    expect(job!.remote).toBe(true);
    expect(job!.location).toBe("");
  });
});

describe("LegalInnovationAgent.parseScrapedJobs", () => {
  const agent = makeAgent();

  it("extracts only legal/compliance job links", () => {
    const jobs = agent.parseScrapedJobs(
      HTML_LEGAL_JOBS,
      "LawNext",
      "https://www.lawnext.com/jobs"
    );
    const titles = jobs.map((j) => j.title);
    expect(titles).toContain("Legal Operations Manager");
    expect(titles).toContain("Compliance Counsel");
    expect(titles).not.toContain("Software Engineer");
  });

  it("sets source='legal_innovation' on scraped results", () => {
    const jobs = agent.parseScrapedJobs(
      HTML_LEGAL_JOBS,
      "LawNext",
      "https://www.lawnext.com/jobs"
    );
    expect(jobs.every((j) => j.source === "legal_innovation")).toBe(true);
  });
});
