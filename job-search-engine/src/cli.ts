#!/usr/bin/env node

/**
 * Orpheus CLI — Command-line interface for the job search engine.
 *
 * Commands:
 *   search <query>     Search for jobs across all sources
 *   apply <job-id>     Generate application materials for a job
 *   dashboard          View the observability dashboard
 *   stats              Show search statistics
 *   config             Show/edit configuration
 */

import React from "react";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import Table from "cli-table3";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { parse as parseYaml } from "yaml";
import { render } from "ink";
import { Conductor } from "./conductor/conductor.js";
import { ResumeTailor, CoverLetterGenerator, EmailDrafter } from "./content/index.js";
import { getTracer, getMetrics, getDecisionLog } from "./observability/index.js";
import { JobStore } from "./storage/job_store.js";
import { ConfigSchema } from "./types.js";
import type { Config, JobListing } from "./types.js";
import { Dashboard } from "./ui/dashboard.js";
import type { DashboardState } from "./ui/dashboard.js";

const DASHBOARD_STATE_FILE = "./data/dashboard-state.json";

// ─── .env Loading ────────────────────────────────────────────────

if (existsSync(".env")) {
  const envLines = readFileSync(".env", "utf-8").split("\n");
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

// ─── Config Loading ───────────────────────────────────────────────

function loadConfig(): Config {
  const configPaths = [
    "./orpheus.config.yaml",
    "./orpheus.config.yml",
    "./config.yaml",
  ];

  for (const path of configPaths) {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      const parsed = parseYaml(raw);
      return ConfigSchema.parse(parsed);
    }
  }

  // Return defaults if no config file found
  return ConfigSchema.parse({
    profile: {
      name: process.env.USER ?? "User",
      skills: [],
      preferences: {},
    },
    agents: {},
    observability: {},
    content: {},
    storage: {},
  });
}

// ─── CLI Setup ────────────────────────────────────────────────────

const program = new Command();

program
  .name("orpheus")
  .description("AI-powered job search engine with MCP architecture")
  .version("0.1.0");

// ─── Search Command ───────────────────────────────────────────────

program
  .command("search")
  .description("Search for jobs across all configured sources")
  .argument("<query>", "Natural language search query")
  .option("-n, --limit <number>", "Max results to display", "20")
  .option("-s, --source <source>", "Filter by source (linkedin, indeed, github)")
  .option("--save", "Save results to database", false)
  .option("--json", "Output as JSON", false)
  .action(async (query: string, options) => {
    const config = loadConfig();
    const conductor = new Conductor(config);

    // ── Trace printer ─────────────────────────────────────────────
    // Subscribes to span events and prints a live tree to stderr so
    // you can follow the pipeline: CLI → Conductor → Agent → MCP.
    const tracer = getTracer();
    const spanDepths = new Map<string, number>();

    tracer.on("span:start", (span) => {
      const depth = span.parentSpanId
        ? (spanDepths.get(span.parentSpanId) ?? 0) + 1
        : 0;
      spanDepths.set(span.spanId, depth);
      const indent = "  ".repeat(depth);
      process.stderr.write(`${indent}▸ ${span.name}\n`);
    });

    tracer.on("span:end", (span) => {
      const depth = spanDepths.get(span.spanId) ?? 0;
      const indent = "  ".repeat(depth);
      const dur = `${span.durationMs ?? "?"}ms`.padStart(8);
      const icon = span.status === "error" ? "✗" : "✓";
      const errMsg =
        span.status === "error"
          ? `  [${span.attributes["error.message"] ?? "error"}]`
          : "";
      // Print a subset of useful attributes inline
      const interesting = [
        "query.raw",
        "results.count",
        "jobs.before_dedup",
        "jobs.after_dedup",
        "jobs.ranked",
        "agents.count",
        "tool.name",
        "source",
      ];
      const attrStr = interesting
        .filter((k) => span.attributes[k] !== undefined)
        .map((k) => `${k.split(".").pop()}=${span.attributes[k]}`)
        .join(" ");
      process.stderr.write(
        `${indent}${icon} ${span.name} ${dur}${attrStr ? `  ${attrStr}` : ""}${errMsg}\n`
      );
      spanDepths.delete(span.spanId);
    });
    // ─────────────────────────────────────────────────────────────

    const spinner = ora("Searching across job boards...").start();

    try {
      const result = await conductor.search(query);

      // Persist state for the dashboard command (separate process).
      // Written unconditionally after every search.
      try {
        ensureDataDir();
        const rootTrace = getTracer().getTrace(result.traceId) ?? null;
        const dashState: DashboardState = {
          savedAt: new Date().toISOString(),
          searchQuery: query,
          stats: result.stats,
          trace: rootTrace,
          metricsSnapshot: getMetrics().snapshot(),
          costSummary: getDecisionLog().getCostSummary(),
          costEntries: getDecisionLog().toJSON().costs,
        };
        writeFileSync(DASHBOARD_STATE_FILE, JSON.stringify(dashState, null, 2));
      } catch {
        // Non-fatal — don't break the search output if state persistence fails
      }

      spinner.succeed(
        chalk.green(
          `Found ${result.stats.afterDedup} jobs ` +
            `(${result.stats.totalFound} raw, ${result.stats.totalFound - result.stats.afterDedup} duplicates removed) ` +
            `in ${(result.stats.durationMs / 1000).toFixed(1)}s`
        )
      );

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // Display results table
      const limit = parseInt(options.limit);
      const jobs = result.jobs.slice(0, limit);
      displayJobTable(jobs);

      // Display stats footer
      console.log("");
      console.log(chalk.dim("─".repeat(80)));
      console.log(
        chalk.dim(
          `  Trace ID: ${result.traceId} | ` +
            `Agents: ${result.stats.agentsSucceeded}/${result.stats.agentsQueried} succeeded | ` +
            `Tokens: ${result.stats.totalTokensUsed.toLocaleString()} | ` +
            `Cost: $${result.stats.estimatedCostUsd.toFixed(4)}`
        )
      );

      // Save to database if requested
      if (options.save) {
        ensureDataDir();
        const store = new JobStore(config.storage.dbPath);
        const newCount = store.bulkUpsert(result.jobs);
        store.close();
        console.log(chalk.green(`  Saved ${newCount} new jobs to database`));
      }
    } catch (error) {
      spinner.fail(chalk.red("Search failed"));
      console.error(
        chalk.red(error instanceof Error ? error.message : String(error))
      );
      process.exit(1);
    }
  });

