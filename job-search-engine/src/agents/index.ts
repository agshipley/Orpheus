/**
 * Agent Pool — Factory and registry for all search agents.
 */

export { BaseAgent } from "./base_agent.js";
export { LinkedInAgent } from "./linkedin_agent.js";
export { IndeedAgent } from "./indeed_agent.js";
export { GitHubAgent } from "./github_agent.js";
export { HNAgent } from "./hn_agent.js";
export { GetroAgent } from "./getro_agent.js";
export { PalletAgent } from "./pallet_agent.js";
export { WaaSAgent } from "./waas_agent.js";
export { JobicyAgent } from "./jobicy_agent.js";
export { AiFirstAgent } from "./ai_first_agent.js";
export { VcPortfolioAgent } from "./vc_portfolio_agent.js";
export { OperatorCommunitiesAgent } from "./operator_communities_agent.js";
export { FoundationsPolicyAgent } from "./foundations_policy_agent.js";
export { LegalInnovationAgent } from "./legal_innovation_agent.js";

import { BaseAgent } from "./base_agent.js";
import { LinkedInAgent } from "./linkedin_agent.js";
import { IndeedAgent } from "./indeed_agent.js";
import { GitHubAgent } from "./github_agent.js";
import { HNAgent } from "./hn_agent.js";
import { GetroAgent } from "./getro_agent.js";
import { PalletAgent } from "./pallet_agent.js";
import { WaaSAgent } from "./waas_agent.js";
import { JobicyAgent } from "./jobicy_agent.js";
import { AiFirstAgent } from "./ai_first_agent.js";
import { VcPortfolioAgent } from "./vc_portfolio_agent.js";
import { OperatorCommunitiesAgent } from "./operator_communities_agent.js";
import { FoundationsPolicyAgent } from "./foundations_policy_agent.js";
import { LegalInnovationAgent } from "./legal_innovation_agent.js";
import type { AgentSource, AgentConfig } from "../types.js";

const AGENT_REGISTRY: Record<
  AgentSource,
  new (config?: Partial<AgentConfig>) => BaseAgent
> = {
  linkedin:               LinkedInAgent,
  indeed:                 IndeedAgent,
  github:                 GitHubAgent,
  ycombinator:            HNAgent,
  getro:                  GetroAgent,
  pallet:                 PalletAgent,
  waas:                   WaaSAgent,
  // Retired: too generalist, poor signal for target identities. File kept for
  // re-enablement — add "jobicy" back to config.agents.sources to reactivate.
  jobicy:                 JobicyAgent,
  custom:                 GitHubAgent,
  // Active direct-fetch agents (no MCP required)
  ai_first:               AiFirstAgent,
  vc_portfolio:           VcPortfolioAgent,
  operator_communities:   OperatorCommunitiesAgent,
  foundations_policy:     FoundationsPolicyAgent,
  package:                GitHubAgent, // Placeholder — "package" source never enters the agent pool; source=package jobs are synthetic.
  legal_innovation:       LegalInnovationAgent,
};

/**
 * Create an agent for a given source.
 */
export function createAgent(
  source: AgentSource,
  config?: Partial<AgentConfig>
): BaseAgent {
  const AgentClass = AGENT_REGISTRY[source];
  if (!AgentClass) {
    throw new Error(`Unknown agent source: ${source}`);
  }
  return new AgentClass({ ...config, source });
}

/**
 * Create agents for all enabled sources.
 */
export function createAgentPool(
  sources: AgentSource[],
  config?: Partial<AgentConfig>
): BaseAgent[] {
  return sources.map((source) => createAgent(source, config));
}
