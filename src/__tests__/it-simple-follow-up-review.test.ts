import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../core/workflow/index.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowResolver.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../agents/structured-caller/transport.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../agents/structured-caller/transport.js')>(),
  executeStructuredAgent: vi.fn(),
}));
import { runAgent } from '../agents/runner.js';
import { executeStructuredAgent } from '../agents/structured-caller/transport.js';

let project: string | undefined;
afterEach(() => {
  vi.clearAllMocks();
  if (project) rmSync(project, { recursive: true, force: true });
  project = undefined;
});

describe('simple workflow follow-up review', () => {
  it.each(['en', 'ja'].flatMap(language =>
    ['simple-core', 'simple', 'simple-mini', 'simple-backend', 'simple-dual', 'pure']
      .map(name => ({ language, name }))))(
    '$language/$name reviews completed repair only after an incomplete fix is retried and verified',
    async ({ language, name }) => {
      project = mkdtempSync(join(tmpdir(), 'takt-simple-follow-up-'));
      mkdirSync(join(project, '.takt'), { recursive: true });
      writeFileSync(join(project, '.takt', 'config.yaml'), `language: ${language}\n`);
      let loaded = loadWorkflowByIdentifier(join(process.cwd(), 'builtins', language, 'workflows', `${name}.yaml`), project);
      if (!loaded) throw new Error(`Missing workflow ${name}`);
      if (name === 'simple-backend' || name === 'simple-dual' || name === 'pure') {
        const call = loaded.steps.find(step => step.name === 'develop');
        if (!call || call.kind !== 'workflow_call') throw new Error('Missing simple-core call');
        loaded = resolveWorkflowCallTarget(loaded, call, project, project);
        if (!loaded || loaded.name !== 'simple-core') throw new Error('Missing resolved simple-core');
      }
      const workflow = { ...loaded, initialStep: 'review' };
      const reviewPrompts: string[] = [];
      const visited: string[] = [];
      const phaseOneSteps: string[] = [];
      let verifierJudgments = 0;
      vi.mocked(executeStructuredAgent).mockResolvedValue({
        persona: 'dynamic-facet-selector', status: 'done', content: '', timestamp: new Date(),
        structuredOutput: { selected_ids: [], rationale: 'No additional facet applies.' },
      });
      vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
        options?.onPromptResolved?.({ systemPrompt: 'reviewer', userInstruction: prompt });
        const step = options?.workflowMeta?.currentStep;
        if (!step) throw new Error('Missing current step');
        visited.push(step);
        if (options?.executionPhase === 1) phaseOneSteps.push(step);
        if (step === 'review' || step === 'follow-up-review') {
          if (options?.executionPhase === 1) {
            reviewPrompts.push(prompt);
            if (step === 'follow-up-review') {
              expect(prompt).toContain('### remediation: fix-plan.md\nREPAIR_PLAN_EVIDENCE');
              expect(prompt).toContain('### remediation: fix-report.md\nREPAIR_RETRY_EVIDENCE');
              expect(prompt).toContain('### remediation: fix-verification.md\nVERIFICATION_APPROVED_EVIDENCE');
              expect(prompt).toContain('REPAIR_RETRY_EVIDENCE');
              expect(prompt).toContain('VERIFICATION_APPROVED_EVIDENCE');
            }
          }
          return { persona: persona ?? 'coding-reviewer', status: 'done',
            content: step === 'review' ? 'INITIAL_FINDING' : 'FOLLOW_UP_APPROVED', timestamp: new Date() };
        }
        const content = step === 'fix-plan' ? 'REPAIR_PLAN_EVIDENCE'
          : step === 'fix' ? 'REPAIR_TEST_EVIDENCE'
            : step === 'fix-retry' ? 'REPAIR_RETRY_EVIDENCE'
              : step === 'fix-verifier' ? verifierJudgments === 0
                ? 'VERIFICATION_INCOMPLETE_EVIDENCE' : 'VERIFICATION_APPROVED_EVIDENCE'
                : `${step} result`;
        return { persona: persona ?? 'agent', status: 'done', content, timestamp: new Date() };
      });
      const engine = new WorkflowEngine(workflow, project, 'Repair a concrete finding', {
        projectCwd: project,
        provider: 'mock',
        model: 'mock-model',
        language,
        reportDirName: 'simple-follow-up',
        runPathsDirectory: join(project, '.takt', 'runs'),
        selectorProvider: { provider: 'mock', model: 'mock-model' },
        selectorGitCommandRunner: { isInsideWorkTree: async () => false,
          run: async () => ({ output: Buffer.from(''), bytes: 0 }) },
        workflowCallResolver: request => resolveWorkflowCallTarget(
          request.parentWorkflow, request.step, request.projectCwd, request.lookupCwd,
        ),
        structuredCaller: { judgeStatus: vi.fn(async (instruction, _tagInstruction, _candidates, options) => {
          options.onStructuredPromptResolved?.({ systemPrompt: 'conductor', userInstruction: instruction });
          const candidateIndex = options.stepName === 'fix-verifier'
            ? verifierJudgments++ === 0 ? 2 : 0
            : ['review', 'supervise'].includes(options.stepName) ? 1 : 0;
          return { candidateIndex,
            method: 'structured_output' as const };
        }), evaluateCondition: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn() },
      });
      const abortReasons: string[] = [];
      engine.on('workflow:abort', (_state, reason) => abortReasons.push(String(reason)));
      const result = await engine.run();
      expect(result.status, abortReasons.join('; ')).toBe('completed');
      expect(visited.indexOf('review')).toBeLessThan(visited.indexOf('fix'));
      expect(visited.indexOf('fix')).toBeLessThan(visited.indexOf('follow-up-review'));
      expect(phaseOneSteps.filter(step => step === 'fix-verifier')).toHaveLength(2);
      expect(phaseOneSteps.filter(step => step === 'fix-retry')).toHaveLength(1);
      expect(phaseOneSteps.filter(step => step === 'follow-up-review')).toHaveLength(1);
      expect(phaseOneSteps.indexOf('follow-up-review')).toBeGreaterThan(phaseOneSteps.lastIndexOf('fix-verifier'));
      expect(reviewPrompts).toHaveLength(2);
      expect(reviewPrompts[0]).not.toContain('REPAIR_PLAN_EVIDENCE');
      expect(reviewPrompts[1]).toContain('REPAIR_PLAN_EVIDENCE');
      expect(reviewPrompts[1]).not.toContain('参照先の報告 ... はこの run に存在しない');
      if (name === 'pure') {
        const skillsInstruction = readFileSync(join(process.cwd(), 'builtins', language,
          'facets', 'partials', 'instructions', 'use-relevant-skills.md'), 'utf8').trim();
        expect(skillsInstruction.length).toBeGreaterThan(0);
        expect(reviewPrompts[0]).toContain(skillsInstruction);
        expect(reviewPrompts[1]).toContain(skillsInstruction);
      }
    },
  );
});