// ─── Apply Command ────────────────────────────────────────────────

program
  .command("apply")
  .description("Generate application materials for a specific job")
  .argument("<job-id>", "Job ID to generate materials for")
  .option("--resume", "Generate tailored resume", false)
  .option("--cover-letter", "Generate cover letter", false)
  .option("--email", "Generate outreach email", false)
  .option("--all", "Generate all materials", false)
  .option("--tone <tone>", "Tone: formal, conversational, enthusiastic, concise", "conversational")
  .option("--variants <n>", "Number of variants to generate", "2")
  .action(async (jobId: string, options) => {
    const config = loadConfig();

    const generateResume = options.all || options.resume;
    const generateCoverLetter = options.all || options.coverLetter;
    const generateEmail = options.all || options.email;

    if (!generateResume && !generateCoverLetter && !generateEmail) {
      console.log(
        chalk.yellow("Specify what to generate: --resume, --cover-letter, --email, or --all")
      );
      return;
    }

    // Load job from database
    ensureDataDir();
    const store = new JobStore(config.storage.dbPath);
    const jobs = store.getTopJobs(100);
    const job = jobs.find((j) => j.id === jobId);

    if (!job) {
      console.log(chalk.red(`Job not found: ${jobId}`));
      console.log(chalk.dim("Run 'orpheus search --save' first to populate the database."));
      store.close();
      return;
    }

    console.log(chalk.bold(`\nGenerating materials for: ${job.title} at ${job.company}`));
    console.log(chalk.dim("─".repeat(60)));

    const profile = config.profile;
    const variants = parseInt(options.variants);

    if (generateResume) {
      const spinner = ora("Tailoring resume...").start();
      const tailor = new ResumeTailor(config.content.model);
      const result = await tailor.tailor(profile, job, variants);
      spinner.succeed(`Resume: ${result.variants.length} variants generated`);

      for (const variant of result.variants) {
        console.log(
          chalk.cyan(
            `\n  ── ${variant.strategy} (confidence: ${variant.confidence.toFixed(2)}) ──`
          )
        );
        console.log(chalk.dim(variant.content.slice(0, 300) + "..."));
      }
    }

    if (generateCoverLetter) {
      const spinner = ora("Writing cover letters...").start();
      const generator = new CoverLetterGenerator(config.content.model);
      const result = await generator.generate(profile, job, {
        tone: options.tone,
      });
      spinner.succeed(`Cover Letters: ${result.variants.length} variants generated`);

      for (const variant of result.variants) {
        console.log(
          chalk.cyan(
            `\n  ── ${variant.strategy} (confidence: ${variant.confidence.toFixed(2)}) ──`
          )
        );
        console.log(chalk.dim(variant.content.slice(0, 300) + "..."));
      }
    }

    if (generateEmail) {
      const spinner = ora("Drafting outreach email...").start();
      const drafter = new EmailDrafter(config.content.model);
      const result = await drafter.draft(profile, job, {
        type: "cold_outreach",
      }, variants);
      spinner.succeed(`Emails: ${result.variants.length} variants generated`);

      for (const variant of result.variants) {
        console.log(chalk.cyan(`\n  ── ${variant.strategy} ──`));
        console.log(chalk.dim(variant.content));
      }
    }

    // Show cost summary
    const decisionLog = getDecisionLog();
    const costSummary = decisionLog.getCostSummary();
    console.log(chalk.dim(`\n  Total cost: $${costSummary.totalUsd.toFixed(4)}`));

    store.close();
  });

