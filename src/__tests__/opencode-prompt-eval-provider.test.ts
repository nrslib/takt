import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const provider = resolve(process.cwd(), 'eval/providers/opencode-review.sh');

describe('OpenCode prompt eval provider', () => {
  let root: string;
  let fixtureDir: string;
  let phase2Prompt: string;
  let logPath: string;
  let spawnOptionsLogPath: string;
  let spawnPreload: string;
  let binDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-opencode-eval-'));
    fixtureDir = join(root, 'fixture');
    phase2Prompt = join(root, 'phase2.md');
    logPath = join(root, 'calls.jsonl');
    spawnOptionsLogPath = join(root, 'spawn-options.jsonl');
    binDir = join(root, 'bin');
    mkdirSync(fixtureDir);
    mkdirSync(binDir);
    writeFileSync(phase2Prompt, 'PHASE 2 PROMPT');
    const fakeOpenCode = join(binDir, 'opencode');
    writeFileSync(fakeOpenCode, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const mode = process.env.FAKE_OPENCODE_MODE || 'ok';
const isJson = args.includes('--format') && args.includes('json');
const sessionIndex = args.indexOf('--session');
const isPhase2 = sessionIndex >= 0;
if (!isJson) {
  process.stdout.write('SINGLE OUTPUT\\n');
  process.exit(0);
}
if (mode === 'nonzero' && !isPhase2) {
  process.stderr.write('provider failed');
  process.exit(7);
}
if (mode === 'invalid-json' && !isPhase2) {
  process.stdout.write('not json\\n');
  process.exit(0);
}
const sessionID = isPhase2 && mode === 'session-mismatch' ? 'session-2' : 'session-1';
const emit = (value) => process.stdout.write(JSON.stringify({ sessionID, ...value }) + '\\n');
emit({ type: 'step_start', part: { type: 'step-start' } });
if (!isPhase2) {
  emit({ type: 'text', part: { type: 'text', text: 'PHASE 1 SECRET' } });
} else if (mode === 'tool-use') {
  emit({ type: 'tool_use', part: { type: 'tool' } });
} else if (mode === 'error-event') {
  emit({ type: 'error', error: { name: 'ProviderError' } });
} else if (mode === 'error-event-data') {
  emit({ type: 'error', error: { name: 'ProviderError', data: { message: 'SDK detail' } } });
} else if (mode !== 'empty') {
  emit({ type: 'text', part: { type: 'text', text: 'REPORT A' } });
  emit({ type: 'text', part: { type: 'text', text: 'REPORT B' } });
}
emit({ type: 'step_finish', part: { type: 'step-finish' } });
`);
    chmodSync(fakeOpenCode, 0o755);
    spawnPreload = join(root, 'observe-spawn-options.cjs');
    writeFileSync(spawnPreload, `const fs = require('node:fs');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  fs.appendFileSync(process.env.FAKE_SPAWN_OPTIONS_LOG, JSON.stringify(options) + '\\n');
  return originalSpawnSync(command, args, options);
};
syncBuiltinESMExports();
`);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(args: string[], mode = 'ok') {
    return spawnSync('bash', [provider, ...args], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        FAKE_OPENCODE_LOG: logPath,
        FAKE_OPENCODE_MODE: mode,
        FAKE_SPAWN_OPTIONS_LOG: spawnOptionsLogPath,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--require=${spawnPreload}`,
        ].filter(Boolean).join(' '),
      },
    });
  }

  function calls(): Array<{ args: string[]; cwd: string }> {
    return readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
  }

  function spawnOptions(): Array<{ timeout: number; killSignal: string }> {
    return readFileSync(spawnOptionsLogPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { timeout: number; killSignal: string });
  }

  it('documents the Phase 2 prompt as a path in Usage', () => {
    const result = run(['provider/model', fixtureDir]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--phase2=<phase2-prompt-path>');
  });

  it('rejects an unknown third-argument option before invoking OpenCode', () => {
    const result = run([
      'provider/model',
      fixtureDir,
      '--phase-2=phase2.md',
      'PHASE 1 PROMPT',
      '{"promptfoo":"context"}',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unrecognized option: --phase-2=phase2.md');
    expect(existsSync(logPath)).toBe(false);
  });

  it('keeps the existing single-phase invocation unchanged', () => {
    const result = run([
      'provider/model',
      fixtureDir,
      'PHASE 1 PROMPT',
      '{"promptfoo":"context"}',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('SINGLE OUTPUT\n');
    expect(calls()).toEqual([{
      args: ['run', '-m', 'provider/model', '--pure', 'PHASE 1 PROMPT'],
      cwd: fixtureDir,
    }]);
    expect(spawnOptions()).toEqual([expect.objectContaining({
      timeout: 10 * 60 * 1000,
      killSignal: 'SIGKILL',
    })]);
  });

  it('resumes Phase 1 for Phase 2 and emits only report text', () => {
    const result = run([
      'provider/model',
      fixtureDir,
      `--phase2=${phase2Prompt}`,
      'PHASE 1 PROMPT',
      '{"promptfoo":"context"}',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('REPORT A\nREPORT B\n');
    expect(result.stdout).not.toContain('PHASE 1 SECRET');
    const recorded = calls();
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toEqual({
      args: ['run', '-m', 'provider/model', '--pure', '--format', 'json', 'PHASE 1 PROMPT'],
      cwd: fixtureDir,
    });
    expect(recorded[1]?.cwd).toBe(fixtureDir);
    expect(recorded[1]?.args).toEqual([
      'run',
      '-m',
      'provider/model',
      '--pure',
      '--format',
      'json',
      '--session',
      'session-1',
      'PHASE 2 PROMPT',
    ]);
    expect(spawnOptions()).toHaveLength(2);
    expect(spawnOptions().every((options) => (
      options.timeout === 10 * 60 * 1000 && options.killSignal === 'SIGKILL'
    ))).toBe(true);
  });

  it.each([
    ['invalid-json', /invalid JSON/],
    ['nonzero', /status 7/],
    ['session-mismatch', /did not resume/],
    ['tool-use', /forbidden tool call/],
    ['error-event', /error event: ProviderError/],
    ['error-event-data', /error event: SDK detail/],
    ['empty', /no report text/],
  ])('fails fast for %s', (mode, expected) => {
    const result = run([
      'provider/model',
      fixtureDir,
      `--phase2=${phase2Prompt}`,
      'PHASE 1 PROMPT',
      '{"promptfoo":"context"}',
    ], mode);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(expected);
  });
});
