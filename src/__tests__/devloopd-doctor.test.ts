import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatDevloopDoctorReport,
  runDevloopDoctor,
  type DevloopDoctorCommandRunner,
} from '../devloopd/doctor.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';

function writeProjectConfig(projectDir: string, content: string): void {
  const configDir = join(projectDir, '.takt');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), content, 'utf-8');
}

function writeGlobalConfig(globalConfigDir: string, content: string): void {
  mkdirSync(globalConfigDir, { recursive: true });
  writeFileSync(join(globalConfigDir, 'config.yaml'), content, 'utf-8');
}

function writeWorkflow(projectDir: string, content: string): void {
  const workflowDir = join(projectDir, '.takt', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, 'subscription.yaml'), content, 'utf-8');
}

function makeRunner(
  availableCommands = new Set(['takt', 'gh', 'codex', 'cursor-agent', 'opencode', 'agy']),
  ghAuthExitCode = 0,
): DevloopDoctorCommandRunner {
  return {
    resolveCommand(command) {
      return availableCommands.has(command) ? `/mock/bin/${command}` : undefined;
    },
    async exec(command, args) {
      if (command === 'gh' && args.join(' ') === 'auth status') {
        return { exitCode: ghAuthExitCode, stdout: '', stderr: ghAuthExitCode === 0 ? '' : 'not logged in' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

describe('devloopd doctor', () => {
  let projectDir: string;
  let globalConfigDir: string;
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    projectDir = join(tmpdir(), `takt-devloopd-doctor-${randomUUID()}`);
    globalConfigDir = join(tmpdir(), `takt-devloopd-doctor-global-${randomUUID()}`);
    mkdirSync(projectDir, { recursive: true });
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    writeGlobalConfig(globalConfigDir, 'language: en\nprovider: codex-cli\n');
    writeProjectConfig(projectDir, [
      'subscription_only: true',
      'provider: codex-cli',
      'allowed_providers: [codex-cli, cursor-cli, opencode-cli, agy-cli, mock]',
    ].join('\n'));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    if (existsSync(globalConfigDir)) {
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it('passes when subscription-only config, required CLIs, and GitHub auth are available', async () => {
    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(),
    });

    expect(report.passed).toBe(true);
    expect(report.checks.filter((check) => check.status === 'fail')).toEqual([]);
  });

  it('hides passing check details unless verbose is enabled', () => {
    const report = {
      passed: true,
      checks: [
        { status: 'pass' as const, name: 'command:takt', message: 'found takt' },
        { status: 'warn' as const, name: 'devloop policy', message: 'no policy file provided' },
      ],
    };

    const terseOutput = formatDevloopDoctorReport(report);
    expect(terseOutput).toContain('devloopd doctor passed');
    expect(terseOutput).toContain('devloop policy');
    expect(terseOutput).not.toContain('command:takt');

    expect(formatDevloopDoctorReport(report, { verbose: true })).toContain('command:takt');
  });

  it('fails without leaking forbidden environment variable values', async () => {
    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: {
        PATH: '/mock/bin',
        OPENAI_API_KEY: 'sk-should-not-appear',
      },
      runner: makeRunner(),
    });

    const output = formatDevloopDoctorReport(report);

    expect(report.passed).toBe(false);
    expect(output).toContain('forbidden environment variable present: OPENAI_API_KEY');
    expect(output).not.toContain('sk-should-not-appear');
  });

  it('fails when TAKT config does not enable subscription-only mode', async () => {
    writeProjectConfig(projectDir, 'provider: codex-cli\n');
    invalidateAllResolvedConfigCache();

    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(),
    });

    expect(report.passed).toBe(false);
    expect(formatDevloopDoctorReport(report)).toContain('TAKT config must set subscription_only: true');
  });

  it('fails when API key config exists in subscription-only mode', async () => {
    writeGlobalConfig(globalConfigDir, [
      'subscription_only: true',
      'provider: codex-cli',
      'openai_api_key: sk-should-not-appear',
    ].join('\n'));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(),
    });

    const output = formatDevloopDoctorReport(report);
    expect(report.passed).toBe(false);
    expect(output).toContain('openai_api_key');
    expect(output).not.toContain('sk-should-not-appear');
  });

  it('fails when a project workflow declares an API provider', async () => {
    writeWorkflow(projectDir, `name: subscription
initial_step: plan
steps:
  - name: plan
    provider: codex
    rules:
      - condition: done
        next: COMPLETE
`);

    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(),
    });

    expect(report.passed).toBe(false);
    expect(formatDevloopDoctorReport(report)).toMatch(/workflow.*codex/i);
  });

  it('accepts agent as the Cursor CLI fallback when cursor-agent is unavailable', async () => {
    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(new Set(['takt', 'gh', 'codex', 'agent', 'opencode', 'agy'])),
    });

    expect(report.passed).toBe(true);
    expect(formatDevloopDoctorReport(report, { verbose: true })).toContain('agent');
  });

  it('fails when a required subscription CLI is missing', async () => {
    const report = await runDevloopDoctor({
      repoPath: projectDir,
      subscriptionOnly: true,
      env: { PATH: '/mock/bin' },
      runner: makeRunner(new Set(['takt', 'gh', 'codex', 'cursor-agent', 'opencode'])),
    });

    expect(report.passed).toBe(false);
    expect(formatDevloopDoctorReport(report)).toContain('command not found: agy');
  });
});
