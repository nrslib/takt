import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { judgeStatus, runTagJudgeStage } from '../agents/judge-status-usecase.js';
import { runAgent } from '../agents/runner.js';
import type { AgentResponse, Language } from '../core/models/index.js';
import {
  getBuiltinPersonasDir,
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
  loadPersonaPromptFromPath,
  resolveConfigValue,
} from '../infra/config/index.js';
import { MockProvider } from '../infra/providers/mock.js';

describe('Phase 3 persona and judgment prompt regressions', () => {
  let tempDir: string;
  let projectDir: string;
  let globalDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-phase3-review-'));
    projectDir = join(tempDir, 'project');
    globalDir = join(tempDir, 'global');
    mkdirSync(projectDir);
    mkdirSync(globalDir);
    vi.stubEnv('TAKT_CONFIG_DIR', globalDir);
    vi.stubEnv('TAKT_LANGUAGE', undefined);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setConfigLanguage(language: Language): void {
    writeFileSync(join(globalDir, 'config.yaml'), `language: ${language}\n`);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    expect(resolveConfigValue(projectDir, 'language')).toBe(language);
  }

  function doneResponse(structuredOutput?: Record<string, unknown>): AgentResponse {
    return {
      persona: 'conductor',
      status: 'done',
      content: '',
      structuredOutput,
      timestamp: new Date(),
    };
  }

  describe.each([
    { configLanguage: 'ja', executionLanguage: 'en' },
    { configLanguage: 'en', executionLanguage: 'ja' },
  ] as const)('configuration=$configLanguage, execution=$executionLanguage', ({ configLanguage, executionLanguage }) => {
    beforeEach(() => setConfigLanguage(configLanguage));

    it('loads the execution-language conductor in both structured and tag judgment stages', async () => {
      const call = vi.fn()
        .mockResolvedValueOnce(doneResponse({ step: 1, reason: 'approved' }))
        .mockResolvedValueOnce(doneResponse({ content: '[REVIEW:1]' }));
      const setup = vi.spyOn(MockProvider.prototype, 'setup').mockReturnValue({ call });
      const options = {
        judgmentInput: 'work result',
        cwd: projectDir,
        language: executionLanguage,
        stepName: 'review',
        resolvedProvider: 'mock' as const,
      };
      const candidates = [{ label: 'approved' }, { label: 'needs_fix' }];

      await expect(judgeStatus('structured instruction', 'tag instruction', candidates, options))
        .resolves.toEqual({ candidateIndex: 0, method: 'structured_output' });
      await expect(runTagJudgeStage('tag instruction', candidates, options))
        .resolves.toEqual({ candidateIndex: 0, method: 'phase3_tag' });

      const conductor = readFileSync(join(getBuiltinPersonasDir(executionLanguage), 'conductor.md'), 'utf-8');
      expect(setup).toHaveBeenCalledTimes(2);
      for (const [agentSetup] of setup.mock.calls) {
        expect(agentSetup.systemPrompt).toContain(conductor);
      }
      expect(call).toHaveBeenCalledTimes(2);
    });

    it.each([undefined, 'internal instructions'])('keeps both builtin persona languages allowed with internalSystemPrompt=%s', async (internalSystemPrompt) => {
      const setup = vi.spyOn(MockProvider.prototype, 'setup').mockReturnValue({
        call: vi.fn().mockResolvedValue(doneResponse()),
      });

      for (const personaLanguage of [configLanguage, executionLanguage]) {
        const personaPath = join(getBuiltinPersonasDir(personaLanguage), 'coder.md');
        await runAgent('coder', 'implement', {
          cwd: projectDir,
          personaPath,
          language: executionLanguage,
          internalSystemPrompt,
          resolvedExecution: { provider: 'mock', model: undefined, providerOptions: undefined, permissionMode: undefined },
        });
        expect(setup.mock.lastCall?.[0].systemPrompt).toContain(readFileSync(personaPath, 'utf-8'));
      }
      expect(setup).toHaveBeenCalledTimes(2);
    });

    it('preserves the existing project and global persona roots', () => {
      const roots = [
        ...['personas', 'agents', 'workflows', '.takt/personas', '.takt/agents', '.takt/workflows', '.takt/facets/personas', '.takt/repertoire']
          .map((relativePath) => join(projectDir, relativePath)),
        ...['personas', 'agents', 'workflows', 'facets/personas', 'repertoire']
          .map((relativePath) => join(globalDir, relativePath)),
      ];
      for (const root of roots) {
        mkdirSync(root, { recursive: true });
        const personaPath = join(root, 'reviewer.md');
        writeFileSync(personaPath, 'project or global persona');
        expect(loadPersonaPromptFromPath(personaPath, projectDir)).toBe('project or global persona');
      }
    });

    it('keeps bundle persona validation confined to the bundle resource root', () => {
      const resourceRoot = join(tempDir, 'bundle');
      mkdirSync(resourceRoot);
      const bundledPersona = join(resourceRoot, 'reviewer.md');
      writeFileSync(bundledPersona, 'bundled persona');
      expect(loadPersonaPromptFromPath(bundledPersona, projectDir, resourceRoot)).toBe('bundled persona');
      for (const language of [configLanguage, executionLanguage]) {
        const builtinPersona = join(getBuiltinPersonasDir(language), 'coder.md');
        expect(() => loadPersonaPromptFromPath(builtinPersona, projectDir, resourceRoot)).toThrow(/not allowed/i);
      }
    });
  });

});
