import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { terminateFailure, exitWithoutCause } = vi.hoisted(() => ({
  terminateFailure: { enabled: false },
  exitWithoutCause: { enabled: false },
}));

vi.mock('../shared/utils/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/spawn.js')>();
  return {
    ...actual,
    spawnManagedProcess: (...args: Parameters<typeof actual.spawnManagedProcess>) => {
      const managed = actual.spawnManagedProcess(...args);
      return {
        ...managed,
        async wait(): ReturnType<typeof managed.wait> {
          const result = await managed.wait();
          return exitWithoutCause.enabled ? { code: null, signal: null } : result;
        },
        async terminate(): Promise<void> {
          await managed.terminate();
          if (terminateFailure.enabled) {
            throw new Error('injected terminate failure');
          }
        },
      };
    },
  };
});

import { CodexClient } from '../infra/codex/client.js';
import { executeIsolatedStructuredInternalAgent } from '../agents/agent-usecases.js';
import { createStrictCodexExecutionProfile } from '../infra/codex/strict-execution-profile.js';

interface FakeCodexObservation {
  readonly args: string[];
  readonly prompt: string;
  readonly workspacePath: string;
  readonly workspaceEntries: string[];
  readonly workspaceMode: number;
  readonly schemaPath: string;
  readonly schema: Record<string, unknown>;
  readonly schemaMode: number;
  readonly homePath: string;
  readonly codexHomePath: string;
  readonly homeEntries: string[];
  readonly codexHomeEntries: string[];
  readonly hasApiKey: boolean;
  readonly authMode?: number;
}

const temporaryDirectories: string[] = [];

