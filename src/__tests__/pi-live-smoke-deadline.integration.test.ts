import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const project = fileURLToPath(new URL('../../', import.meta.url));
const script = join(project, 'scripts/pi-provider-live-smoke.mjs');
const preload = fileURLToPath(new URL('./fixtures/pi-live-smoke-deadline.ts', import.meta.url));

interface FixtureEvent { event: string; sessionId?: string }

/** Runs the smoke entrypoint with offline SDK/HTTP fixtures and fast deadlines. */
async function runSmoke(mode: 'normal' | 'sdk-hang' | 'cleanup-hang') {
  const root = mkdtempSync(join(tmpdir(), 'takt-pi-deadline-test-'));
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', preload, script], {
    cwd: project,
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root,
      TAKT_CONFIG_DIR: join(root, 'takt'), PI_CODING_AGENT_DIR: join(root, 'pi'),
      PI_SMOKE_FIXTURE_MODE: mode,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const events: FixtureEvent[] = [];
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr!.on('data', (data: Buffer) => { stderr += data.toString(); });
  child.on('message', (message: FixtureEvent) => { events.push(message); });
  let closed = false;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  void completion.catch(() => undefined);
  // This guard only fails and reaps the child; it cannot make a deadline test pass.
  const guard = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    if (mode !== 'normal') {
      await expect.poll(() => events.some((event) => event.event === 'pending'), { timeout: 5_000 }).toBe(true);
      child.send({ advanceMs: 119_999 });
      await expect.poll(() => events.some((event) => event.event === 'clock-advanced')).toBe(true);
      expect(closed).toBe(false);
      expect(events.filter((event) => event.event === 'prompt')).toHaveLength(1);
      expect(events.filter((event) => event.event === 'signal-aborted')).toHaveLength(0);
      child.send({ advanceMs: 1 });
    }
    const result = await completion;
    expect(result.signal, stderr).toBeNull();
    return { ...result, events, stdout, stderr };
  } finally {
    clearTimeout(guard);
    try {
      if (!closed) child.kill('SIGKILL');
      await completion;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

describe('Pi live smoke process deadlines', () => {
  it.each(['sdk-hang', 'cleanup-hang'] as const)('exits with an error at 120 seconds when %s ignores cancellation', async (mode) => {
    const result = await runSmoke(mode);
    expect(result.code, result.stderr).toBe(1);
    const error = result.stderr.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    expect(error).toEqual([expect.objectContaining({
      status: 'error', reason: 'Smoke turn deadline exceeded', requests: 1, submissions: 1,
    })]);
    for (const name of ['prompt', 'request', 'submission', 'signal-aborted']) {
      expect(result.events.filter((event) => event.event === name)).toHaveLength(1);
    }
    if (mode === 'cleanup-hang') expect(result.events.filter((event) => event.event === 'abort')).toHaveLength(1);
    expect(result.events.filter((event) => event.event === 'prompt-finished')).toHaveLength(mode === 'cleanup-hang' ? 1 : 0);
    expect(result.stdout).toBe('');
  }, 15_000);

  it('finishes two normal turns with the same session and probe and exactly two submissions', async () => {
    const result = await runSmoke('normal');
    expect(result.code, result.stderr).toBe(0);
    const output = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(output).toHaveLength(3);
    expect(output[0]).toMatchObject({ turn: 1, status: 'done', requests: 1, submissions: 1 });
    expect(output[1]).toMatchObject({ turn: 2, status: 'done', requests: 2, submissions: 2 });
    expect(output[1].sessionId).toBe(output[0].sessionId);
    expect(output[1].response).toBe(output[0].response);
    expect(output[0].response).toMatch(/^takt-probe-/u);
    expect(output[2]).toMatchObject({ status: 'done', model: 'openai-codex/gpt-6.1-sol', thinkingLevel: 'high', requests: 2, submissions: 2 });
    for (const name of ['prompt', 'request', 'submission']) {
      expect(result.events.filter((event) => event.event === name)).toHaveLength(2);
    }
    expect(result.events.filter((event) => event.event === 'prompt')).toEqual([
      expect.objectContaining({
        activeTools: [], codemodeSource: expect.objectContaining({ source: 'inline', path: '<inline:codemode>' }),
      }),
      expect.objectContaining({
        activeTools: [], codemodeSource: expect.objectContaining({ source: 'inline', path: '<inline:codemode>' }),
      }),
    ]);
    expect(result.events.some((event) => event.event === 'signal-aborted')).toBe(false);
  }, 15_000);
});
