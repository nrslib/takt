import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { callCodexCustom } = vi.hoisted(() => ({ callCodexCustom: vi.fn() }));
vi.mock('../infra/codex/index.js', () => ({ callCodexCustom, callCodex: vi.fn() }));
vi.mock('../infra/config/index.js', () => ({
  resolveOpenaiApiKey: vi.fn(() => undefined),
  resolveCodexCliPath: vi.fn(() => undefined),
}));

import { CodexProvider } from '../infra/providers/codex.js';

describe('Codex Phase 1 compaction handoff', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.clearAllMocks();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('keeps each call input in a private immutable file and points the developer instructions to it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-codex-handoff-'));
    directories.push(directory);
    callCodexCustom.mockResolvedValue({ persona: 'review-adjudication', status: 'done', content: 'ok' });
    const agent = new CodexProvider().setup({ name: 'review-adjudication', systemPrompt: 'current assignment' });
    const options = { cwd: directory, executionPhase: 1 as const, permissionMode: 'readonly' as const,
      edit: false, compactionHandoffDirectory: directory };
    await agent.call('current reports and notes', options);
    const [, firstInput, firstDeveloper] = callCodexCustom.mock.calls[0]!;
    const firstPath = (firstDeveloper as string).match(/Current call artifact: `([^`]+)`/)?.[1];
    expect(firstPath).toBeDefined();
    expect(JSON.parse(readFileSync(firstPath!, 'utf8'))).toEqual(JSON.parse(firstInput));
    expect(statSync(firstPath!).mode & 0o777).toBe(0o600);

    await agent.call('recovery with latest notes', { ...options, sessionId: 'same-session' });
    const [, secondInput, secondDeveloper] = callCodexCustom.mock.calls[1]!;
    const secondPath = (secondDeveloper as string).match(/Current call artifact: `([^`]+)`/)?.[1];
    expect(secondPath).toBeDefined();
    expect(secondPath).not.toBe(firstPath);
    expect(JSON.parse(readFileSync(secondPath!, 'utf8'))).toEqual(JSON.parse(secondInput));
    expect(JSON.parse(readFileSync(firstPath!, 'utf8'))).toEqual(JSON.parse(firstInput));

    await agent.call('Phase 2 report', { cwd: directory, executionPhase: 2 });
    const [, , phase2Developer] = callCodexCustom.mock.calls[2]!;
    expect(phase2Developer).not.toContain('Current call artifact:');
  });

  it.skipIf(process.getuid?.() === 0)('continues with inline instructions when the artifact directory is not writable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-codex-handoff-'));
    directories.push(directory);
    const parent = join(directory, 'unwritable');
    mkdirSync(parent);
    chmodSync(parent, 0o500);
    try {
      callCodexCustom.mockResolvedValue({ persona: 'review-adjudication', status: 'done', content: 'ok' });
      const agent = new CodexProvider().setup({ name: 'review-adjudication', systemPrompt: 'current assignment' });
      await agent.call('current reports and notes', {
        cwd: directory, executionPhase: 1, compactionHandoffDirectory: join(parent, 'new-child'),
      });
      const [, input, developer] = callCodexCustom.mock.calls[0]!;
      expect(JSON.parse(input)).toEqual({ taktCurrentInstructions: 'current assignment', userInstruction: 'current reports and notes' });
      expect(developer).not.toContain('Current call artifact:');
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  it('rejects a symlink in the artifact path before calling Codex', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'takt-codex-handoff-'));
    directories.push(directory);
    const link = join(directory, 'link');
    symlinkSync(directory, link);
    const agent = new CodexProvider().setup({ name: 'review-adjudication', systemPrompt: 'current assignment' });
    await expect(agent.call('current reports and notes', {
      cwd: directory, executionPhase: 1, compactionHandoffDirectory: link,
    })).rejects.toThrow(/symlink/);
    expect(callCodexCustom).not.toHaveBeenCalled();
  });
});