function createFakeCodex(): {
  readonly executablePath: string;
  readonly logPath: string;
  readonly readyPath: string;
  readonly modePath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'takt-codex-isolation-test-'));
  temporaryDirectories.push(directory);
  const executablePath = join(directory, 'fake-codex.mjs');
  const logPath = join(directory, 'calls.jsonl');
  const readyPath = join(directory, 'ready');
  const modePath = join(directory, 'mode');
  writeFileSync(executablePath, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  prompt += chunk;
}
const args = process.argv.slice(2);
const workspacePath = args[args.indexOf('--cd') + 1];
const schemaPath = args[args.indexOf('--output-schema') + 1];
const logPath = ${JSON.stringify(logPath)};
const readyPath = ${JSON.stringify(readyPath)};
const modePath = ${JSON.stringify(modePath)};
const observation = {
  args,
  prompt,
  workspacePath,
  workspaceEntries: readdirSync(workspacePath),
  workspaceMode: statSync(workspacePath).mode & 0o777,
  schemaPath,
  schema: JSON.parse(readFileSync(schemaPath, 'utf8')),
  schemaMode: statSync(schemaPath).mode & 0o777,
  homePath: process.env.HOME,
  codexHomePath: process.env.CODEX_HOME,
  homeEntries: readdirSync(process.env.HOME),
  codexHomeEntries: readdirSync(process.env.CODEX_HOME),
  hasApiKey: process.env.CODEX_API_KEY !== undefined,
  authMode: existsSync(process.env.CODEX_HOME + '/auth.json')
    ? statSync(process.env.CODEX_HOME + '/auth.json').mode & 0o777
    : undefined,
};
appendFileSync(logPath, JSON.stringify(observation) + '\\n');
const attempts = readFileSync(logPath, 'utf8').trim().split('\\n').length;
const mode = readFileSync(modePath, 'utf8');
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
emit({ type: 'thread.started', thread_id: 'isolated-thread-' + attempts });
if (mode === 'abort') {
  const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.on('SIGTERM', () => {});
  writeFileSync(readyPath, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
  setInterval(() => {}, 1000);
} else if (mode === 'invalid-json') {
  process.stdout.write('not-json\\n');
} else if (mode === 'error') {
  emit({ type: 'turn.failed', error: { message: 'permanent isolated failure' } });
} else if (mode === 'retry' && attempts === 1) {
  emit({ type: 'turn.failed', error: { message: 'network error' } });
} else if (mode === 'leader-exit-error') {
  const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] });
  writeFileSync(readyPath, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
  process.exit(7);
} else if (mode === 'leader-exit-success') {
  const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] });
  writeFileSync(readyPath, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
  emit({ type: 'item.completed', item: { id: 'message', type: 'agent_message', text: '{"selected_ids":[],"rationale":"done"}' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 7, cached_input_tokens: 3 } });
  process.exit(0);
} else {
  emit({ type: 'item.completed', item: { id: 'message', type: 'agent_message', text: '{"selected_ids":[],"rationale":"done"}' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 7, cached_input_tokens: 3 } });
}
`, { encoding: 'utf-8', mode: 0o700 });
  chmodSync(executablePath, 0o700);
  return { executablePath, logPath, readyPath, modePath };
}

function readObservations(path: string): FakeCodexObservation[] {
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as FakeCodexObservation);
}

function disabledFeatures(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => (
    arg === '--disable' && args[index + 1] !== undefined ? [args[index + 1]!] : []
  ));
}

function readRequestInstructions(body: Record<string, unknown>): string {
  if (typeof body.instructions !== 'string') {
    throw new Error('Captured Codex request must contain root instructions');
  }
  return body.instructions;
}

function readRequestInputTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.input)) {
    throw new Error('Captured Codex request must contain a root input array');
  }
  return body.input.flatMap((message) => {
    if (typeof message !== 'object' || message === null) {
      throw new Error('Captured Codex request input must contain message objects');
    }
    const { role, content } = message as Record<string, unknown>;
    if (typeof role !== 'string' || !Array.isArray(content)) {
      throw new Error('Captured Codex request input must contain messages with role and content');
    }
    return content.map((item) => {
      if (typeof item !== 'object' || item === null) {
        throw new Error('Captured Codex request content must contain objects');
      }
      const { type, text } = item as Record<string, unknown>;
      if (type !== 'input_text' || typeof text !== 'string') {
        throw new Error('Captured Codex request content must contain input_text values');
      }
      return text;
    });
  });
}

function collectCapabilityFieldNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectCapabilityFieldNames);
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => [
    ...(/plugin|skill|capabilit|mcp/i.test(key) ? [key] : []),
    ...collectCapabilityFieldNames(child),
  ]);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function isolatedOptions(
  fake: ReturnType<typeof createFakeCodex>,
  mode: 'success' | 'error' | 'abort' | 'retry' | 'invalid-json' | 'leader-exit-error' | 'leader-exit-success',
  abortSignal?: AbortSignal,
) {
  writeFileSync(fake.modePath, mode);
  return {
    cwd: '/original/project',
    abortSignal,
    internalAgentIsolation: 'strict-readonly' as const,
    permissionMode: 'full' as const,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['selected_ids', 'rationale'],
    },
    model: 'gpt-test',
    reasoningEffort: 'medium' as const,
    baseUrl: 'https://example.test/v1',
    networkAccess: true,
    openaiApiKey: 'explicit-test-key',
    codexPathOverride: fake.executablePath,
  };
}

function useDedicatedProfileTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-codex-profile-tmp-'));
  temporaryDirectories.push(root);
  vi.stubEnv('TMPDIR', root);
  vi.stubEnv('TEMP', root);
  vi.stubEnv('TMP', root);
  return root;
}

afterEach(() => {
  terminateFailure.enabled = false;
  exitWithoutCause.enabled = false;
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CodexClient strict read-only isolation', () => {
  it('should execute the isolated CLI with private inputs and preserve structured output and usage', async () => {
    const fake = createFakeCodex();
    const client = new CodexClient();
    const ambientRoot = mkdtempSync(join(tmpdir(), 'takt-codex-ambient-'));
    temporaryDirectories.push(ambientRoot);
    const ambientHome = join(ambientRoot, 'home');
    const ambientCodexHome = join(ambientRoot, 'codex-home');
    mkdirSync(ambientHome);
    mkdirSync(ambientCodexHome);
    writeFileSync(join(ambientHome, 'AGENTS.md'), 'ambient-home-sentinel');
    writeFileSync(join(ambientCodexHome, 'AGENTS.md'), 'ambient-codex-sentinel');
    writeFileSync(join(ambientCodexHome, 'config.toml'), '[features]\nplugins = true\napps = true\n');
    vi.stubEnv('HOME', ambientHome);
    vi.stubEnv('CODEX_HOME', ambientCodexHome);

    const result = await client.callCustom(
      'selector',
      'Choose reviewers.',
      'Return only the schema.',
      isolatedOptions(fake, 'success'),
    );

    expect(result).toMatchObject({
      status: 'done',
      structuredOutput: { selected_ids: [], rationale: 'done' },
      providerUsage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        cachedInputTokens: 3,
        usageMissing: false,
      },
    });
    const [call] = readObservations(fake.logPath);
    expect(call?.prompt).toBe('Return only the schema.\n\nChoose reviewers.');
    expect(call?.args).toEqual(expect.arrayContaining([
      'exec',
      '--json',
      '--strict-config',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      'approval_policy="never"',
      '--model',
      'gpt-test',
      'model_reasoning_effort="medium"',
      'openai_base_url="https://example.test/v1"',
      'sandbox_workspace_write.network_access=true',
    ]));
    expect(disabledFeatures(call!.args)).toEqual(expect.arrayContaining([
      'apps',
      'browser_use',
      'computer_use',
      'in_app_browser',
      'multi_agent',
      'plugins',
      'remote_plugin',
      'shell_tool',
      'unified_exec',
    ]));
    expect(call?.args).not.toContain('resume');
    expect(call?.args).not.toContain('/original/project');
    expect(call?.workspaceEntries).toEqual([]);
    expect(call?.homeEntries).toEqual([]);
    expect(call?.codexHomeEntries).toEqual([]);
    expect(call?.homePath).not.toBe(ambientHome);
    expect(call?.codexHomePath).not.toBe(ambientCodexHome);
    expect(call?.hasApiKey).toBe(true);
    expect(call?.schema).toEqual(isolatedOptions(fake, 'success').outputSchema);
    if (process.platform !== 'win32') {
      expect(call?.workspaceMode).toBe(0o700);
      expect(call?.schemaMode).toBe(0o600);
    }
    expect(existsSync(call!.workspacePath)).toBe(false);
    expect(existsSync(dirname(call!.workspacePath))).toBe(false);
  });

  it('should clean private assets after a terminal provider error', async () => {
    const fake = createFakeCodex();

    const result = await new CodexClient().call(
      'selector',
      'Choose reviewers.',
      isolatedOptions(fake, 'error'),
    );

    expect(result).toMatchObject({
      status: 'error',
      error: 'permanent isolated failure',
    });
    const [call] = readObservations(fake.logPath);
    expect(existsSync(dirname(call!.workspacePath))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'should detect a non-zero leader exit before descendant-held stdout closes',
    async () => {
      const fake = createFakeCodex();
      const profileTempRoot = useDedicatedProfileTempRoot();
      const call = new CodexClient().call(
        'selector',
        'Choose reviewers.',
        isolatedOptions(fake, 'leader-exit-error', AbortSignal.timeout(2_000)),
      );
      await vi.waitFor(() => expect(existsSync(fake.readyPath)).toBe(true));
      const pids = JSON.parse(readFileSync(fake.readyPath, 'utf-8')) as {
        child: number;
        grandchild: number;
      };

      try {
        const result = await call;

        expect(result).toMatchObject({
          status: 'error',
          error: expect.stringContaining('code 7'),
        });
        expect(readdirSync(profileTempRoot)).toEqual([]);
        await vi.waitFor(() => {
          expect(isProcessRunning(pids.child)).toBe(false);
          expect(isProcessRunning(pids.grandchild)).toBe(false);
        });
      } finally {
        try {
          process.kill(-pids.child, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
        }
      }
    },
    5_000,
  );

  it.skipIf(process.platform === 'win32')(
    'should finish a successful leader exit while preserving buffered events and reclaiming descendants',
    async () => {
      const fake = createFakeCodex();
      const profileTempRoot = useDedicatedProfileTempRoot();
      const call = new CodexClient().call(
        'selector',
        'Choose reviewers.',
        isolatedOptions(fake, 'leader-exit-success'),
      );
      await vi.waitFor(() => expect(existsSync(fake.readyPath)).toBe(true));
      const pids = JSON.parse(readFileSync(fake.readyPath, 'utf-8')) as {
        child: number;
        grandchild: number;
      };

      try {
        const result = await call;

        expect(result).toMatchObject({
          status: 'done',
          structuredOutput: { selected_ids: [], rationale: 'done' },
          providerUsage: {
            inputTokens: 11,
            outputTokens: 7,
            totalTokens: 18,
          },
        });
        expect(readdirSync(profileTempRoot)).toEqual([]);
        await vi.waitFor(() => {
          expect(isProcessRunning(pids.child)).toBe(false);
          expect(isProcessRunning(pids.grandchild)).toBe(false);
        });
      } finally {
        try {
          process.kill(-pids.child, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
        }
      }
    },
    5_000,
  );

  it('should report a missing Codex exit cause without inventing an exit code', async () => {
    const fake = createFakeCodex();
    exitWithoutCause.enabled = true;

    const result = await new CodexClient().call(
      'selector',
      'Choose reviewers.',
      isolatedOptions(fake, 'success'),
    );

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('no exit code or signal'),
    });
    expect(result.error).not.toContain('code 1');
  });

  it('should terminate the isolated child and clean private assets after external abort', async () => {
    const fake = createFakeCodex();
    const controller = new AbortController();
    const call = new CodexClient().call(
      'selector',
      'Choose reviewers.',
      isolatedOptions(fake, 'abort', controller.signal),
    );
    await vi.waitFor(() => expect(existsSync(fake.readyPath)).toBe(true));
    const pids = JSON.parse(readFileSync(fake.readyPath, 'utf-8')) as {
      child: number;
      grandchild: number;
    };

    controller.abort(new Error('selector cancelled'));
    const result = await call;

    expect(result).toMatchObject({
      status: 'error',
      failureCategory: 'external_abort',
    });
    const [observation] = readObservations(fake.logPath);
    expect(existsSync(dirname(observation!.workspacePath))).toBe(false);
    await vi.waitFor(() => {
      expect(isProcessRunning(pids.child)).toBe(false);
      expect(isProcessRunning(pids.grandchild)).toBe(false);
    });
  });

  it('should propagate explicit network and Skill scopes into strict CLI config', async () => {
    const fake = createFakeCodex();
    const root = mkdtempSync(join(tmpdir(), 'takt-codex-explicit-skills-'));
    temporaryDirectories.push(root);
    const repoSkill = join(root, '.agents', 'skills', 'repo-review', 'SKILL.md');
    const userHome = join(root, 'home');
    const userSkill = join(userHome, '.agents', 'skills', 'user-review', 'SKILL.md');
    mkdirSync(dirname(repoSkill), { recursive: true });
    mkdirSync(dirname(userSkill), { recursive: true });
    mkdirSync(join(root, '.git'));
    writeFileSync(repoSkill, '# repo');
    writeFileSync(userSkill, '# user');
    vi.stubEnv('HOME', userHome);

    const result = await new CodexClient().call('selector', 'Choose reviewers.', {
      ...isolatedOptions(fake, 'success'),
      cwd: root,
      networkAccess: false,
      skills: { repo: true, user: true },
    });

    expect(result.status).toBe('done');
    const [observation] = readObservations(fake.logPath);
    expect(observation?.args).toContain('sandbox_workspace_write.network_access=false');
    const skillConfig = observation?.args.find((arg) => arg.startsWith('skills.config='));
    expect(skillConfig).toContain(`${observation?.codexHomePath}/skills/explicit-1/SKILL.md`);
    expect(skillConfig).toContain(`${observation?.codexHomePath}/skills/explicit-2/SKILL.md`);
    expect(skillConfig).not.toContain(repoSkill);
    expect(skillConfig).not.toContain(userSkill);
    expect(skillConfig).toContain('enabled = true');
    expect(observation?.codexHomeEntries).toEqual(['skills']);
  });

  it('should copy only a safe auth file when no explicit API key is provided', async () => {
    const fake = createFakeCodex();
    const ambientCodexHome = mkdtempSync(join(tmpdir(), 'takt-codex-auth-source-'));
    temporaryDirectories.push(ambientCodexHome);
    writeFileSync(join(ambientCodexHome, 'auth.json'), '{"tokens":{"access_token":"secret"}}', {
      mode: 0o600,
    });
    writeFileSync(join(ambientCodexHome, 'AGENTS.md'), 'must not be copied');
    vi.stubEnv('CODEX_HOME', ambientCodexHome);

    const result = await new CodexClient().call('selector', 'Choose reviewers.', {
      ...isolatedOptions(fake, 'success'),
      openaiApiKey: undefined,
    });

    expect(result.status).toBe('done');
    const [observation] = readObservations(fake.logPath);
    expect(observation?.hasApiKey).toBe(false);
    expect(observation?.codexHomeEntries).toEqual(['auth.json']);
    if (process.platform !== 'win32') {
      expect(observation?.authMode).toBe(0o600);
    }
  });

  it('should fail before spawning when neither explicit nor safely copyable auth exists', async () => {
    const fake = createFakeCodex();
    const ambientCodexHome = mkdtempSync(join(tmpdir(), 'takt-codex-no-auth-'));
    temporaryDirectories.push(ambientCodexHome);
    const profileTempRoot = useDedicatedProfileTempRoot();
    vi.stubEnv('CODEX_HOME', ambientCodexHome);

    const result = await new CodexClient().call('selector', 'Choose reviewers.', {
      ...isolatedOptions(fake, 'success'),
      openaiApiKey: undefined,
    });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('requires an explicit API key or an isolated copy of auth.json'),
    });
    expect(existsSync(fake.logPath)).toBe(false);
    expect(readdirSync(profileTempRoot)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'should reject a symlinked ambient auth file before spawning',
    async () => {
      const fake = createFakeCodex();
      const ambientCodexHome = mkdtempSync(join(tmpdir(), 'takt-codex-symlink-auth-'));
      temporaryDirectories.push(ambientCodexHome);
      const target = join(ambientCodexHome, 'target.json');
      writeFileSync(target, '{"tokens":{"access_token":"secret"}}', { mode: 0o600 });
      symlinkSync(target, join(ambientCodexHome, 'auth.json'));
      vi.stubEnv('CODEX_HOME', ambientCodexHome);

      const result = await new CodexClient().call('selector', 'Choose reviewers.', {
        ...isolatedOptions(fake, 'success'),
        openaiApiKey: undefined,
      });

      expect(result).toMatchObject({
        status: 'error',
        error: expect.stringContaining('requires an explicit API key or an isolated copy of auth.json'),
      });
      expect(existsSync(fake.logPath)).toBe(false);
    },
  );

  it('should reject a blank model and clean profile assets before spawning', async () => {
    const fake = createFakeCodex();

    const result = await new CodexClient().call('selector', 'Choose reviewers.', {
      ...isolatedOptions(fake, 'success'),
      model: '   ',
    });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('model must not be empty'),
    });
    expect(existsSync(fake.logPath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'should clean profile assets when an explicit Skill contains a symbolic link',
    async () => {
      const fake = createFakeCodex();
      const projectRoot = mkdtempSync(join(tmpdir(), 'takt-codex-symlink-skill-'));
      temporaryDirectories.push(projectRoot);
      const profileTempRoot = useDedicatedProfileTempRoot();
      const skillRoot = join(projectRoot, '.agents', 'skills', 'repo-review');
      mkdirSync(skillRoot, { recursive: true });
      mkdirSync(join(projectRoot, '.git'));
      writeFileSync(join(skillRoot, 'SKILL.md'), '# repo review');
      symlinkSync(join(skillRoot, 'SKILL.md'), join(skillRoot, 'linked.md'));

      const result = await new CodexClient().call('selector', 'Choose reviewers.', {
        ...isolatedOptions(fake, 'success'),
        cwd: projectRoot,
        skills: { repo: true, user: false },
      });

      expect(result).toMatchObject({
        status: 'error',
        error: expect.stringContaining('cannot contain a symbolic link'),
      });
      expect(existsSync(fake.logPath)).toBe(false);
      expect(readdirSync(profileTempRoot)).toEqual([]);
    },
  );

  it('should clean profile assets when output schema serialization fails', async () => {
    const fake = createFakeCodex();
    const profileTempRoot = useDedicatedProfileTempRoot();
    const circularSchema: Record<string, unknown> = { type: 'object' };
    circularSchema.self = circularSchema;

    const result = await new CodexClient().call('selector', 'Choose reviewers.', {
      ...isolatedOptions(fake, 'success'),
      outputSchema: circularSchema,
    });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('circular structure'),
    });
    expect(existsSync(fake.logPath)).toBe(false);
    expect(readdirSync(profileTempRoot)).toEqual([]);
  });

  it('should clean profile assets and retain the execution error when process termination fails', async () => {
    const fake = createFakeCodex();
    const profileTempRoot = useDedicatedProfileTempRoot();
    terminateFailure.enabled = true;

    const result = await new CodexClient().call(
      'selector',
      'Choose reviewers.',
      isolatedOptions(fake, 'invalid-json'),
    );

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Failed to parse isolated Codex event'),
    });
    expect(readdirSync(profileTempRoot)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'should settle and clean profile assets when process-group termination fails',
    async () => {
      const fake = createFakeCodex();
      const profileTempRoot = useDedicatedProfileTempRoot();
      const controller = new AbortController();
      const call = new CodexClient().call(
        'selector',
        'Choose reviewers.',
        isolatedOptions(fake, 'abort', controller.signal),
      );
      await vi.waitFor(() => expect(existsSync(fake.readyPath)).toBe(true));
      const pids = JSON.parse(readFileSync(fake.readyPath, 'utf-8')) as {
        child: number;
        grandchild: number;
      };
      const originalKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (target === -pids.child && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
          const error = new Error('process-group signal denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return originalKill(target, signal);
      });

      try {
        controller.abort(new Error('selector cancelled'));
        const result = await call;

        expect(result).toMatchObject({
          status: 'error',
          failureCategory: 'external_abort',
        });
        expect(readdirSync(profileTempRoot)).toEqual([]);
      } finally {
        killSpy.mockRestore();
        try {
          process.kill(-pids.child, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
        }
        await vi.waitFor(() => {
          expect(isProcessRunning(pids.child)).toBe(false);
          expect(isProcessRunning(pids.grandchild)).toBe(false);
        });
      }
    },
    5_000,
  );

  it('should keep ambient instructions and capabilities out of the real Codex request', async (context) => {
    const ambientRoot = mkdtempSync(join(tmpdir(), 'takt-codex-real-ambient-'));
    temporaryDirectories.push(ambientRoot);
    const ambientHome = join(ambientRoot, 'home');
    const ambientCodexHome = join(ambientRoot, 'codex-home');
    const explicitSkillPath = join(
      ambientRoot,
      '.agents',
      'skills',
      'explicit-selector-skill',
      'SKILL.md',
    );
    mkdirSync(join(ambientHome, '.agents', 'skills', 'ambient-skill'), { recursive: true });
    mkdirSync(ambientCodexHome);
    mkdirSync(dirname(explicitSkillPath), { recursive: true });
    mkdirSync(join(ambientRoot, '.git'));
    const agentsSentinel = 'GLOBAL_AGENTS_SENTINEL_MUST_NOT_REACH_REQUEST';
    const skillSentinel = 'AMBIENT_SKILL_SENTINEL_MUST_NOT_REACH_REQUEST';
    const explicitSkillSentinel = 'EXPLICIT_SELECTOR_SKILL_MUST_REACH_REQUEST';
    writeFileSync(join(ambientHome, 'AGENTS.md'), agentsSentinel);
    writeFileSync(
      join(ambientHome, '.agents', 'skills', 'ambient-skill', 'SKILL.md'),
      skillSentinel,
    );
    writeFileSync(explicitSkillPath, [
      '---',
      'name: explicit-selector-skill',
      `description: ${explicitSkillSentinel}`,
      '---',
      '# Explicit selector skill',
    ].join('\n'));
    writeFileSync(join(ambientCodexHome, 'config.toml'), '[features]\nplugins = true\napps = true\n');
    vi.stubEnv('HOME', ambientHome);
    vi.stubEnv('CODEX_HOME', ambientCodexHome);

    const requestBodies: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>);
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'capture complete' } }));
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const handleError = (error: Error) => reject(error);
        server.once('error', handleError);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', handleError);
          resolve();
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip();
        return;
      }
      throw error;
    }
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Loopback capture server did not expose a TCP port');
      }
      vi.stubEnv('TAKT_OPENAI_API_KEY', 'loopback-test-key');
      const result = await executeIsolatedStructuredInternalAgent(
        'Internal selector instructions.',
        'Choose reviewers.',
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            selected_ids: { type: 'array', items: { type: 'string' } },
            rationale: { type: 'string' },
          },
          required: ['selected_ids', 'rationale'],
        },
        {
          cwd: ambientRoot,
          projectCwd: ambientRoot,
          resolution: {
            provider: 'codex',
            model: 'gpt-5',
            providerOptions: {
              codex: {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                skills: { repo: true, user: true },
              },
            },
          },
        },
      );

      expect(result.status).toBe('error');
      expect(requestBodies.length).toBeGreaterThan(0);
      for (const body of requestBodies) {
        const instructions = readRequestInstructions(body);
        const inputTexts = readRequestInputTexts(body);
        expect(inputTexts).toContain('Internal selector instructions.\n\nChoose reviewers.');
        for (const forbidden of [
          agentsSentinel,
          skillSentinel,
          'openai-docs',
          'skill-creator',
        ]) {
          const normalizedForbidden = forbidden.toLowerCase();
          expect(instructions.toLowerCase()).not.toContain(normalizedForbidden);
          for (const inputText of inputTexts) {
            expect(inputText.toLowerCase()).not.toContain(normalizedForbidden);
          }
        }
        expect(inputTexts.some((text) => text.includes(explicitSkillSentinel))).toBe(true);
        expect(collectCapabilityFieldNames(body)).toEqual([]);
        expect(Array.isArray(body.tools)).toBe(true);
        const toolNames = (body.tools as Array<Record<string, unknown>>)
          .map((tool) => tool.name ?? tool.type)
          .sort();
        expect(toolNames).toEqual([
          'request_user_input',
          'update_plan',
          'view_image',
          'web_search',
        ]);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 15_000);

  it('should disable strict selector features and expose no plugins in the isolated profile', () => {
    const fake = createFakeCodex();
    const profile = createStrictCodexExecutionProfile(isolatedOptions(fake, 'success'));
    const disableArgs = profile.args.flatMap((arg, index) =>
      arg === '--disable' && profile.args[index + 1] !== undefined
        ? ['--disable', profile.args[index + 1]!]
        : []);
    const require = createRequire(import.meta.url);
    const codexBin = require.resolve('@openai/codex/bin/codex.js');
    try {
      const features = execFileSync(
        process.execPath,
        [codexBin, ...disableArgs, 'features', 'list'],
        { env: profile.env, encoding: 'utf-8' },
      );
      for (const feature of disabledFeatures(profile.args)) {
        expect(features).toMatch(new RegExp(`^${feature}\\s+\\S+\\s+false$`, 'm'));
      }
      const plugins = JSON.parse(execFileSync(
        process.execPath,
        [codexBin, ...disableArgs, 'plugin', 'list', '--json'],
        { env: profile.env, encoding: 'utf-8' },
      )) as { installed: unknown[]; available: unknown[] };
      expect(plugins).toEqual({ installed: [], available: [] });
    } finally {
      profile.cleanup();
    }
  });

  it('should use a fresh isolated execution and clean both attempts when retrying', async () => {
    const fake = createFakeCodex();

    const result = await new CodexClient().call(
      'selector',
      'Choose reviewers.',
      isolatedOptions(fake, 'retry'),
    );

    expect(result.status).toBe('done');
    const observations = readObservations(fake.logPath);
    expect(observations).toHaveLength(2);
    expect(observations[0]?.workspacePath).not.toBe(observations[1]?.workspacePath);
    for (const observation of observations) {
      expect(existsSync(dirname(observation.workspacePath))).toBe(false);
    }
  });

  it('should fail before spawning when strict isolation receives a session to resume', async () => {
    const fake = createFakeCodex();

    const result = await new CodexClient().call('selector', 'Choose reviewers.', {
      ...isolatedOptions(fake, 'success'),
      sessionId: 'existing-session',
    });

    expect(result).toMatchObject({
      status: 'error',
      error: 'Strict read-only Codex execution cannot resume a session',
    });
    expect(existsSync(fake.logPath)).toBe(false);
  });
});
