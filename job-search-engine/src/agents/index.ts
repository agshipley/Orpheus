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

import { BaseAgent } from "./base_agent.js";
import { LinkedInAgent } from "./linkedin_agent.js";
import { IndeedAgent } from "./indeed_agent.js";
import { GitHubAgent } from "./github_agent.js";
import { HNAgent } from "./hn_agent.js";
import { GetroAgent } from "./getro_agent.js";
import { PalletAgent } from "./pallet_agent.js";
import { WaaSAgent } from "./waas_agent.js";
import { JobicyAgent } from "./jobicy_agent.js";
import type { AgentSource, AgentConfig } from "../types.js";

const AGENT_REGISTRY: Record<
  AgentSource,
  new (config?: Partial<AgentConfig>) => BaseAgent
> = {
  linkedin: LinkedInAgent,
  indeed: IndeedAgent,
  github: GitHubAgent,
  ycombinator: HNAgent,
  getro: GetroAgent,
  pallet: PalletAgent,
  waas: WaaSAgent,
  jobicy: JobicyAgent,
  custom: GitHubAgent,
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
