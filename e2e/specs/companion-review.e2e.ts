import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';

describe('E2E: companion review', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;
  let cloneRoot: string;
  let cloneDir: string;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
    cloneRoot = mkdtempSync(join(tmpdir(), 'takt-companion-e2e-clone-'));
    cloneDir = join(cloneRoot, 'clone');
  });

  afterEach(() => {
    repo.cleanup();
    rmSync(cloneRoot, { recursive: true, force: true });
    isolatedEnv.cleanup();
  });

  it('should review a mock tool change, run a same-session fix, and resolve the mailbox finding', () => {
    const workflowDir = join(repo.path, '.takt', 'workflows');
    const companionDir = join(repo.path, '.takt', 'companions');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(companionDir, { recursive: true });
    mkdirSync(join(repo.path, 'src'), { recursive: true });
    writeFileSync(join(repo.path, 'src', 'value.ts'), 'export const value = 0;\n', 'utf8');
    execFileSync('git', ['add', 'src/value.ts'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'add source'], { cwd: repo.path });
    writeFileSync(join(workflowDir, 'companion-e2e.yaml'), [
      'name: companion-e2e',
      'initial_step: implement',
      'max_steps: 2',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      '    instruction: implement',
      '    edit: true',
      '    companion: [security-reviewer]',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(companionDir, 'security-reviewer.yaml'), [
      'name: security-reviewer',
      'description: Review the implementation for security defects',
      'interval_ms: 60000',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(isolatedEnv.taktDir, 'config.yaml'), [
      'language: en',
      'notification_sound: false',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(repo.path, '.takt', 'runtime.yaml'), [
      'version: 1',
      'provider:',
      '  profiles:',
      '    mock:',
      '      provider: mock',
      '      model: mock-model',
      '  defaults:',
      '    profile: mock',
      '  targets:',
      '    companions:',
      '      security-reviewer:',
      '        profile: mock',
      '',
    ].join('\n'), 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'add companion fixture'], { cwd: repo.path });
    execFileSync('git', ['clone', '--quiet', repo.path, cloneDir]);
    const workflowPath = join(cloneDir, '.takt', 'workflows', 'companion-e2e.yaml');
    const scenarioPath = join(isolatedEnv.taktDir, 'companion-scenario.json');
    writeFileSync(scenarioPath, JSON.stringify([
      {
        persona: 'coder',
        content: 'Initial implementation complete.',
        stream_events: [{
          type: 'tool_use',
          tool: 'Edit',
          id: 'edit-1',
          input: { file_path: 'src/value.ts' },
        }],
        file_writes: [{ path: 'src/value.ts', content: 'export const value = -1;\n' }],
      },
      {
        persona: 'security-reviewer',
        content: 'Found an invalid value.',
        structured_output: {
          findings: [{
            severity: 'must_fix',
            file: 'src/value.ts',
            line: 1,
            finding: 'The exported value must not be negative.',
          }],
          notes: 'Check the value again.',
        },
      },
      {
        persona: 'coder',
        content: 'Fixed the companion finding.',
        stream_events: [{
          type: 'tool_use',
          tool: 'Edit',
          id: 'edit-2',
          input: { file_path: 'src/value.ts' },
        }],
        file_writes: [{ path: 'src/value.ts', content: 'export const value = 1;\n' }],
      },
      {
        persona: 'security-reviewer',
        content: 'No findings remain.',
        structured_output: {
          findings: [],
          notes: 'No findings.',
        },
      },
    ]), 'utf8');
    const callLogPath = join(isolatedEnv.taktDir, 'companion-calls.jsonl');

    const result = runTakt({
      args: ['--task', 'Implement a valid exported value', '--workflow', workflowPath],
      cwd: cloneDir,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_MOCK_CALL_LOG: callLogPath,
      },
      timeout: 180_000,
      injectProvider: false,
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(
      readFileSync(join(cloneDir, 'src', 'value.ts'), 'utf8'),
      `${result.stdout}\n${result.stderr}`,
    ).toBe('export const value = 1;\n');
    const runSlug = readdirSync(join(cloneDir, '.takt', 'runs'))[0];
    expect(runSlug).toBeDefined();
    const mailbox = readFileSync(join(
      cloneDir,
      '.takt',
      'runs',
      runSlug!,
      'companion',
      'implement',
      'security-reviewer.jsonl',
    ), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(mailbox).toEqual([
      expect.objectContaining({
        companion: 'security-reviewer',
        reviewedDigest: expect.any(String),
        reviewedAt: expect.any(String),
        severity: 'must_fix',
      }),
    ]);
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as {
        event: string;
        personaName: string;
        inputSessionId?: string;
        returnedSessionId?: string;
      });
    expect(calls.filter(({ event, personaName }) => (
      event === 'start' && personaName === 'security-reviewer'
    ))).toHaveLength(2);
    expect(calls.filter(({ event, personaName }) => (
      event === 'start' && personaName === 'coder'
    ))).toHaveLength(2);
    const coderStarts = calls.filter(({ event, personaName }) => (
      event === 'start' && personaName === 'coder'
    ));
    const firstCoderComplete = calls.find(({ event, personaName }) => (
      event === 'complete' && personaName === 'coder'
    ));
    expect(coderStarts[0]?.inputSessionId).toBeUndefined();
    expect(firstCoderComplete?.returnedSessionId).toBeDefined();
    expect(coderStarts[1]?.inputSessionId).toBe(firstCoderComplete?.returnedSessionId);
    expect(existsSync(join(repo.path, '.takt', 'runs'))).toBe(false);
    const mailboxPath = join(
      cloneDir,
      '.takt',
      'runs',
      runSlug!,
      'companion',
      'implement',
      'security-reviewer.jsonl',
    );
    expect(execFileSync('git', ['check-ignore', mailboxPath], {
      cwd: cloneDir,
      encoding: 'utf8',
    }).trim()).toBe(mailboxPath);
  });
});
