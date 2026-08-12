import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../agents/runner.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { MAX_AGENT_FAILURE_MESSAGE_BYTES } from '../shared/types/agent-failure.js';
import {
  assertValidIsolatedCodexEvent,
  buildIsolatedCodexArgs,
  callCodexIsolatedStructured,
} from '../infra/codex/isolated-structured-client.js';

type FailureMode = 'exact' | 'multibyte' | 'rate-limit';

function createFailureCodex(mode: FailureMode): { cwd: string; executable: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-isolated-failure-'));
  const executable = join(cwd, 'fake-codex.mjs');
  const messageExpression = mode === 'exact'
    ? `'x'.repeat(${MAX_AGENT_FAILURE_MESSAGE_BYTES})`
    : mode === 'multibyte'
      ? `'界'.repeat(5000)`
      : `'rate limit exceeded: ' + '界'.repeat(5000)`;
  writeFileSync(executable, `#!/usr/bin/env node
const message = ${messageExpression};
process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message } }) + '\\n');
`, { encoding: 'utf8', mode: 0o700 });
  chmodSync(executable, 0o700);
  return { cwd, executable };
}

function failureOptions(
  fixture: { cwd: string; executable: string },
  failureDir: string,
): Parameters<typeof callCodexIsolatedStructured>[2] {
  return {
    cwd: fixture.cwd,
    model: 'test-model',
    outputSchema: { type: 'object' },
    codexPathOverride: fixture.executable,
    failureDir,
  };
}

function assertExactTruncation(
  error: string,
  fullText: string,
): string {
  const match = /\[TRUNCATED: (\d+) bytes, full text: (.+)\]$/u.exec(error);
  expect(match?.[1]).toBeDefined();
  expect(match?.[2]).toBeDefined();
  const prefix = error.slice(0, error.indexOf('[TRUNCATED'));
  expect(fullText.startsWith(prefix)).toBe(true);
  expect(Number(match![1])).toBe(
    Buffer.byteLength(fullText, 'utf8') - Buffer.byteLength(prefix, 'utf8'),
  );
  expect(Buffer.byteLength(error, 'utf8')).toBeLessThanOrEqual(
    MAX_AGENT_FAILURE_MESSAGE_BYTES,
  );
  return match![2]!;
}

