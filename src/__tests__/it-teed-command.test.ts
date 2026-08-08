import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTeedCommand } from '../../scripts/teed-command.mjs';

// The grandchild outlives the stdio drain deadline on purpose: it holds the
// inherited stdout pipe so 'close' never fires for the child.
const GRANDCHILD_LIFETIME_MS = 8000;

afterEach(() => {
  vi.restoreAllMocks();
});

function captureStdout(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(chunk.toString());
    return true;
  });
  return written;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition was not met before the deadline');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('teed command execution', () => {
  it('should forward child output to this process while the child is still running', async () => {
    const written = captureStdout();
    const pending = runTeedCommand(process.execPath, [
      '-e',
      "process.stdout.write('early\\n'); setTimeout(() => process.stdout.write('late\\n'), 300);",
    ]);

    await waitUntil(() => written.join('').includes('early'), 5000);
    const forwardedBeforeExit = written.join('');
    const result = await pending;

    expect(forwardedBeforeExit).not.toContain('late');
    expect(result.code).toBe(0);
    expect(result.output).toBe('early\nlate\n');
  });

  it('should capture stdout and stderr of a shard that exits non-zero', async () => {
    captureStdout();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await runTeedCommand(process.execPath, [
      '-e',
      "process.stdout.write('on-stdout\\n'); process.stderr.write('on-stderr\\n'); process.exit(3);",
    ]);

    expect(result.code).toBe(3);
    expect(result.output).toContain('on-stdout');
    expect(result.output).toContain('on-stderr');
  });

  it('should settle within the drain deadline when a grandchild still holds the pipe', async () => {
    const written = captureStdout();
    const startedAt = Date.now();

    const result = await runTeedCommand(process.execPath, [
      '-e',
      "const { spawn } = require('node:child_process');"
      + ` const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${GRANDCHILD_LIFETIME_MS})'],`
      + " { stdio: ['ignore', 'inherit', 'ignore'], detached: true });"
      + ' g.unref();'
      + " process.stdout.write('parent-done\\n');"
      + ' process.exit(0);',
    ]);

    expect(result.code).toBe(0);
    expect(result.output).toContain('parent-done');
    expect(written.join('')).toContain('parent-done');
    expect(Date.now() - startedAt).toBeLessThan(GRANDCHILD_LIFETIME_MS);
  });

  it('should reject when the command cannot be started', async () => {
    await expect(runTeedCommand('/nonexistent/takt-teed-command-probe', [])).rejects.toThrow();
  });
});