// ─── Dashboard Command ───────────────────────────────────────────

program
  .command("dashboard")
  .description("Show the observability dashboard (Ink TUI)")
  .action(async () => {
    if (!existsSync(DASHBOARD_STATE_FILE)) {
      console.log(chalk.yellow("No dashboard data yet."));
      console.log(chalk.dim("  Run a search first:  orpheus search \"your query\""));
      return;
    }

    const raw = readFileSync(DASHBOARD_STATE_FILE, "utf-8");
    const state = JSON.parse(raw) as DashboardState;

    const instance = render(
      React.createElement(Dashboard, { state })
    );
    // In a real TTY the user presses q to quit via useInput.
    // In non-interactive contexts (piped stdin, CI) raw mode is unavailable
    // so we just render once and exit immediately.
    if (process.stdin.isTTY) {
      await instance.waitUntilExit();
    } else {
      instance.unmount();
    }
  });

// ─── Stats Command ────────────────────────────────────────────────

program
  .command("stats")
  .description("Show database statistics")
  .action(async () => {
    const config = loadConfig();
    ensureDataDir();
    const store = new JobStore(config.storage.dbPath);
    const stats = store.getStats();

    console.log(chalk.bold("\n📈 Orpheus Statistics\n"));
    console.log(`  Total jobs stored: ${stats.totalJobs}`);
    console.log(
      `  Average match score: ${(stats.avgMatchScore * 100).toFixed(1)}%`
    );

    if (Object.keys(stats.bySource).length > 0) {
      console.log(chalk.bold("\n  By Source:"));
      for (const [source, count] of Object.entries(stats.bySource)) {
        console.log(`    ${source}: ${count}`);
      }
    }

    if (Object.keys(stats.byStatus).length > 0) {
      console.log(chalk.bold("\n  Applications:"));
      for (const [status, count] of Object.entries(stats.byStatus)) {
        console.log(`    ${status}: ${count}`);
      }
    }

    store.close();
  });

// ─── Helpers ──────────────────────────────────────────────────────

function displayJobTable(jobs: JobListing[]): void {
  const table = new Table({
    head: [
      chalk.white("ID"),
      chalk.white("Title"),
      chalk.white("Company"),
      chalk.white("Location"),
      chalk.white("Salary"),
      chalk.white("Source"),
    ],
    colWidths: [14, 30, 20, 15, 15, 10],
    wordWrap: true,
  });

  for (const job of jobs) {
    const salary = job.salary
      ? `$${((job.salary.min ?? 0) / 1000).toFixed(0)}k-$${((job.salary.max ?? 0) / 1000).toFixed(0)}k`
      : chalk.dim("N/A");

    const location = job.remote
      ? chalk.green("Remote")
      : job.location.slice(0, 13);

    table.push([
      chalk.dim(job.id.slice(0, 12)),
      job.title.slice(0, 28),
      job.company.slice(0, 18),
      location,
      salary,
      job.source,
    ]);
  }

  console.log(table.toString());
}

function ensureDataDir(): void {
  if (!existsSync("./data")) {
    mkdirSync("./data", { recursive: true });
  }
}

// ─── Run ──────────────────────────────────────────────────────────

program.parse();
