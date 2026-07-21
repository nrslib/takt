import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { packageVersion } from '../../src/shared/package-info';

const EXPECTED_ROOT_HELP = `Usage: takt [options] [command] [task]

TAKT: TAKT Agent Koordination Topology

Arguments:
  task                                      Task to execute (or issue reference like "#6")

Options:
  -V, --version                             output the version number
  -i, --issue <number>                      Issue number (equivalent to #N)
  --pr <number>                             PR number to fetch review comments and fix
  -w, --workflow <name>                     Workflow name or path to workflow file
  -b, --branch <name>                       Branch name (auto-generated if omitted)
  --auto-pr                                 Create PR after successful execution
  --draft                                   Create PR as draft (requires --auto-pr or auto_pr config)
  --repo <owner/repo>                       Repository (defaults to current)
  --provider <name>                         Override agent provider (claude|claude-sdk|claude-terminal|codex|opencode|cursor|copilot|kiro|mock) (choices: "claude", "claude-sdk", "claude-terminal", "codex", "opencode", "cursor", "copilot", "kiro", "mock")
  --auto-strategy <strategy>                Auto routing strategy (cost|balanced|performance) (choices: "cost", "balanced", "performance")
  --model <name>                            Override agent model
  -t, --task <string>                       Task content (as alternative to issue reference)
  --pipeline                                Pipeline mode: non-interactive, no worktree, direct branch creation
  --skip-git                                Skip branch creation, commit, and push (pipeline mode)
  -q, --quiet                               Minimal output mode: suppress AI output (for CI)
  -c, --continue                            Continue from the last assistant session
  -h, --help                                display help for command

Commands:
  run [options]                             Run all pending tasks from .takt/tasks.yaml
  watch [options]                           Watch for tasks and auto-execute
  add [task]                                Add a new task
  list [options]                            List task branches (merge/delete)
  resume                                    Resume the latest failed or aborted direct run
  exec [options] [preset]                   Start instant multi-agent exec mode
  clear                                     Clear agent conversation sessions
  eject [options] [typeOrName] [facetName]  Copy builtin workflow or facet for customization (default: project .takt/)
  reset                                     Reset settings to defaults
  prompt [workflow]                         Preview assembled prompts for each step and phase
  export-cc                                 Export takt workflows/agents as Claude Code Skill (~/.claude/)
  export-codex                              Export takt workflows/agents as Codex Skill (~/.agents/)
  catalog [type]                            List available facets (personas, policies, knowledge, instructions, output-contracts)
  workflow                                  Workflow authoring utilities
  metrics                                   Show analytics metrics
  purge [options]                           Purge old analytics event files
  telemetry                                 Manage TAKT local routing event recording
  repertoire                                Manage repertoire packages`;

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Help command (takt --help)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  const cleanupResources = (): void => {
    const errors: unknown[] = [];

    try {
      repo.cleanup();
    } catch (error) {
      errors.push(error);
    }

    try {
      isolatedEnv.cleanup();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, 'Failed to clean up E2E help test resources');
    }
  };

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    cleanupResources();
  });

  it('should preserve the complete root help contract', () => {
    // Given: a local repo with isolated env

    // When: running takt --help
    const result = runTakt({
      args: ['--help'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd()).toBe(EXPECTED_ROOT_HELP);
  });

  it('should display the package version with --version', () => {
    const result = runTakt({
      args: ['--version'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageVersion);
  });

  it('should display run subcommand help with takt run --help', () => {
    // Given: a local repo with isolated env

    // When: running takt run --help
    const result = runTakt({
      args: ['run', '--help'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: output contains run command description
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toLowerCase();
    expect(output).toMatch(/run|task|pending/);
  });

  it('should display --ignore-exceed in takt run --help', () => {
    const result = runTakt({
      args: ['run', '--help'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--ignore-exceed');
  });

  it('should display --ignore-exceed in takt watch --help', () => {
    const result = runTakt({
      args: ['watch', '--help'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--ignore-exceed');
  });

  it('should show prompt argument help without current-workflow wording', () => {
    // Given: a local repo with isolated env

    // When: running takt prompt --help
    const result = runTakt({
      args: ['prompt', '--help'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: prompt help uses explicit default workflow wording
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/defaults to ["']default["']/i);
    expect(result.stdout).not.toMatch(/defaults to current/i);
  });

  it('should fail with unknown command for removed switch subcommand', () => {
    // Given: a local repo with isolated env

    // When: running removed takt switch command
    const result = runTakt({
      args: ['switch'],
      cwd: repo.path,
      env: isolatedEnv.env,
    });

    // Then: command exits non-zero and reports unknown command
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.exitCode).not.toBe(0);
    expect(combined).toMatch(/unknown command/i);
  });
});
