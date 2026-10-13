import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { judgeStatus, runTagJudgeStage, type JudgeStatusOptions } from '../agents/judge-status-usecase.js';
import { getProvider } from '../infra/providers/index.js';
import { getBuiltinPersonasDir, getGlobalConfigDir } from '../infra/config/paths.js';
import * as resourceResolver from '../infra/config/loaders/resource-resolver.js';

describe('Phase 3 conductor persona resolution', () => {
  let rootDir: string;
  const candidates = [{ label: 'approved' }, { label: 'needs_fix' }];

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'takt-judge-persona-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(rootDir, { recursive: true, force: true });
  });

  function writePersona(filePath: string, content: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }

  for (const stage of ['structured', 'tag'] as const) {
    describe(stage, () => {
      function mockProvider() {
        const call = vi.fn().mockResolvedValue({
          persona: 'conductor',
          status: 'done',
          content: '',
          structuredOutput: stage === 'structured'
            ? { step: 1, reason: 'The input states approved.' }
            : { content: '[REVIEW:1]' },
          timestamp: new Date(),
        });
        const setup = vi.spyOn(getProvider('mock'), 'setup').mockReturnValue({ call });
        return { setup, call };
      }

      async function judge(options: Partial<JudgeStatusOptions> = {}) {
        const runOptions: JudgeStatusOptions = {
          cwd: rootDir,
          stepName: 'review',
          resolvedProvider: 'mock',
          ...options,
        };
        return stage === 'structured'
          ? judgeStatus('structured instruction', 'tag instruction', candidates, runOptions)
          : runTagJudgeStage('tag instruction', candidates, runOptions, runOptions.onJudgeStage);
      }

      it.each(['ja', 'en'] as const)('calls the provider with the %s builtin persona body', async (language) => {
        const { setup, call } = mockProvider();
        const persona = readFileSync(join(getBuiltinPersonasDir(language), 'conductor.md'), 'utf8');

        const result = await judge({ language });

        expect(setup).toHaveBeenCalledWith({ name: 'conductor', systemPrompt: expect.stringContaining(persona) });
        expect(call).toHaveBeenCalledOnce();
        expect(call).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cwd: rootDir, allowedTools: [] }));
        expect(result).toEqual({ candidateIndex: 0, method: stage === 'structured' ? 'structured_output' : 'phase3_tag' });
      });

      it('uses the English builtin when language is omitted', async () => {
        const { setup } = mockProvider();
        const persona = readFileSync(join(getBuiltinPersonasDir('en'), 'conductor.md'), 'utf8');
        writeFileSync(join(getGlobalConfigDir(), 'config.yaml'), 'language: ja\n');

        await judge();

        expect(setup).toHaveBeenCalledWith({ name: 'conductor', systemPrompt: expect.stringContaining(persona) });
      });

      it('prefers the project persona over the builtin when projectCwd is omitted', async () => {
        const { setup } = mockProvider();
        const persona = '# Project conductor\nUse the supplied conclusion.';
        writePersona(join(rootDir, '.takt/facets/personas/conductor.md'), persona);

        await judge();

        expect(setup).toHaveBeenCalledWith({ name: 'conductor', systemPrompt: expect.stringContaining(persona) });
      });

      it('resolves the original project override while executing in a clone', async () => {
        const { setup, call } = mockProvider();
        const projectCwd = join(rootDir, 'project');
        const cwd = join(rootDir, 'clone');
        const persona = '# Original project conductor\nUse the supplied conclusion.';
        writePersona(join(projectCwd, '.takt/facets/personas/conductor.md'), persona);
        writePersona(join(cwd, '.takt/facets/personas/conductor.md'), '# Clone conductor');

        await judge({ cwd, projectCwd });

        expect(setup).toHaveBeenCalledWith({ name: 'conductor', systemPrompt: expect.stringContaining(persona) });
        expect(setup.mock.calls[0]?.[0].systemPrompt).not.toContain('# Clone conductor');
        expect(call).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cwd }));
      });

      it('preserves the named custom agent ahead of project and builtin facets', async () => {
        const { setup } = mockProvider();
        const persona = '# Custom conductor\nUse the supplied conclusion.';
        writePersona(join(getGlobalConfigDir(), 'personas/conductor.md'), persona);
        writePersona(join(rootDir, '.takt/facets/personas/conductor.md'), '# Project conductor');
        const resolveFacetPath = vi.spyOn(resourceResolver, 'resolveFacetPath');

        await judge();

        expect(setup).toHaveBeenCalledWith({ name: 'conductor', systemPrompt: expect.stringContaining(persona) });
        expect(resolveFacetPath).not.toHaveBeenCalled();
      });

      it('fails before provider execution or fallback when the persona is missing', async () => {
        const { setup, call } = mockProvider();
        vi.spyOn(resourceResolver, 'resolveFacetPath').mockReturnValue(undefined);
        const onJudgeStage = vi.fn();

        await expect(judge({ language: 'ja', onJudgeStage })).rejects.toThrow(/conductor.*not found.*project:.*language: ja/);

        expect(setup).not.toHaveBeenCalled();
        expect(call).not.toHaveBeenCalled();
        expect(onJudgeStage).not.toHaveBeenCalled();
      });
    });
  }
});
