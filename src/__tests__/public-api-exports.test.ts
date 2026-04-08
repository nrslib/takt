import { describe, expect, it } from 'vitest';

describe('public API exports', () => {
  it('should expose workflow-centric usecases, engine, and loader APIs', async () => {
    const api = await import('../index.js');
    expect(typeof api.executeAgent).toBe('function');
    expect(typeof api.generateReport).toBe('function');
    expect(typeof api.executePart).toBe('function');
    expect(typeof api.judgeStatus).toBe('function');
    expect(typeof api.evaluateCondition).toBe('function');
    expect(typeof api.decomposeTask).toBe('function');

    expect(typeof api.WorkflowEngine).toBe('function');
    expect(typeof api.loadWorkflow).toBe('function');
    expect(typeof api.loadWorkflowByIdentifier).toBe('function');
    expect(typeof api.listWorkflows).toBe('function');
    expect('WorkflowEngine' in api).toBe(true);
    expect('loadWorkflow' in api).toBe(true);
    expect('loadWorkflowByIdentifier' in api).toBe(true);
    expect('listWorkflows' in api).toBe(true);
  });

  it('should not expose internal engine implementation details', async () => {
    const api = await import('../index.js');
    expect('AgentRunner' in api).toBe(false);
    expect('RuleEvaluator' in api).toBe(false);
    expect('AggregateEvaluator' in api).toBe(false);
    expect('evaluateAggregateConditions' in api).toBe(false);
    expect('needsStatusJudgmentPhase' in api).toBe(false);
    expect('StatusJudgmentBuilder' in api).toBe(false);
    expect('buildEditRule' in api).toBe(false);
    expect('detectRuleIndex' in api).toBe(false);
    expect('ParallelLogger' in api).toBe(false);
    expect('InstructionBuilder' in api).toBe(false);
    expect('ReportInstructionBuilder' in api).toBe(false);
    expect('COMPLETE_STEP' in api).toBe(false);
    expect('ABORT_STEP' in api).toBe(false);
    expect('ERROR_MESSAGES' in api).toBe(false);
    expect('determineNextStepByRules' in api).toBe(false);
    expect('extractBlockedPrompt' in api).toBe(false);
    expect('LoopDetector' in api).toBe(false);
    expect('createInitialState' in api).toBe(false);
    expect('addUserInput' in api).toBe(false);
    expect('getPreviousOutput' in api).toBe(false);
    expect('handleBlocked' in api).toBe(false);
  });

  it('should not expose infrastructure implementations and internal shared utilities', async () => {
    const api = await import('../index.js');
    expect('ClaudeClient' in api).toBe(false);
    expect('executeClaudeCli' in api).toBe(false);
    expect('CodexClient' in api).toBe(false);
    expect('mapToCodexSandboxMode' in api).toBe(false);
    expect('getResourcesDir' in api).toBe(false);
    expect('DEFAULT_WORKFLOW_NAME' in api).toBe(false);
    expect('buildPrompt' in api).toBe(false);
    expect('writeFileAtomic' in api).toBe(false);
    expect('getInputHistoryPath' in api).toBe(false);
    expect('MAX_INPUT_HISTORY' in api).toBe(false);
    expect('loadInputHistory' in api).toBe(false);
    expect('saveInputHistory' in api).toBe(false);
    expect('addToInputHistory' in api).toBe(false);
    expect('getPersonaSessionsPath' in api).toBe(false);
    expect('loadPersonaSessions' in api).toBe(false);
    expect('savePersonaSessions' in api).toBe(false);
    expect('updatePersonaSession' in api).toBe(false);
    expect('clearPersonaSessions' in api).toBe(false);
    expect('getWorktreeSessionsDir' in api).toBe(false);
    expect('encodeWorktreePath' in api).toBe(false);
    expect('getWorktreeSessionPath' in api).toBe(false);
    expect('loadWorktreeSessions' in api).toBe(false);
    expect('updateWorktreeSession' in api).toBe(false);
    expect('listWorkflowEntries' in api).toBe(false);
    expect('WorkflowDirEntry' in api).toBe(false);
  });
});
