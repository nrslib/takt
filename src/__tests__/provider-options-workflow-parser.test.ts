import { describe, expect, it } from 'vitest';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { mergeProviderOptions } from '../infra/config/providerOptions.js';

describe('normalizeWorkflowConfig provider_options', () => {
  it('steps と initial_step を canonical workflow fields に正規化する', () => {
    const raw = {
      name: 'workflow-aliases',
      initial_step: 'plan',
      steps: [
        {
          name: 'plan',
          instruction: '{task}',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.initialStep).toBe('plan');
    expect(config.steps).toHaveLength(1);
    expect(config.steps[0]?.name).toBe('plan');
  });

  it('answer_agent を指定したら reject する', () => {
    const raw = {
      name: 'answer-agent-removed',
      answer_agent: 'reviewer',
      steps: [
        {
          name: 'implement',
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, process.cwd())).toThrow(/answer_agent/);
  });

  it('workflow-level global を step に継承し、step 側で上書きできる', () => {
    const raw = {
      name: 'provider-options',
      workflow_config: {
        provider_options: {
          codex: { network_access: true },
          opencode: { network_access: false },
        },
      },
      steps: [
        {
          name: 'codex-default',
          provider: 'codex',
          instruction: '{task}',
        },
        {
          name: 'codex-override',
          provider: 'codex',
          provider_options: {
            codex: { network_access: false },
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      codex: { networkAccess: true },
      opencode: { networkAccess: false },
    });
    expect(config.steps[0]?.providerOptions).toEqual({
      codex: { networkAccess: true },
      opencode: { networkAccess: false },
    });
    expect(config.steps[1]?.providerOptions).toEqual({
      codex: { networkAccess: false },
      opencode: { networkAccess: false },
    });
  });

  it('claude sandbox を workflow-level で設定し step で上書きできる', () => {
    const raw = {
      name: 'claude-sandbox',
      workflow_config: {
        provider_options: {
          claude: {
            sandbox: { allow_unsandboxed_commands: true },
          },
        },
      },
      steps: [
        {
          name: 'inherit',
          instruction: '{task}',
        },
        {
          name: 'override',
          provider_options: {
            claude: {
              sandbox: {
                allow_unsandboxed_commands: false,
                excluded_commands: ['./gradlew'],
              },
            },
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      claude: { sandbox: { allowUnsandboxedCommands: true } },
    });
    expect(config.steps[0]?.providerOptions).toEqual({
      claude: { sandbox: { allowUnsandboxedCommands: true } },
    });
    expect(config.steps[1]?.providerOptions).toEqual({
      claude: {
        sandbox: {
          allowUnsandboxedCommands: false,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });

  it('claude allowed_tools を workflow-level で設定し step で上書きできる', () => {
    const raw = {
      name: 'claude-allowed-tools',
      workflow_config: {
        provider_options: {
          claude: {
            allowed_tools: ['Read', 'Glob'],
          },
        },
      },
      steps: [
        {
          name: 'inherit',
          instruction: '{task}',
        },
        {
          name: 'override',
          provider_options: {
            claude: {
              allowed_tools: ['Read', 'Edit', 'Bash'],
            },
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      claude: { allowedTools: ['Read', 'Glob'] },
    });
    expect(config.steps[0]?.providerOptions).toEqual({
      claude: { allowedTools: ['Read', 'Glob'] },
    });
    expect(config.steps[1]?.providerOptions).toEqual({
      claude: { allowedTools: ['Read', 'Edit', 'Bash'] },
    });
  });

  it('effort 系 provider_options を workflow-level で設定し step で上書きできる', () => {
    const raw = {
      name: 'provider-option-effort',
      workflow_config: {
        provider_options: {
          codex: { reasoning_effort: 'medium' },
          claude: { effort: 'low' },
        },
      },
      steps: [
        {
          name: 'inherit',
          instruction: '{task}',
        },
        {
          name: 'override',
          provider_options: {
            codex: { reasoning_effort: 'high' },
            claude: { effort: 'medium' },
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      codex: { reasoningEffort: 'medium' },
      claude: { effort: 'low' },
    });
    expect(config.steps[0]?.providerOptions).toEqual({
      codex: { reasoningEffort: 'medium' },
      claude: { effort: 'low' },
    });
    expect(config.steps[1]?.providerOptions).toEqual({
      codex: { reasoningEffort: 'high' },
      claude: { effort: 'medium' },
    });
  });

  it('workflow-level runtime.prepare を正規化し重複を除去する', () => {
    const raw = {
      name: 'runtime-prepare',
      workflow_config: {
        runtime: {
          prepare: ['gradle', 'node', 'gradle'],
        },
      },
      steps: [
        {
          name: 'implement',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.runtime).toEqual({
      prepare: ['gradle', 'node'],
    });
  });

  it('step の provider block を provider/model/providerOptions に正規化する', () => {
    const raw = {
      name: 'provider-block-step',
      steps: [
        {
          name: 'implement',
          provider: {
            type: 'codex',
            model: 'gpt-5.3',
            network_access: false,
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.steps[0]?.provider).toBe('codex');
    expect(config.steps[0]?.model).toBe('gpt-5.3');
    expect(config.steps[0]?.providerOptions).toEqual({
      codex: { networkAccess: false },
    });
  });

  it('workflow_config の provider block を step 既定値として継承する', () => {
    const raw = {
      name: 'provider-block-workflow-config',
      workflow_config: {
        provider: {
          type: 'codex',
          model: 'gpt-5.3',
          network_access: true,
        },
      },
      steps: [
        {
          name: 'plan',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
    expect(config.steps[0]?.provider).toBe('codex');
    expect(config.steps[0]?.model).toBe('gpt-5.3');
    expect(config.steps[0]?.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });

  it('provider block で claude に network_access を指定した場合はエラーにする', () => {
    const raw = {
      name: 'invalid-provider-block',
      steps: [
        {
          name: 'review',
          provider: {
            type: 'claude',
            network_access: true,
          },
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, process.cwd())).toThrow(/network_access/);
  });

  it('provider block で claude に sandbox を指定した場合は providerOptions に正規化する', () => {
    const raw = {
      name: 'claude-sandbox-provider-block',
      workflow_config: {
        provider: {
          type: 'claude',
          model: 'sonnet',
          sandbox: {
            allow_unsandboxed_commands: true,
            excluded_commands: ['./gradlew'],
          },
        },
      },
      steps: [
        {
          name: 'review',
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['./gradlew'],
        },
      },
    });
    expect(config.steps[0]?.provider).toBe('claude');
    expect(config.steps[0]?.model).toBe('sonnet');
    expect(config.steps[0]?.providerOptions).toEqual({
      claude: {
        sandbox: {
          allowUnsandboxedCommands: true,
          excludedCommands: ['./gradlew'],
        },
      },
    });
  });

  it('provider block で codex に sandbox を指定した場合はエラーにする', () => {
    const raw = {
      name: 'invalid-provider-block',
      workflow_config: {
        provider: {
          type: 'codex',
          sandbox: {
            allow_unsandboxed_commands: true,
          },
        },
      },
      steps: [
        {
          name: 'review',
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, process.cwd())).toThrow(/sandbox/);
  });

  it('parallel サブステップは親ステップの provider block を継承する', () => {
    const raw = {
      name: 'provider-block-parallel-inherit',
      workflow_config: {
        provider: {
          type: 'claude',
          model: 'sonnet',
        },
      },
      steps: [
        {
          name: 'reviewers',
          provider: {
            type: 'codex',
            model: 'gpt-5.3',
            network_access: true,
          },
          parallel: [
            {
              name: 'arch-review',
              instruction: '{task}',
            },
          ],
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());
    const parent = config.steps[0];
    const child = parent?.parallel?.[0];

    expect(parent?.provider).toBe('codex');
    expect(parent?.model).toBe('gpt-5.3');
    expect(child?.provider).toBe('codex');
    expect(child?.model).toBe('gpt-5.3');
    expect(child?.providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });

  it('parallel の provider block で claude に network_access 指定時はエラーにする', () => {
    const raw = {
      name: 'invalid-provider-block-parallel',
      steps: [
        {
          name: 'review',
          parallel: [
            {
              name: 'arch-review',
              provider: {
                type: 'claude',
                network_access: true,
              },
              instruction: '{task}',
            },
          ],
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, process.cwd())).toThrow(/network_access/);
  });

  it('parallel の provider block で codex に sandbox 指定時はエラーにする', () => {
    const raw = {
      name: 'invalid-provider-block-parallel',
      steps: [
        {
          name: 'review',
          parallel: [
            {
              name: 'arch-review',
              provider: {
                type: 'codex',
                sandbox: {
                  allow_unsandboxed_commands: true,
                },
              },
              instruction: '{task}',
            },
          ],
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, process.cwd())).toThrow(/sandbox/);
  });
});

describe('mergeProviderOptions', () => {
  it('複数層を正しくマージする（後の層が優先）', () => {
    const global = {
      claude: {
        sandbox: { allowUnsandboxedCommands: false, excludedCommands: ['./gradlew'] },
        allowedTools: ['Read'],
      },
      codex: { networkAccess: true },
    };
    const local = {
      claude: { sandbox: { allowUnsandboxedCommands: true } },
    };
    const step = {
      claude: { allowedTools: ['Read', 'Edit'] },
      codex: { networkAccess: false },
    };

    const result = mergeProviderOptions(global, local, step);

    expect(result).toEqual({
      claude: {
        sandbox: { allowUnsandboxedCommands: true, excludedCommands: ['./gradlew'] },
        allowedTools: ['Read', 'Edit'],
      },
      codex: { networkAccess: false },
    });
  });

  it('すべて undefined なら undefined を返す', () => {
    expect(mergeProviderOptions(undefined, undefined, undefined)).toBeUndefined();
  });
});
