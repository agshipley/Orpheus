import { describe, it, expect } from "vitest";
import { OperatorCommunitiesAgent } from "../../../src/agents/operator_communities_agent.js";
import type { AgentConfig } from "../../../src/types.js";

// ─── Agent instance ───────────────────────────────────────────────

const AGENT_CONFIG: Partial<AgentConfig> = {
  source: "operator_communities",
  enabled: true,
  timeoutMs: 5000,
  maxRetries: 0,
  rateLimitRpm: 10,
};

function makeAgent() {
  return new OperatorCommunitiesAgent(AGENT_CONFIG);
}

// ─── Fixtures ─────────────────────────────────────────────────────

const PALLET_JOB_FULL = {
  id: "plt-001",
  title: "Chief of Staff",
  company: "HighGrowthCo",
  location: "New York, NY",
  remote: false,
  url: "https://highgrowthco.com/jobs/cos",
  description: "Chief of Staff to the CEO of a Series B company.",
  created_at: "2024-03-01T00:00:00Z",
};

const PALLET_JOB_ORG_OBJECT = {
  id: "plt-002",
  position: "Head of Operations",
  organization: { name: "Operators Network" },
  location: "Remote",
  remote: true,
  apply_url: "https://operatorsnetwork.com/apply/002",
  description: "Lead operations across a distributed team.",
};

const PALLET_JOB_MINIMAL = {
  title: "Strategy Lead",
  company: "VentureBack",
  job_url: "https://ventureback.com/jobs/sl",
};

const PALLET_JOB_NO_URL = {
  id: "plt-003",
  title: "Director of Operations",
  company: "Acme",
};

// ─── Tests ────────────────────────────────────────────────────────

describe("OperatorCommunitiesAgent.parsePalletJob", () => {
  const agent = makeAgent();

  it("parses a full Pallet job listing", () => {
    const job = agent.parsePalletJob(PALLET_JOB_FULL, "Chief of Staff Network");
    expect(job).not.toBeNull();
    expect(job!.title).toBe("Chief of Staff");
    expect(job!.company).toBe("HighGrowthCo");
    expect(job!.source).toBe("operator_communities");
    expect(job!.url).toBe("https://highgrowthco.com/jobs/cos");
    expect(job!.remote).toBe(false);
  });

  it("falls back to position field and organization object", () => {
    const job = agent.parsePalletJob(PALLET_JOB_ORG_OBJECT, "Operators Guild");
    expect(job).not.toBeNull();
    expect(job!.title).toBe("Head of Operations");
    expect(job!.company).toBe("Operators Network");
    expect(job!.remote).toBe(true);
    expect(job!.location).toBe("");
    expect(job!.url).toBe("https://operatorsnetwork.com/apply/002");
  });

  it("accepts minimal job with only title + company + job_url", () => {
    const job = agent.parsePalletJob(PALLET_JOB_MINIMAL, "On Deck");
    expect(job).not.toBeNull();
    expect(job!.title).toBe("Strategy Lead");
    expect(job!.url).toBe("https://ventureback.com/jobs/sl");
  });

  it("returns null when URL is absent", () => {
    const job = agent.parsePalletJob(PALLET_JOB_NO_URL, "Chief of Staff Network");
    expect(job).toBeNull();
  });

  it("falls back to board name as company when company field is absent", () => {
    const job = agent.parsePalletJob(
      { title: "BizOps Lead", url: "https://board.com/jobs/1" },
      "Operators Guild"
    );
    expect(job).not.toBeNull();
    expect(job!.company).toBe("Operators Guild");
  });
});
