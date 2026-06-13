import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn(),
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeStep,
  makeResponse,
  makeRule,
  mockDetectMatchedRuleSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';
import type { WorkflowConfig } from '../core/models/index.js';

describe('WorkflowEngine provider_options resolution', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = undefined;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should let step provider_options override project source without origin trace', async () => {
    const step = makeStep('implement', {
      providerOptions: {
        codex: { networkAccess: false },
        claude: { sandbox: { excludedCommands: ['./gradlew'] } },
      },
      rules: [makeRule('done', 'COMPLETE')],
    });

    const config: WorkflowConfig = {
      name: 'provider-options-priority',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'claude',
      providerOptionsSource: 'project',
      providerOptions: {
        codex: { networkAccess: true },
        claude: { sandbox: { allowUnsandboxedCommands: false } },
        opencode: { networkAccess: true },
      },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: false },
      opencode: { networkAccess: true },
      claude: {
        sandbox: {
          allowUnsandboxedCommands: false,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });

  it('should pass global provider_options when project and step options are absent', async () => {
    const step = makeStep('implement', {
      rules: [makeRule('done', 'COMPLETE')],
    });

    const config: WorkflowConfig = {
      name: 'provider-options-global-only',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'claude',
      providerOptions: {
        codex: { networkAccess: true },
      },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });

  it('should propagate merged claude allowedTools to runAgent options.allowedTools', async () => {
    const step = makeStep('implement', {
      providerOptions: {
        claude: { allowedTools: ['Read', 'Edit', 'Bash'] },
      },
      rules: [makeRule('done', 'COMPLETE')],
    });

    const config: WorkflowConfig = {
      name: 'provider-options-allowed-tools',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'claude',
      providerOptions: {
        claude: { allowedTools: ['Read', 'Glob'] },
      },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.allowedTools).toEqual(['Read', 'Edit', 'Bash']);
  });

  it('should silently ignore claude allowedTools when configured for a non-claude provider', async () => {
    const step = makeStep('implement', {
      provider: 'codex',
      providerOptions: {
        claude: { allowedTools: ['Read', 'Edit', 'Bash'] },
      },
      rules: [makeRule('done', 'COMPLETE')],
    });

    const config: WorkflowConfig = {
      name: 'provider-options-non-claude-tools',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'claude',
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.allowedTools).toBeUndefined();
  });

  it('should silently ignore claude allowedTools on a step resolved to opencode via personaProviders', async () => {
    const step = makeStep('implement', {
      personaDisplayName: 'coder',
      providerOptions: {
        claude: { allowedTools: ['Read', 'Edit'] },
      },
      rules: [makeRule('done', 'COMPLETE')],
    });

    const config: WorkflowConfig = {
      name: 'provider-options-persona-opencode-tools',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'claude',
      personaProviders: {
        coder: {
          provider: 'opencode',
          model: 'opencode/zai-coding-plan/glm-5.1',
        },
      },
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.allowedTools).toBeUndefined();
  });

  it('should propagate opencode allowedTools when the resolved provider is opencode', async () => {
    const step = makeStep('implement', {
      provider: 'opencode',
      model: 'opencode/zai-coding-plan/glm-5.1',
      providerOptions: {
        claude: { allowedTools: ['Read', 'Edit'] },
        opencode: { allowedTools: ['read', 'grep', 'bash'] },
      } as never,
      rules: [makeRule('done', 'COMPLETE')],
    });

    const config: WorkflowConfig = {
      name: 'provider-options-opencode-tools',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'claude',
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.allowedTools).toEqual(['read', 'grep', 'bash']);
  });

  it('should remove opencode edit permission aliases from phase 1 allowedTools when outputContracts exist and edit is not true', async () => {
    const step = makeStep('review', {
      provider: 'opencode',
      model: 'opencode/zai-coding-plan/glm-5.1',
      providerOptions: {
        opencode: {
          allowedTools: [
            'read',
            'Edit',
            'edit',
            'Write',
            ' write ',
            'apply_patch',
            'patch',
            'bash',
          ],
        },
      } as never,
      outputContracts: [{ name: 'review.md', format: 'markdown' }],
      edit: false,
      rules: [makeRule('done', 'COMPLETE')],
    });

    const config: WorkflowConfig = {
      name: 'provider-options-opencode-output-contract-tools',
      steps: [step],
      initialStep: 'review',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'claude',
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.allowedTools).toEqual(['read', 'bash']);
  });

  it('should keep claude allowedTools when the provider is mock', async () => {
    const step = makeStep('implement', {
      provider: 'mock',
      providerOptions: {
        claude: { allowedTools: ['Read', 'Edit'] },
      },
      rules: [makeRule('done', 'COMPLETE')],
    });

    const config: WorkflowConfig = {
      name: 'provider-options-mock-tools',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'claude',
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.allowedTools).toEqual(['Read', 'Edit']);
  });

  it('should use already resolved capability-dependent options from engine inputs', async () => {
    const schema = {
      type: 'object',
      properties: {
        result: { type: 'string' },
      },
      required: ['result'],
      additionalProperties: false,
    } as const;
    const step = makeStep('implement', {
      providerOptions: {
        claude: { allowedTools: ['Read', 'Edit', 'Bash'] },
      },
      mcpServers: {
        docs: { type: 'stdio', command: 'docs-mcp' },
      },
      structuredOutput: { schema },
      rules: [makeRule('done', 'COMPLETE')],
    });

    const config: WorkflowConfig = {
      name: 'provider-options-unresolved-provider',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'claude',
      model: 'sonnet',
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.resolvedProvider).toBe('claude');
    expect(options?.resolvedModel).toBe('sonnet');
    expect(options?.allowedTools).toEqual(['Read', 'Edit', 'Bash']);
    expect(options?.outputSchema).toEqual(schema);
  });

  it('Given claude-terminal step options, When engine runs, Then capability-dependent fields reach runAgent', async () => {
    const schema = {
      type: 'object',
      properties: {
        decision: { type: 'string' },
      },
      required: ['decision'],
      additionalProperties: false,
    } as const;
    const provider = 'claude-terminal' as WorkflowConfig['steps'][number]['provider'];
    const step = makeStep('implement', {
      provider,
      providerOptions: {
        claude: {
          effort: 'high',
          allowedTools: ['Read', 'Edit', 'Bash'],
        },
        claudeTerminal: {
          backend: 'tmux',
          timeoutMs: 900000,
          keepSession: false,
          transcriptPollIntervalMs: 500,
        },
      } as never,
      mcpServers: {
        docs: { type: 'stdio', command: 'docs-mcp', args: ['serve'] },
      },
      structuredOutput: { schema },
      rules: [makeRule('done', 'COMPLETE')],
    });

    const config: WorkflowConfig = {
      name: 'provider-options-claude-terminal',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: 'done' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'claude',
      model: 'sonnet',
    });

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];
    expect(options?.resolvedProvider).toBe('claude-terminal');
    expect(options?.resolvedModel).toBe('sonnet');
    expect(options?.allowedTools).toEqual(['Read', 'Edit', 'Bash']);
    expect(options?.mcpServers).toEqual({
      docs: { type: 'stdio', command: 'docs-mcp', args: ['serve'] },
    });
    expect(options?.outputSchema).toEqual(schema);
    expect(options?.providerOptions).toEqual({
      claude: {
        effort: 'high',
        allowedTools: ['Read', 'Edit', 'Bash'],
      },
      claudeTerminal: {
        backend: 'tmux',
        timeoutMs: 900000,
        keepSession: false,
        transcriptPollIntervalMs: 500,
      },
    });
  });

  it('should switch structured_output to prompt fallback when the resolved provider is cursor', async () => {
    const step = makeStep('implement', {
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
      rules: [makeRule('done', 'COMPLETE')],
    });

    const config: WorkflowConfig = {
      name: 'provider-options-cursor-structured-output',
      steps: [step],
      initialStep: 'implement',
      maxSteps: 1,
    };

    mockRunAgentSequence([
      makeResponse({ persona: step.persona, content: '```json\n{"result":"done"}\n```' }),
    ]);
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'cursor',
      model: 'cursor-fast',
    });

    await engine.run();

    const [, instruction, options] = vi.mocked(runAgent).mock.calls[0] ?? [];
    expect(instruction).toContain('Return exactly one fenced JSON block');
    expect(options?.resolvedProvider).toBe('cursor');
    expect(options?.resolvedModel).toBe('cursor-fast');
    expect(options?.outputSchema).toBeUndefined();
  });
});
