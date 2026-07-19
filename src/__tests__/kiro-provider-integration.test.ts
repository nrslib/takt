import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { KiroProvider } from '../infra/providers/kiro.js';

type MockChildProcess = EventEmitter & {
  stdin: { end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = { end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

function mockSpawnSuccess(stdout: string): void {
  mockSpawn.mockImplementation(() => {
    const child = createMockChildProcess();

    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(stdout, 'utf-8'));
      child.emit('close', 0, null);
    });

    return child;
  });
}

describe('KiroProvider integration', () => {
  const originalConfigDir = process.env.TAKT_CONFIG_DIR;
  const originalKiroApiKey = process.env.KIRO_API_KEY;
  const originalTaktKiroApiKey = process.env.TAKT_KIRO_API_KEY;
  const originalTaktKiroCliPath = process.env.TAKT_KIRO_CLI_PATH;
  let testDir: string;
  let taktDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-kiro-provider-integration-${randomUUID()}`);
    taktDir = join(testDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    process.env.TAKT_CONFIG_DIR = taktDir;
    delete process.env.KIRO_API_KEY;
    delete process.env.TAKT_KIRO_API_KEY;
    delete process.env.TAKT_KIRO_CLI_PATH;
    mockSpawn.mockReset();
    invalidateGlobalConfigCache();
  });

  afterEach(() => {
    if (originalConfigDir !== undefined) {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.TAKT_CONFIG_DIR;
    }
    if (originalKiroApiKey !== undefined) {
      process.env.KIRO_API_KEY = originalKiroApiKey;
    } else {
      delete process.env.KIRO_API_KEY;
    }
    if (originalTaktKiroApiKey !== undefined) {
      process.env.TAKT_KIRO_API_KEY = originalTaktKiroApiKey;
    } else {
      delete process.env.TAKT_KIRO_API_KEY;
    }
    if (originalTaktKiroCliPath !== undefined) {
      process.env.TAKT_KIRO_CLI_PATH = originalTaktKiroCliPath;
    } else {
      delete process.env.TAKT_KIRO_CLI_PATH;
    }
    invalidateGlobalConfigCache();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('Given Kiro global config, When provider agent calls real client, Then resolved key and path reach spawn', async () => {
    const kiroCliPath = join(testDir, 'kiro-cli');
    writeFileSync(kiroCliPath, '#!/bin/sh\necho kiro\n', 'utf-8');
    chmodSync(kiroCliPath, 0o755);
    writeFileSync(
      join(taktDir, 'config.yaml'),
      [
        'language: en',
        'provider: kiro',
        `kiro_cli_path: ${kiroCliPath}`,
        'kiro_api_key: kiro-chain-key',
      ].join('\n'),
      'utf-8',
    );
    mockSpawnSuccess('chain ok');

    const provider = new KiroProvider();
    const agent = provider.setup({
      name: 'coder',
      systemPrompt: 'System instructions',
    });

    const result = await agent.call('implement & verify | summarize', {
      cwd: testDir,
      permissionMode: 'edit',
      sessionId: 'sess-chain',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('chain ok');

    const [command, args, options] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean },
    ];
    const child = mockSpawn.mock.results[0]?.value as MockChildProcess;
    expect(command).toBe(kiroCliPath);
    expect(args).toEqual([
      'chat',
      '--no-interactive',
      '--trust-tools=read,grep,write,shell',
      '--resume-id',
      'sess-chain',
      'System instructions\n\nimplement & verify | summarize',
    ]);
    expect(options.cwd).toBe(testDir);
    expect(options.env?.KIRO_API_KEY).toBe('kiro-chain-key');
    expect(options.shell).toBeUndefined();
    expect(child.stdin.end).toHaveBeenCalledWith();
  });

  it('Given providerOptions.kiro.agent, When provider agent calls real client, Then --agent reaches spawn args', async () => {
    writeFileSync(
      join(taktDir, 'config.yaml'),
      [
        'language: en',
        'provider: kiro',
      ].join('\n'),
      'utf-8',
    );
    mockSpawnSuccess('agent ok');

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'planner' });

    const result = await agent.call('plan the feature', {
      cwd: testDir,
      permissionMode: 'readonly',
      providerOptions: {
        kiro: { agent: 'planner-agent' },
      },
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('agent ok');

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const agentFlagIndex = args.indexOf('--agent');
    expect(agentFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[agentFlagIndex + 1]).toBe('planner-agent');
    expect(args.at(-1)).toBe('plan the feature');
  });

  it('Given no session ID, When provider agent calls the real client and succeeds, Then resolves the session ID via a second --list-sessions spawn (issue #781)', async () => {
    const kiroCliPath = join(testDir, 'kiro-cli');
    writeFileSync(kiroCliPath, '#!/bin/sh\necho kiro\n', 'utf-8');
    chmodSync(kiroCliPath, 0o755);
    writeFileSync(
      join(taktDir, 'config.yaml'),
      [
        'language: en',
        'provider: kiro',
        `kiro_cli_path: ${kiroCliPath}`,
      ].join('\n'),
      'utf-8',
    );

    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    mockSpawn
      .mockImplementationOnce(() => {
        const child = createMockChildProcess();
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('turn one result', 'utf-8'));
          child.emit('close', 0, null);
        });
        return child;
      })
      .mockImplementationOnce(() => {
        const child = createMockChildProcess();
        queueMicrotask(() => {
          child.stderr.emit('data', Buffer.from(`${uuid}  updated just now`, 'utf-8'));
          child.emit('close', 0, null);
        });
        return child;
      });

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'coder' });

    const result = await agent.call('implement feature', {
      cwd: testDir,
      permissionMode: 'edit',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('turn one result');
    expect(result.sessionId).toBe(uuid);
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    const [, secondArgs, secondOptions] = mockSpawn.mock.calls[1] as [
      string,
      string[],
      { cwd?: string },
    ];
    expect(secondArgs).toEqual(['chat', '--list-sessions']);
    expect(secondOptions.cwd).toBe(testDir);
  });

  it('Given no providerOptions, When provider agent calls real client, Then spawn args have no --agent flag', async () => {
    writeFileSync(
      join(taktDir, 'config.yaml'),
      [
        'language: en',
        'provider: kiro',
      ].join('\n'),
      'utf-8',
    );
    mockSpawnSuccess('default agent ok');

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'coder' });

    const result = await agent.call('implement', {
      cwd: testDir,
      permissionMode: 'readonly',
    });

    expect(result.status).toBe('done');
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--agent');
  });

  it('Given a resolved model, When provider agent calls real client, Then --model reaches spawn args', async () => {
    writeFileSync(
      join(taktDir, 'config.yaml'),
      [
        'language: en',
        'provider: kiro',
      ].join('\n'),
      'utf-8',
    );
    mockSpawnSuccess('model ok');

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'coder' });

    const result = await agent.call('implement', {
      cwd: testDir,
      permissionMode: 'readonly',
      model: 'claude-3-opus',
    });

    expect(result.status).toBe('done');
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const modelFlagIndex = args.indexOf('--model');
    expect(modelFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[modelFlagIndex + 1]).toBe('claude-3-opus');
  });

  it('Given no model, When provider agent calls real client, Then spawn args have no --model flag', async () => {
    writeFileSync(
      join(taktDir, 'config.yaml'),
      [
        'language: en',
        'provider: kiro',
      ].join('\n'),
      'utf-8',
    );
    mockSpawnSuccess('no model ok');

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'coder' });

    const result = await agent.call('implement', {
      cwd: testDir,
      permissionMode: 'readonly',
    });

    expect(result.status).toBe('done');
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--model');
  });
});
