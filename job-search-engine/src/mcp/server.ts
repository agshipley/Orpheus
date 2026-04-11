/**
 * MCP Server — Orpheus MCP server implementation.
 *
 * This module implements MCP servers for each job board source.
 * Each server exposes standardized tools (search_jobs, get_job_detail,
 * check_salary, submit_application) with source-specific implementations.
 *
 * The server also exposes MCP resources (user profile, search preferences)
 * and prompt templates for common workflows.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getTracer, getMetrics } from "../observability/index.js";
import type { AgentSource } from "../types.js";

// ─── Tool Schemas ─────────────────────────────────────────────────

const SearchJobsInputSchema = z.object({
  keywords: z.string().describe("Search keywords or job title"),
  location: z.string().optional().describe("Location filter"),
  remoteFilter: z
    .enum(["remote", "hybrid", "onsite", "any"])
    .optional()
    .describe("Remote work preference"),
  experienceLevel: z.string().optional().describe("Experience level filter"),
  salary: z.number().optional().describe("Minimum salary"),
  limit: z.number().default(25).describe("Max results to return"),
  fromage: z.number().optional().describe("Days since posting"),
});

const GetJobDetailInputSchema = z.object({
  jobId: z.string().describe("Source-specific job identifier"),
});

const CheckSalaryInputSchema = z.object({
  jobId: z.string().describe("Job to estimate salary for"),
  location: z.string().optional().describe("Location for cost-of-living adjustment"),
});

const SubmitApplicationInputSchema = z.object({
  jobId: z.string().describe("Job to apply for"),
  resumeText: z.string().describe("Tailored resume content"),
  coverLetterText: z.string().optional().describe("Cover letter content"),
  additionalInfo: z.record(z.string()).optional().describe("Extra fields"),
});

// ─── Server Factory ───────────────────────────────────────────────

export interface JobBoardAdapter {
  source: AgentSource;
  searchJobs: (params: z.infer<typeof SearchJobsInputSchema>) => Promise<unknown>;
  getJobDetail: (params: z.infer<typeof GetJobDetailInputSchema>) => Promise<unknown>;
  checkSalary: (params: z.infer<typeof CheckSalaryInputSchema>) => Promise<unknown>;
  submitApplication: (params: z.infer<typeof SubmitApplicationInputSchema>) => Promise<unknown>;
}

/**
 * Create an MCP server for a job board source.
 *
 * Each server exposes the same tool interface, but the adapter
 * provides source-specific implementations.
 */
export function createJobBoardServer(adapter: JobBoardAdapter): McpServer {
  const tracer = getTracer();
  const metrics = getMetrics();

  const server = new McpServer({
    name: `orpheus-${adapter.source}`,
    version: "0.1.0",
  });

  // ─── Tools ────────────────────────────────────────────────────

  server.tool(
    "search_jobs",
    "Search for job listings matching the given criteria",
    SearchJobsInputSchema.shape,
    async (params) => {
      const span = tracer.startTrace(`mcp.${adapter.source}.search_jobs`);
      span.setAttribute("source", adapter.source);

      try {
        const result = await adapter.searchJobs(params);
        metrics.increment("orpheus_tool_calls_total", {
          source: adapter.source,
          tool: "search_jobs",
        });
        span.end();

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        span.setError(error instanceof Error ? error.message : String(error));
        span.end();
        throw error;
      }
    }
  );

  server.tool(
    "get_job_detail",
    "Get full details for a specific job listing",
    GetJobDetailInputSchema.shape,
    async (params) => {
      const result = await adapter.getJobDetail(params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  server.tool(
    "check_salary",
    "Estimate salary range for a job position",
    CheckSalaryInputSchema.shape,
    async (params) => {
      const result = await adapter.checkSalary(params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  server.tool(
    "submit_application",
    "Submit application materials for a job",
    SubmitApplicationInputSchema.shape,
    async (params) => {
      const result = await adapter.submitApplication(params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    }
  );

  // ─── Resources ────────────────────────────────────────────────

  server.resource(
    "profile://user",
    "profile://user",
    async () => ({
      contents: [
        {
          uri: "profile://user",
          mimeType: "application/json",
          text: JSON.stringify({
            note: "User profile loaded from config",
            // In production, this would read from the config/database
          }),
        },
      ],
    })
  );

  server.resource(
    "preferences://search",
    "preferences://search",
    async () => ({
      contents: [
        {
          uri: "preferences://search",
          mimeType: "application/json",
          text: JSON.stringify({
            note: "Search preferences loaded from config",
          }),
        },
      ],
    })
  );

  // ─── Prompts ──────────────────────────────────────────────────

  server.prompt(
    "analyze_job",
    "Analyze a job listing against the user's profile",
    {
      job_description: z.string().describe("The full job description text"),
      user_skills: z.string().describe("Comma-separated list of user skills"),
    },
    async ({ job_description, user_skills }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Analyze this job listing against my skills and provide a match score (0-1) with reasoning.

Job Description:
${job_description}

My Skills:
${user_skills}

Respond with JSON: { "matchScore": number, "reasoning": string, "missingSkills": string[], "strongMatches": string[] }`,
          },
        },
      ],
    })
  );

  return server;
}
