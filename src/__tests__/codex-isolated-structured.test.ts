import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../agents/runner.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import {
  assertValidIsolatedCodexEvent,
  buildIsolatedCodexArgs,
  callCodexIsolatedStructured,
} from '../infra/codex/isolated-structured-client.js';

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
