import { describe, it, expect } from "vitest";
import { parseGetroJob, type GetroJob } from "../../../src/agents/fetch_utils.js";

// ─── Fixtures ─────────────────────────────────────────────────────

const GETRO_CHIEF_OF_STAFF: GetroJob = {
  id: 456,
  title: "Chief of Staff",
  company: { name: "PortfolioCo", id: 12 },
  location: "New York, NY",
  remote: false,
  job_url: "https://portfolioco.com/jobs/456",
  description: "Looking for a Chief of Staff to support the CEO.",
  category: "Operations",
};

const GETRO_REMOTE_HEAD_OF_AI: GetroJob = {
  id: 789,
  title: "Head of AI",
  company_name: "StartupXYZ",
  location: "Remote",
  remote: true,
  url: "https://startupxyz.com/careers/789",
  description: "Lead AI strategy across the company.",
  categories: ["AI", "Leadership"],
};

const GETRO_ENGINEERING: GetroJob = {
  id: 999,
  title: "Software Engineer",
  company: { name: "TechCo" },
  location: "San Francisco",
  job_url: "https://techco.com/jobs/999",
  description: "Build our backend systems.",
};

const GETRO_MISSING_URL: GetroJob = {
  id: 1001,
  title: "Director of Operations",
  company: { name: "Acme" },
  location: "Chicago",
};

// ─── Tests ────────────────────────────────────────────────────────

describe("parseGetroJob", () => {
  it("parses a Getro job with company object", () => {
    const job = parseGetroJob(GETRO_CHIEF_OF_STAFF, "vc_portfolio", false);
    expect(job).not.toBeNull();
    expect(job!.title).toBe("Chief of Staff");
    expect(job!.company).toBe("PortfolioCo");
    expect(job!.source).toBe("vc_portfolio");
    expect(job!.url).toBe("https://portfolioco.com/jobs/456");
    expect(job!.remote).toBe(false);
  });

  it("parses a job with company_name string field and remote=true", () => {
    const job = parseGetroJob(GETRO_REMOTE_HEAD_OF_AI, "vc_portfolio", false);
    expect(job).not.toBeNull();
    expect(job!.company).toBe("StartupXYZ");
    expect(job!.remote).toBe(true);
    expect(job!.location).toBe("");
    expect(job!.tags).toEqual(["AI", "Leadership"]);
  });

  it("infers remote=true from location string when remote field is absent", () => {
    const remoteByLocation: GetroJob = {
      id: 111,
      title: "Program Manager",
      company: { name: "Acme" },
      location: "Remote – Worldwide",
      job_url: "https://acme.com/jobs/111",
    };
    const job = parseGetroJob(remoteByLocation, "vc_portfolio", false);
    expect(job!.remote).toBe(true);
  });

  it("excludes engineering roles when excludeEngineering=true", () => {
    const job = parseGetroJob(GETRO_ENGINEERING, "vc_portfolio", true);
    expect(job).toBeNull();
  });

  it("returns null when url is missing", () => {
    const job = parseGetroJob(GETRO_MISSING_URL, "vc_portfolio", false);
    expect(job).toBeNull();
  });
});
