#!/usr/bin/env node

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { formatDevloopDoctorReport, runDevloopDoctor } from '../../devloopd/doctor.js';
import {
  formatImportTaktRunReport,
  formatTimelineReport,
  importTaktRun,
  renderTimeline,
} from '../../devloopd/ledger.js';
import { formatMergeGateReport, mergeIfSafe } from '../../devloopd/mergeGate.js';
import { formatDevloopRunReport, runDevloopIssue } from '../../devloopd/run.js';
import { getErrorMessage } from '../../shared/utils/error.js';

const require = createRequire(import.meta.url);
const { version: cliVersion } = require('../../../package.json') as { version: string };

const program = new Command();

program
  .name('devloopd')
  .description('devloopd sidecar utilities for TAKT subscription-only development loops')
  .version(cliVersion);

program
  .command('doctor')
  .description('Check local subscription-only provider readiness')
  .option('--subscription-only', 'Require TAKT subscription-only policy checks')
  .option('--repo <path>', 'Repository path to inspect', process.cwd())
  .option('--policy <path>', 'devloopd policy YAML path')
  .option('--verbose', 'Show passing checks')
  .option('--skip-auth', 'Skip GitHub CLI auth status check')
  .action(async (options: {
    subscriptionOnly?: boolean;
    repo: string;
    policy?: string;
    verbose?: boolean;
    skipAuth?: boolean;
  }) => {
    const report = await runDevloopDoctor({
      repoPath: resolve(options.repo),
      policyPath: options.policy ? resolve(options.policy) : undefined,
      subscriptionOnly: options.subscriptionOnly === true,
      verbose: options.verbose === true,
      skipAuth: options.skipAuth === true,
    });

    console.log(formatDevloopDoctorReport(report, { verbose: options.verbose === true }));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('run')
  .description('Run a GitHub issue through TAKT after subscription-only readiness checks')
  .requiredOption('--issue <number>', 'GitHub issue number')
  .option('--repo <owner/repo>', 'GitHub repository for TAKT PR operations')
  .option('--workflow <path>', 'TAKT workflow name or path', '.takt/workflows/subscription-devloop.yaml')
  .option('--policy <path>', 'devloopd policy YAML path')
  .option('--skip-auth', 'Skip GitHub CLI auth status check')
  .option('--no-auto-pr', 'Do not pass --auto-pr to TAKT')
  .option('--no-quiet', 'Do not pass --quiet to TAKT')
  .option('--cwd <path>', 'Repository path to run in', process.cwd())
  .option('--verbose', 'Show doctor passing checks')
  .action(async (options: {
    issue: string;
    repo?: string;
    workflow: string;
    policy?: string;
    skipAuth?: boolean;
    autoPr?: boolean;
    quiet?: boolean;
    cwd: string;
    verbose?: boolean;
  }) => {
    const report = await runDevloopIssue({
      repoPath: resolve(options.cwd),
      issue: options.issue,
      repo: options.repo,
      workflow: options.workflow,
      policyPath: options.policy ? resolve(options.policy) : undefined,
      skipAuth: options.skipAuth === true,
      autoPr: options.autoPr !== false,
      quiet: options.quiet !== false,
    });

    console.log(formatDevloopRunReport(report, { verbose: options.verbose === true }));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('import-takt-run')
  .description('Import TAKT run metadata and artifacts into the devloop ledger')
  .option('--latest', 'Import the latest TAKT run')
  .option('--run <slug>', 'TAKT run slug to import')
  .option('--issue <number>', 'GitHub issue number to associate with the imported run', (value: string) => Number(value))
  .option('--cwd <path>', 'Repository path to inspect', process.cwd())
  .option('--ledger <path>', 'Ledger path relative to cwd or absolute path')
  .action((options: {
    latest?: boolean;
    run?: string;
    issue?: number;
    cwd: string;
    ledger?: string;
  }) => {
    const report = importTaktRun({
      repoPath: resolve(options.cwd),
      latest: options.latest === true,
      runSlug: options.run,
      issue: Number.isFinite(options.issue) ? options.issue : undefined,
      ledgerPath: options.ledger,
    });

    console.log(formatImportTaktRunReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('timeline')
  .description('Render imported TAKT runs from the devloop ledger')
  .option('--issue <number>', 'Filter by GitHub issue number', (value: string) => Number(value))
  .option('--run <slug>', 'Filter by TAKT run slug')
  .option('--cwd <path>', 'Repository path to inspect', process.cwd())
  .option('--ledger <path>', 'Ledger path relative to cwd or absolute path')
  .action((options: {
    issue?: number;
    run?: string;
    cwd: string;
    ledger?: string;
  }) => {
    const report = renderTimeline({
      repoPath: resolve(options.cwd),
      issue: Number.isFinite(options.issue) ? options.issue : undefined,
      runSlug: options.run,
      ledgerPath: options.ledger,
    });

    console.log(formatTimelineReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command('merge-if-safe')
  .description('Enable GitHub auto-merge only after mechanical merge gates pass')
  .requiredOption('--pr <number-or-url>', 'Pull request number or URL')
  .option('--repo <owner/repo>', 'GitHub repository')
  .option('--expected-head <sha>', 'Expected PR head SHA')
  .option('--cwd <path>', 'Repository path to inspect', process.cwd())
  .action(async (options: {
    pr: string;
    repo?: string;
    expectedHead?: string;
    cwd: string;
  }) => {
    const report = await mergeIfSafe({
      pr: options.pr,
      repo: options.repo,
      expectedHeadSha: options.expectedHead,
      repoPath: resolve(options.cwd),
    });

    console.log(formatMergeGateReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((error: unknown) => {
  console.error(getErrorMessage(error));
  process.exit(1);
});