describe('Codex strict isolated structured execution', () => {
  it('builds the hardened ephemeral no-tools CLI boundary', () => {
    const args = buildIsolatedCodexArgs({
      cwd: '/tmp/isolated',
      model: 'gpt-5.6-terra',
      permissionMode: 'readonly',
      outputSchema: { type: 'object' },
    }, '/tmp/isolated/schema.json');
    const joined = args.join(' ');

    expect(joined).toContain('exec --json --ephemeral');
    expect(joined).toContain('--ignore-user-config');
    expect(joined).toContain('--ignore-rules');
    expect(joined).toContain('--skip-git-repo-check');
    expect(joined).toContain('--sandbox read-only');
    expect(joined).toContain('--cd /tmp/isolated');
    expect(joined).toContain('--output-schema /tmp/isolated/schema.json');
    expect(joined).toContain('--model gpt-5.6-terra');
    expect(joined).toContain('approval_policy=\"never\"');
    expect(joined).toContain('mcp_servers={}');
    expect(joined).toContain('web_search=\"disabled\"');
    expect(joined).toContain('--disable shell_tool');
    expect(joined).toContain('--disable unified_exec');
    expect(joined).toContain('--disable apps');
    expect(args.at(-1)).toBe('-');
  });

  it.each([
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'web_search',
    'error',
    'todo_list',
    'future_read_tool',
  ])('fails closed for tool-like item type %s', (type) => {
    expect(() => assertValidIsolatedCodexEvent({
      type: 'item.started',
      item: { id: 'item-1', type },
    })).toThrow(`forbidden item type "${type}"`);
  });

  it.each(['agent_message', 'reasoning'])(
    'accepts response-only item type %s',
    (type) => {
      expect(() => assertValidIsolatedCodexEvent({
        type: 'item.completed',
        item: { id: 'item-1', type, text: '{}' },
      })).not.toThrow();
    },
  );

  it.each([
    'thread.started',
    'turn.started',
    'turn.completed',
  ])('accepts required non-item event type %s', (type) => {
    expect(() => assertValidIsolatedCodexEvent({ type })).not.toThrow();
  });

  it.each(['error', 'future.event'])(
    'fails closed for top-level event type %s',
    (type) => {
      expect(() => assertValidIsolatedCodexEvent({ type }))
        .toThrow(`forbidden event type "${type}"`);
    },
  );

  it.each([
    null,
    {},
    { type: 'item.started' },
    { type: 'item.updated', item: null },
    { type: 'item.completed', item: {} },
  ])('fails closed for malformed event %#', (event) => {
    expect(() => assertValidIsolatedCodexEvent(event)).toThrow();
  });

  it('always rejects turn.failed with the provider message', () => {
    expect(() => assertValidIsolatedCodexEvent({
      type: 'turn.failed',
      error: { message: 'provider turn failed' },
    })).toThrow('provider turn failed');
  });

  it('does not write a schema or spawn when already aborted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-isolated-pre-abort-'));
    const controller = new AbortController();
    controller.abort(new Error('already aborted'));
    try {
      const response = await callCodexIsolatedStructured('normalizer', 'report', {
        cwd,
        model: 'test-model',
        outputSchema: { type: 'object' },
        abortSignal: controller.signal,
        codexPathOverride: join(cwd, 'must-not-spawn'),
      });

      expect(response.status).toBe('error');
      expect(response.error).toContain('already aborted');
      expect(existsSync(join(cwd, '.takt-isolated-output-schema.json'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not miss an abort that races with listener registration', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-isolated-abort-race-'));
    const executable = join(cwd, 'fake-codex');
    writeFileSync(executable, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 });
    let aborted = false;
    const signal = {
      get aborted() {
        return aborted;
      },
      addEventListener() {
        aborted = true;
      },
      removeEventListener() {},
      throwIfAborted() {
        if (aborted) {
          throw new Error('racing abort');
        }
      },
    } as unknown as AbortSignal;

    try {
      const response = await callCodexIsolatedStructured('normalizer', 'report', {
        cwd,
        model: 'test-model',
        outputSchema: { type: 'object' },
        abortSignal: signal,
        codexPathOverride: executable,
      });

      expect(response.status).toBe('error');
      expect(response.error).toContain('racing abort');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('leaves an exactly 8192-byte failure unchanged without creating the failure directory', async () => {
    const fixture = createFailureCodex('exact');
    const failureDir = join(fixture.cwd, 'failures');
    const expectedMessage = 'x'.repeat(MAX_AGENT_FAILURE_MESSAGE_BYTES);
    try {
      const response = await callCodexIsolatedStructured(
        'normalizer',
        'report',
        failureOptions(fixture, failureDir),
      );

      expect(response.status).toBe('error');
      expect(response.error).toBe(expectedMessage);
      expect(Buffer.byteLength(response.error ?? '', 'utf8')).toBe(MAX_AGENT_FAILURE_MESSAGE_BYTES);
      expect(existsSync(failureDir)).toBe(false);
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true });
    }
  });

  it('persists the complete multibyte failure and returns a bounded marker response', async () => {
    const fixture = createFailureCodex('multibyte');
    const failureDir = join(fixture.cwd, 'failures');
    const expectedMessage = '界'.repeat(5000);
    try {
      const response = await callCodexIsolatedStructured(
        'normalizer',
        'report',
        failureOptions(fixture, failureDir),
      );

      expect(response.status).toBe('error');
      const fullTextPath = assertExactTruncation(response.error ?? '', expectedMessage);
      const absoluteFullTextPath = resolve(fixture.cwd, fullTextPath);
      expect(relative(resolve(fixture.cwd), absoluteFullTextPath)).not.toMatch(
        /^(?:\.\.(?:[\\/]|$)|[\\/])/u,
      );
      expect(readdirSync(failureDir)).toEqual([basename(absoluteFullTextPath)]);
      expect(readFileSync(absoluteFullTextPath, 'utf8')).toBe(expectedMessage);
      expect(statSync(absoluteFullTextPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true });
    }
  });

  it('bounds and persists an oversized rate-limit failure response', async () => {
    const fixture = createFailureCodex('rate-limit');
    const failureDir = join(fixture.cwd, 'failures');
    const expectedMessage = `rate limit exceeded: ${'界'.repeat(5000)}`;
    try {
      const response = await callCodexIsolatedStructured(
        'normalizer',
        'report',
        failureOptions(fixture, failureDir),
      );

      expect(response.status).toBe('rate_limited');
      expect(response.content).toBe('');
      const fullTextPath = assertExactTruncation(response.error ?? '', expectedMessage);
      expect(readFileSync(resolve(fixture.cwd, fullTextPath), 'utf8')).toBe(expectedMessage);
      expect(statSync(resolve(fixture.cwd, fullTextPath)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true });
    }
  });

  it('returns a pathless bounded failure when the failure directory cannot be written', async () => {
    const fixture = createFailureCodex('multibyte');
    const failureDir = join(fixture.cwd, 'failures');
    writeFileSync(failureDir, 'not a directory', 'utf8');
    try {
      const response = await callCodexIsolatedStructured(
        'normalizer',
        'report',
        failureOptions(fixture, failureDir),
      );

      expect(response.status).toBe('error');
      expect(Buffer.byteLength(response.error ?? '', 'utf8')).toBeLessThanOrEqual(
        MAX_AGENT_FAILURE_MESSAGE_BYTES,
      );
      expect(response.error).toMatch(/\[TRUNCATED: \d+ bytes\]$/u);
      expect(response.error).not.toContain('full text:');
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported provider when invoked', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-isolated-provider-project-'));
    const globalDir = mkdtempSync(join(tmpdir(), 'takt-isolated-provider-global-'));
    const originalConfigDir = process.env.TAKT_CONFIG_DIR;
    try {
      process.env.TAKT_CONFIG_DIR = globalDir;
      writeFileSync(join(globalDir, 'config.yaml'), 'language: en\n');
      invalidateGlobalConfigCache();
      invalidateAllResolvedConfigCache();

      const response = await runAgent(undefined, 'normalize', {
        cwd: projectDir,
        executionProfile: 'isolated-structured',
        resolvedProvider: 'copilot',
        resolvedModel: 'test-model',
        resolvedProviderOptions: null,
        outputSchema: { type: 'object' },
      });
      expect(response.status).toBe('error');
      expect(response.error).toBe(
        'Provider "copilot" does not support isolated structured execution',
      );
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.TAKT_CONFIG_DIR;
      } else {
        process.env.TAKT_CONFIG_DIR = originalConfigDir;
      }
      invalidateGlobalConfigCache();
      invalidateAllResolvedConfigCache();
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
    }
  });
});
