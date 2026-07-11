/**
 * codex B6: the finding-conflict-adjudication step's supervisor persona facet
 * BODY must actually reach the system prompt. Engine tests mock the agent
 * runner entirely, so this file goes one layer deeper: the REAL AgentRunner
 * (executeAgent) assembles the prompt from personaPath, with only the provider
 * registry mocked to capture what setup() receives.
 */
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capturedSetups: Array<{ name: string; systemPrompt?: string }> = [];

vi.mock('../infra/providers/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/providers/index.js')>();
  return {
    ...original,
    getProvider: vi.fn(() => ({
      supportsStructuredOutput: true,
      supportsNativeImageInput: false,
      getRuntimeInstructions: () => null,
      keepsAllowedToolWithoutEdit: () => false,
      setup: (setup: { name: string; systemPrompt?: string }) => {
        capturedSetups.push(setup);
        return {
          call: async () => ({
            persona: setup.name,
            status: 'done' as const,
            content: 'ok',
            timestamp: new Date(),
          }),
        };
      },
    })),
  };
});

import { executeAgent } from '../agents/agent-usecases.js';

const SUPERVISOR_PERSONA_BODY = '# Supervisor\nYou are the supervising adjudicator persona used in tests.\nAlways cite evidence.\n';

describe('finding-conflict-adjudication persona prompt assembly (codex B6)', () => {
  let cwd: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-adjudication-persona-'));
    mkdirSync(join(cwd, 'personas'), { recursive: true });
    writeFileSync(join(cwd, 'personas', 'supervisor.md'), SUPERVISOR_PERSONA_BODY);
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = join(cwd, '.takt-config');
    capturedSetups.length = 0;
  });

  afterEach(() => {
    if (existsSync(cwd)) {
      rmSync(cwd, { recursive: true, force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousConfigDir;
    }
  });

  it('personaPath 経由で supervisor facet 本文が system prompt に載る', async () => {
    const response = await executeAgent('supervisor', 'Adjudicate conflict C-0001.', {
      cwd,
      projectCwd: cwd,
      resolvedProvider: 'claude',
      personaPath: join(cwd, 'personas', 'supervisor.md'),
    });

    expect(response.status).toBe('done');
    expect(capturedSetups).toHaveLength(1);
    expect(capturedSetups[0]!.systemPrompt).toContain('You are the supervising adjudicator persona used in tests.');
    expect(capturedSetups[0]!.systemPrompt).toContain('Always cite evidence.');
  });
});
