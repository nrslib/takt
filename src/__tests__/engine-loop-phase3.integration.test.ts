import { existsSync, rmSync } from 'node:fs';
import type { WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import { parseWorkflowRuleCondition } from '../core/models/workflow-rule-condition.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { loopJudgeStepName } from '../core/workflow/loop-judge-step.js';
import { runAgent } from '../agents/runner.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  makeStep,
} from './engine-test-helpers.js';
import { makeRule } from './test-helpers.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

describe('WorkflowEngine loop judge Phase 3 with OpenCode default model', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine !== undefined) {
      cleanupWorkflowEngine(engine);
      engine = undefined;
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    { method: 'structured', decision: 1, expectedNextStep: 'ai_review' },
    { method: 'structured', decision: 2, expectedNextStep: 'reviewers' },
    { method: 'tag', decision: 1, expectedNextStep: 'ai_review' },
    { method: 'tag', decision: 2, expectedNextStep: 'reviewers' },
    { method: 'ai_judge', decision: 1, expectedNextStep: 'ai_review' },
    { method: 'ai_judge', decision: 2, expectedNextStep: 'reviewers' },
  ] as const)(
    'uses the real Phase 3 $method judgment and RuleEvaluator for candidate $decision',
    async ({ method, decision: loopJudgeDecision, expectedNextStep }) => {
      const config: WorkflowConfig = {
        name: 'loop-phase3-default-model',
        description: 'Exercise the real loop judge Phase 3 and rule evaluation path',
        maxSteps: 20,
        initialStep: 'implement',
        loopMonitors: [{
          cycle: ['ai_review', 'ai_fix'],
          threshold: 1,
          judge: {
            persona: 'supervisor',
            rules: [
              { condition: parseWorkflowRuleCondition('Healthy'), next: 'ai_review' },
              { condition: parseWorkflowRuleCondition('Unproductive'), next: 'reviewers' },
            ],
          },
        }],
        steps: [
          makeStep('implement', {
            rules: [makeRule('done', 'ai_review')],
          }),
          makeStep('ai_review', {
            rules: [
              makeRule('No issues', 'reviewers'),
              makeRule('Issues found', 'ai_fix'),
            ],
          }),
          makeStep('ai_fix', {
            rules: [
              makeRule('Fixed', 'ai_review'),
              makeRule('No fix needed', 'reviewers'),
            ],
          }),
          makeStep('reviewers', {
            rules: [makeRule('All approved', 'COMPLETE')],
          }),
        ],
      };

      engine = new WorkflowEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        provider: 'opencode',
        providerSource: 'cli',
        providerRouting: {
          steps: {
            implement: { provider: 'opencode', model: 'opencode/step-model' },
            ai_review: { provider: 'opencode', model: 'opencode/step-model' },
            ai_fix: { provider: 'opencode', model: 'opencode/step-model' },
            reviewers: { provider: 'opencode', model: 'opencode/step-model' },
          },
        },
        internalAgentSeats: {
          loopJudge: { provider: 'claude', model: 'opus' },
        },
      });

      const phase1Responses = [
        'Implementation done',
        'Issues found',
        'Fixed',
        'Loop judge evidence',
        ...(loopJudgeDecision === 1 ? ['No issues remain'] : []),
        'All approved',
      ];
      let phase1Index = 0;
      let phase3Index = 0;
      const phase3Decisions = [2, 1, method === 'structured' ? loopJudgeDecision : 99, 1];
      const defaultModelPhase3Calls: Array<Parameters<typeof runAgent>[2]> = [];
      const loopJudgeName = loopJudgeStepName(['ai_review', 'ai_fix']);
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: instruction,
        });
        const properties = options.outputSchema?.properties;
        const hasOutputProperty = (property: string): boolean =>
          properties !== null && typeof properties === 'object' && property in properties;
        const isPhase3JudgeAgent = persona === 'conductor'
          || hasOutputProperty('matched_index');
        const isDefaultModelPhase3Call = isPhase3JudgeAgent
          && options.resolvedExecution?.provider === 'opencode'
          && options.resolvedExecution.model === undefined
          && (hasOutputProperty('step') || hasOutputProperty('content') || hasOutputProperty('matched_index'));
        if (isDefaultModelPhase3Call) defaultModelPhase3Calls.push(options);

        if (hasOutputProperty('step')) {
          const step = phase3Decisions[phase3Index++];
          if (step === undefined) throw new Error('Unexpected Phase 3 call');
          return makeResponse({
            persona: typeof persona === 'string' ? persona : 'conductor',
            content: `selected ${step}`,
            structuredOutput: { step, reason: 'controlled Phase 3 response' },
          });
        }
        if (hasOutputProperty('content')) {
          return makeResponse({
            persona: typeof persona === 'string' ? persona : 'test-agent',
            content: method === 'tag' ? `[${loopJudgeName.toUpperCase()}:${loopJudgeDecision}]` : 'No status tag',
            structuredOutput: {
              content: method === 'tag' ? `[${loopJudgeName.toUpperCase()}:${loopJudgeDecision}]` : 'No status tag',
            },
          });
        }
        if (hasOutputProperty('matched_index')) {
          return makeResponse({
            persona: typeof persona === 'string' ? persona : 'condition-evaluator',
            content: `selected ${loopJudgeDecision}`,
            structuredOutput: { matched_index: loopJudgeDecision, reason: 'controlled Phase 3 response' },
          });
        }

        const content = phase1Responses[phase1Index++];
        if (content === undefined) throw new Error('Unexpected Phase 1 call');
        return makeResponse({
          persona: typeof persona === 'string' ? persona : 'test-agent',
          content,
        });
      });

      const startedStepNames: string[] = [];
      engine.on('step:start', (step: WorkflowStep) => startedStepNames.push(step.name));

      const state = await engine.run();

      expect(state.status).toBe('completed');
      expect(phase3Index).toBe(loopJudgeDecision === 1 ? 4 : 3);
      const synthesizedJudgeIndex = startedStepNames.indexOf(loopJudgeName);
      expect(synthesizedJudgeIndex).toBeGreaterThanOrEqual(0);
      expect(startedStepNames[synthesizedJudgeIndex + 1]).toBe(expectedNextStep);
      expect(defaultModelPhase3Calls).toHaveLength({ structured: 1, tag: 2, ai_judge: 3 }[method]);
      for (const options of defaultModelPhase3Calls) {
        expect(options).toEqual(expect.objectContaining({
          allowDefaultModel: true,
          resolvedExecution: expect.objectContaining({
            provider: 'opencode',
            model: undefined,
          }),
        }));
      }
    },
  );
});
