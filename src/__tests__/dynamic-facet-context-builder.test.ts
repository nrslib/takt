import { describe, expect, it } from 'vitest';
import {
  buildDynamicFacetSelectorInstruction,
  buildDynamicFacetTargetAgentPrompt,
} from '../core/workflow/dynamic-facets/dynamicFacetContextBuilder.js';
import type { NormalAgentWorkflowStep, ResolvedFacetPool } from '../core/models/workflow-types.js';

const pool: ResolvedFacetPool = {
  name: 'fix',
  candidates: [
    { id: 'backend', description: 'API、repository、server-side実装を扱う', policyRefs: [], knowledgeRefs: ['backend-api'], resolvedPolicyContents: [], resolvedKnowledgeContents: ['# backend-api\n'] },
    { id: 'transaction', description: 'transaction境界、rollback、排他制御を扱う', policyRefs: ['transaction-correctness'], knowledgeRefs: ['database-transaction'], resolvedPolicyContents: ['# transaction\n'], resolvedKnowledgeContents: ['# database\n'] },
    { id: 'backward-compatibility', description: '公開APIやschemaの互換性を維持する', policyRefs: ['backward-compatibility'], knowledgeRefs: [], resolvedPolicyContents: ['# backward\n'], resolvedKnowledgeContents: [] },
  ],
};

describe('DynamicFacetContextBuilder (C-SELECTOR-INPUT, C-SELECTOR-INVOKE)', () => {
  it('should include user request, identity, entry type, iteration, references, and candidate ID+description in the selector instruction (C-SELECTOR-INPUT)', () => {
    const instruction = buildDynamicFacetSelectorInstruction({
      task: 'Fix the transaction boundary issue',
      workflowName: 'backend-fix',
      stepName: 'fix',
      workflowCallPath: [],
      isReentry: false,
      stepIteration: 1,
      reportDirectory: '/project/.takt/runs/run/reports',
      reportNames: ['review-resolution.md'],
      changedPaths: ['file.ts'],
      targetAgentPrompt: 'target persona and fixed facets',
      pool,
      maxSelected: 4,
    });

    // Must include each required item.
    expect(instruction).toContain('Fix the transaction boundary issue');
    expect(instruction).toContain('backend-fix');
    expect(instruction).toContain('fix');
    expect(instruction).toContain('initial entry');
    expect(instruction).toContain('1');
    expect(instruction).toContain('Report Directory:\n/project/.takt/runs/run/reports');
    expect(instruction).toContain('- review-resolution.md');
    expect(instruction).toContain('Workflow call path:\n(root)');
    expect(instruction).toContain('Changed file paths:\n- file.ts');
    expect(instruction).toContain('Target agent prompt:\ntarget persona and fixed facets');
    // Candidate IDs and descriptions.
    expect(instruction).toContain('backend');
    expect(instruction).toContain('API、repository、server-side実装を扱う');
    expect(instruction).toContain('transaction');
    expect(instruction).toContain('transaction境界、rollback、排他制御を扱う');
    expect(instruction).toContain('backward-compatibility');
    expect(instruction).toContain('公開APIやschemaの互換性を維持する');
  });

  it('should report re-entry instead of initial entry when isReentry is true (C-SELECTOR-INPUT: 初回 or 再進入)', () => {
    const instruction = buildDynamicFacetSelectorInstruction({
      task: 'task',
      workflowName: 'wf',
      stepName: 'fix',
      workflowCallPath: [],
      isReentry: true,
      stepIteration: 2,
      reportDirectory: '/project/.takt/runs/run/reports',
      reportNames: [],
      changedPaths: [],
      targetAgentPrompt: 'target prompt',
      pool,
      maxSelected: 4,
    });

    expect(instruction).toContain('re-entry');
    expect(instruction).not.toContain('initial entry');
    expect(instruction).toContain('2');
  });

  it('must NOT include facet body content in the selector instruction (C-SELECTOR-INPUT: facet 本文は渡さない)', () => {
    const instruction = buildDynamicFacetSelectorInstruction({
      task: 'task',
      workflowName: 'wf',
      stepName: 'fix',
      workflowCallPath: [],
      isReentry: false,
      stepIteration: 1,
      reportDirectory: '/project/.takt/runs/run/reports',
      reportNames: [],
      changedPaths: [],
      targetAgentPrompt: 'target prompt',
      pool,
      maxSelected: 4,
    });

    // The resolved facet body contents are internal to the pool; they must not appear in the selector input.
    expect(instruction).not.toContain('# transaction');
    expect(instruction).not.toContain('# database');
    expect(instruction).not.toContain('# backward');
    expect(instruction).not.toContain('# backend-api\n');
  });

  it('should render a non-root workflow call path and maxSelected in the selector instruction (C-SELECTOR-INPUT: nested path)', () => {
    const instruction = buildDynamicFacetSelectorInstruction({
      task: 'task',
      workflowName: 'wf',
      stepName: 'fix',
      workflowCallPath: [
        { step: 'delegate' } as never,
        { step: 'child-fix' } as never,
      ],
      isReentry: false,
      stepIteration: 1,
      reportDirectory: '/project/.takt/runs/run/reports',
      reportNames: [],
      changedPaths: [],
      targetAgentPrompt: 'target prompt',
      pool,
      maxSelected: 4,
    });

    expect(instruction).toContain('delegate > child-fix');
    expect(instruction).not.toContain('(root)');
    expect(instruction).toContain('Max selected:\n4');
  });

  it('should render unlimited when maxSelected is omitted', () => {
    const instruction = buildDynamicFacetSelectorInstruction({
      task: 'task',
      workflowName: 'wf',
      stepName: 'fix',
      workflowCallPath: [],
      isReentry: false,
      stepIteration: 1,
      reportDirectory: '/project/.takt/runs/run/reports',
      reportNames: [],
      changedPaths: [],
      targetAgentPrompt: 'target prompt',
      pool,
    });

    expect(instruction).toContain('Max selected:\nunlimited');
  });

  it('should compose only the target step persona, fixed facets, and instruction before dynamic selection', () => {
    const step: NormalAgentWorkflowStep = {
      name: 'security-review',
      personaDisplayName: 'security-reviewer',
      persona: 'SECURITY PERSONA',
      instruction: 'SECURITY INSTRUCTION',
      policyContents: [{ content: 'FIXED POLICY' }],
      knowledgeContents: [{ content: 'FIXED KNOWLEDGE' }],
      dynamicFacets: { pool: 'security' },
    };

    const prompt = buildDynamicFacetTargetAgentPrompt(step);

    expect(prompt).toContain('Persona:\nSECURITY PERSONA');
    expect(prompt).toContain('Policy:\nFIXED POLICY');
    expect(prompt).toContain('Knowledge:\nFIXED KNOWLEDGE');
    expect(prompt).toContain('Instruction:\nSECURITY INSTRUCTION');
    expect(prompt).not.toContain('# transaction');
    expect(prompt).not.toContain('# database');
  });

  it('should omit the persona section when the target step has no persona', () => {
    const step: NormalAgentWorkflowStep = {
      name: 'persona-less-step',
      personaDisplayName: 'default',
      instruction: 'TARGET INSTRUCTION',
      dynamicFacets: { pool: 'security' },
    };

    const prompt = buildDynamicFacetTargetAgentPrompt(step);

    expect(prompt).not.toContain('Persona:');
    expect(prompt).not.toContain('persona-less-step');
    expect(prompt).toContain('Policy:\n(none)');
    expect(prompt).toContain('Knowledge:\n(none)');
    expect(prompt).toContain('Instruction:\nTARGET INSTRUCTION');
  });
});
