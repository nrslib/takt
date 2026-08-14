import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PROJECT_ROOT = resolve('.');
const SOURCE_CLI = resolve(PROJECT_ROOT, 'src/__tests__/helpers/companion-entrypoint-runner.ts');
const VITE_NODE = resolve(PROJECT_ROOT, 'node_modules/.bin/vite-node');

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}

describe('CT-COMP-12 worktree companion runtime continuity', () => {
  let root: string;
  let projectDir: string;
  let cloneDir: string;
  let configDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-companion-worktree-'));
    projectDir = join(root, 'project');
    cloneDir = join(root, 'clone');
    configDir = join(root, 'config');
    mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
    mkdirSync(join(projectDir, '.takt', 'companions'), { recursive: true });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    git(root, ['init', '--quiet', projectDir]);
    git(projectDir, ['config', 'user.name', 'TAKT Test']);
    git(projectDir, ['config', 'user.email', 'takt@example.invalid']);

    writeFileSync(join(projectDir, 'src', 'value.ts'), 'export const value = 0;\n');
    writeFileSync(join(projectDir, '.takt', 'workflows', 'companion-it.yaml'), [
      'name: companion-it',
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
    ].join('\n'));
    writeFileSync(join(projectDir, '.takt', 'companions', 'security-reviewer.yaml'), [
      'name: security-reviewer',
      'description: Review the implementation for security defects',
      'interval_ms: 60000',
      '',
    ].join('\n'));
    writeFileSync(join(projectDir, '.takt', 'runtime.yaml'), [
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
    ].join('\n'));
    writeFileSync(join(configDir, 'config.yaml'), 'language: en\nnotification_sound: false\n');
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '--quiet', '-m', 'fixture']);
    execFileSync('git', ['clone', '--quiet', projectDir, cloneDir]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('runs the real workflow in the clone, fixes in-session, and isolates ignored mailbox state', () => {
    const scenarioPath = join(configDir, 'scenario.json');
    const callLogPath = join(configDir, 'calls.jsonl');
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
    ]));

    const stdout = execFileSync(VITE_NODE, [
      '--script',
      SOURCE_CLI,
      '--task',
      'Implement a valid exported value',
      '--workflow',
      join(cloneDir, '.takt', 'workflows', 'companion-it.yaml'),
    ], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 60_000,
      env: {
        ...process.env,
        TAKT_CONFIG_DIR: configDir,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_MOCK_CALL_LOG: callLogPath,
        TAKT_TEST_WORKFLOW_CWD: cloneDir,
        TAKT_TEST_ENTRYPOINT: 'runtime',
        NO_UPDATE_NOTIFIER: '1',
      },
    });

    expect(readFileSync(join(cloneDir, 'src', 'value.ts'), 'utf-8'), stdout)
      .toBe('export const value = 1;\n');
    const runSlug = readdirSync(join(cloneDir, '.takt', 'runs'))[0];
    expect(runSlug).toBeDefined();
    const mailboxPath = join(
      cloneDir,
      '.takt',
      'runs',
      runSlug!,
      'companion',
      'implement',
      'security-reviewer.jsonl',
    );
    const mailbox = readFileSync(mailboxPath, 'utf-8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(mailbox).toEqual([
      expect.objectContaining({
        companion: 'security-reviewer',
        reviewedDigest: expect.stringMatching(/.+/),
        reviewedAt: expect.any(String),
        severity: 'must_fix',
      }),
    ]);
    const reviewedAt = mailbox[0]?.reviewedAt;
    if (typeof reviewedAt !== 'string') throw new TypeError('Expected reviewedAt to be a string');
    expect(new Date(reviewedAt).toISOString()).toBe(reviewedAt);
    const calls = readFileSync(callLogPath, 'utf-8').trim().split('\n')
      .map((line) => JSON.parse(line) as {
        event: string;
        personaName: string;
        inputSessionId?: string;
        returnedSessionId?: string;
      });
    const coderStarts = calls.filter(({ event, personaName }) => (
      event === 'start' && personaName === 'coder'
    ));
    const firstCoderComplete = calls.find(({ event, personaName }) => (
      event === 'complete' && personaName === 'coder'
    ));
    expect(coderStarts).toHaveLength(2);
    expect(coderStarts[0]?.inputSessionId).toBeUndefined();
    expect(firstCoderComplete?.returnedSessionId).toBeDefined();
    expect(coderStarts[1]?.inputSessionId).toBe(firstCoderComplete?.returnedSessionId);
    expect(existsSync(join(projectDir, '.takt', 'runs'))).toBe(false);
    expect(git(cloneDir, ['check-ignore', mailboxPath])).toBe(mailboxPath);
  });
});
