import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeIsolatedStructuredInternalAgent } from '../agents/agent-usecases.js';
import { OpenCodeProvider } from '../infra/providers/opencode.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function response() {
  return {
    persona: 'takt-internal',
    status: 'done' as const,
    content: '',
    timestamp: new Date('2026-08-13T00:00:00Z'),
    structuredOutput: { selected_ids: ['frontend'], rationale: 'frontend changed' },
  };
}

describe('selector guidance runtime boundary', () => {
  it('composes bundle persona with the fixed selector contract under isolation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-runtime-'));
    roots.push(root);
    const bundleRoot = join(root, 'bundle-resources');
    mkdirSync(bundleRoot, { recursive: true });
    const personaPath = join(bundleRoot, 'selector-persona');
    const personaContent = 'Selector persona from the verified workflow bundle.';
    writeFileSync(personaPath, personaContent);
    const schema = { type: 'object', additionalProperties: false };
    const call = vi.fn().mockResolvedValue(response());
    const setup = vi.spyOn(OpenCodeProvider.prototype, 'setupIsolatedStructured')
      .mockReturnValue({ call });

    await executeIsolatedStructuredInternalAgent(
      'You are TAKT\'s fixed selector contract.',
      'Select reviewers from the supplied evidence.',
      schema,
      {
        cwd: root,
        projectCwd: root,
        workflowBundleResourceRoot: bundleRoot,
        personaPath,
        resolution: {
          provider: 'opencode',
          model: 'opencode/model',
          providerOptions: {},
        },
      },
    );

    expect(setup).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining(personaContent),
    }));
    const systemPrompt = setup.mock.calls[0]?.[0]?.systemPrompt;
    expect(systemPrompt).toContain('You are TAKT\'s fixed selector contract.');
    expect(call).toHaveBeenCalledWith(
      'Select reviewers from the supplied evidence.',
      expect.objectContaining({
        internalAgentIsolation: 'strict-readonly',
        permissionMode: 'readonly',
        allowedTools: [],
        mcpServers: {},
        bypassPermissions: false,
        outputSchema: schema,
        sessionId: undefined,
      }),
    );
  });

  it('composes an inline persona with the fixed selector contract under isolation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-runtime-'));
    roots.push(root);
    const schema = { type: 'object', additionalProperties: false };
    const call = vi.fn().mockResolvedValue(response());
    const setup = vi.spyOn(OpenCodeProvider.prototype, 'setupIsolatedStructured')
      .mockReturnValue({ call });

    await executeIsolatedStructuredInternalAgent(
      'You are TAKT\'s fixed selector contract.',
      'Select reviewers from the supplied evidence.',
      schema,
      {
        cwd: root,
        projectCwd: root,
        persona: 'Inline selector persona.',
        resolution: {
          provider: 'opencode',
          model: 'opencode/model',
          providerOptions: {},
        },
      },
    );

    const systemPrompt = setup.mock.calls[0]?.[0]?.systemPrompt;
    expect(systemPrompt).toContain('Inline selector persona.');
    expect(systemPrompt).toContain('You are TAKT\'s fixed selector contract.');
    expect(call).toHaveBeenCalledWith(
      'Select reviewers from the supplied evidence.',
      expect.objectContaining({
        internalAgentIsolation: 'strict-readonly',
        permissionMode: 'readonly',
        allowedTools: [],
        mcpServers: {},
        bypassPermissions: false,
        outputSchema: schema,
        sessionId: undefined,
      }),
    );
  });

  it('rejects a selector persona path outside the verified bundle root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-selector-guidance-runtime-'));
    roots.push(root);
    const bundleRoot = join(root, 'bundle-resources');
    mkdirSync(bundleRoot, { recursive: true });
    const outsidePersonaPath = join(root, 'outside-persona');
    writeFileSync(outsidePersonaPath, 'outside bundle');

    await expect(executeIsolatedStructuredInternalAgent(
      'fixed selector contract',
      'select',
      { type: 'object' },
      {
        cwd: root,
        projectCwd: root,
        workflowBundleResourceRoot: bundleRoot,
        personaPath: outsidePersonaPath,
        resolution: {
          provider: 'opencode',
          model: 'opencode/model',
          providerOptions: {},
        },
      },
    )).rejects.toThrow('Persona prompt file path is not allowed');
  });
});
