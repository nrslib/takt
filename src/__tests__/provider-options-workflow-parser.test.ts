import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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

  it('opencode variant を workflow-level で設定し step で上書きできる', () => {
    const raw = {
      name: 'opencode-variant',
      workflow_config: {
        provider_options: {
          opencode: {
            network_access: true,
            variant: 'low',
          },
        },
      },
      steps: [
        {
          name: 'inherit',
          provider: 'opencode',
          instruction: '{task}',
        },
        {
          name: 'override',
          provider: 'opencode',
          provider_options: {
            opencode: {
              variant: 'high',
            },
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      opencode: {
        networkAccess: true,
        variant: 'low',
      },
    });
    expect(config.steps[0]?.providerOptions).toEqual({
      opencode: {
        networkAccess: true,
        variant: 'low',
      },
    });
    expect(config.steps[1]?.providerOptions).toEqual({
      opencode: {
        networkAccess: true,
        variant: 'high',
      },
    });
  });

  it('opencode allowed_tools を workflow-level で設定し step で上書きできる', () => {
    const raw = {
      name: 'opencode-allowed-tools',
      workflow_config: {
        provider_options: {
          opencode: {
            allowed_tools: ['read', 'glob', 'grep'],
          },
        },
      },
      steps: [
        {
          name: 'inherit',
          provider: 'opencode',
          instruction: '{task}',
        },
        {
          name: 'override',
          provider: 'opencode',
          provider_options: {
            opencode: {
              allowed_tools: ['read', 'edit', 'bash'],
            },
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      opencode: {
        allowedTools: ['read', 'glob', 'grep'],
      },
    });
    expect(config.steps[0]?.providerOptions).toEqual({
      opencode: {
        allowedTools: ['read', 'glob', 'grep'],
      },
    });
    expect(config.steps[1]?.providerOptions).toEqual({
      opencode: {
        allowedTools: ['read', 'edit', 'bash'],
      },
    });
  });

  it('provider_options の $ref を workflowDir 相対で解決し inline で上書きできる', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      writeFileSync(join(tempDir, 'provider-options', 'review-readonly.yaml'), [
        'claude:',
        '  allowed_tools:',
        '    - Read',
        '    - Glob',
        'opencode:',
        '  allowed_tools:',
        '    - read',
        '    - glob',
      ].join('\n'));
      const raw = {
        name: 'provider-options-ref',
        workflow_config: {
          provider_options: {
            $ref: 'provider-options/review-readonly.yaml',
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
              $ref: 'provider-options/review-readonly.yaml',
              opencode: {
                allowed_tools: ['read', 'edit', 'bash'],
              },
            },
            instruction: '{task}',
          },
        ],
      };

      const config = normalizeWorkflowConfig(raw, tempDir);

      expect(config.providerOptions).toEqual({
        claude: { allowedTools: ['Read', 'Glob'] },
        opencode: { allowedTools: ['read', 'glob'] },
      });
      expect(config.steps[0]?.providerOptions).toEqual({
        claude: { allowedTools: ['Read', 'Glob'] },
        opencode: { allowedTools: ['read', 'glob'] },
      });
      expect(config.steps[1]?.providerOptions).toEqual({
        claude: { allowedTools: ['Read', 'Glob'] },
        opencode: { allowedTools: ['read', 'edit', 'bash'] },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('provider_options の $ref が存在しない場合は参照パスを含めて reject する', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-missing-'));
    try {
      const raw = {
        name: 'missing-provider-options-ref',
        workflow_config: {
          provider_options: {
            $ref: 'provider-options/missing.yaml',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, tempDir))
        .toThrow(/provider-options\/missing\.yaml/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('provider_options の $ref 先も inline と同じ schema で検証する', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-schema-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      writeFileSync(join(tempDir, 'provider-options', 'invalid.yaml'), [
        'opencode:',
        '  allowed_tools: read',
      ].join('\n'));
      const raw = {
        name: 'invalid-provider-options-ref',
        workflow_config: {
          provider_options: {
            $ref: 'provider-options/invalid.yaml',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, tempDir)).toThrow(/allowed_tools|expected array/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('provider_options の nested $ref を解決し inline で上書きできる', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-nested-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      writeFileSync(join(tempDir, 'provider-options', 'base.yaml'), [
        'claude:',
        '  allowed_tools:',
        '    - Read',
        'opencode:',
        '  allowed_tools:',
        '    - read',
      ].join('\n'));
      writeFileSync(join(tempDir, 'provider-options', 'review.yaml'), [
        '$ref: base.yaml',
        'opencode:',
        '  allowed_tools:',
        '    - read',
        '    - grep',
      ].join('\n'));
      const raw = {
        name: 'nested-provider-options-ref',
        workflow_config: {
          provider_options: {
            $ref: 'provider-options/review.yaml',
            opencode: {
              allowed_tools: ['read', 'bash'],
            },
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      const config = normalizeWorkflowConfig(raw, tempDir);

      expect(config.providerOptions).toEqual({
        claude: { allowedTools: ['Read'] },
        opencode: { allowedTools: ['read', 'bash'] },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('provider_options の $ref が循環参照する場合は reject する', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-circular-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      writeFileSync(join(tempDir, 'provider-options', 'a.yaml'), '$ref: b.yaml\n');
      writeFileSync(join(tempDir, 'provider-options', 'b.yaml'), '$ref: a.yaml\n');
      const raw = {
        name: 'circular-provider-options-ref',
        workflow_config: {
          provider_options: {
            $ref: 'provider-options/a.yaml',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, tempDir)).toThrow(/circular reference/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('provider_options の $ref 先 YAML が object でない場合は reject する', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-non-object-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      writeFileSync(join(tempDir, 'provider-options', 'scalar.yaml'), 'read\n');
      const raw = {
        name: 'non-object-provider-options-ref',
        workflow_config: {
          provider_options: {
            $ref: 'provider-options/scalar.yaml',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, tempDir)).toThrow(/must point to a YAML object/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('provider_options の $ref に absolute path を指定したら reject する', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-absolute-'));
    try {
      const secretPath = join(tempDir, 'secret.yaml');
      writeFileSync(secretPath, 'opencode:\n  allowed_tools:\n    - read\n');
      const raw = {
        name: 'absolute-provider-options-ref',
        workflow_config: {
          provider_options: {
            $ref: secretPath,
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, tempDir)).toThrow(/relative path inside the workflow directory/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('provider_options の $ref が workflowDir 外へ出る場合は reject する', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-root-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-outside-'));
    try {
      const secretPath = join(outsideDir, 'secret.yaml');
      writeFileSync(secretPath, 'opencode:\n  allowed_tools:\n    - read\n');
      const raw = {
        name: 'escaping-provider-options-ref',
        workflow_config: {
          provider_options: {
            $ref: relative(tempDir, secretPath),
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, tempDir)).toThrow(/stay inside the workflow directory/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('provider_options の $ref が workflowDir 内 symlink 経由で外部実体を指す場合は reject する', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-symlink-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-symlink-outside-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      const secretPath = join(outsideDir, 'secret.yaml');
      writeFileSync(secretPath, 'opencode:\n  allowed_tools:\n    - read\n');
      symlinkSync(secretPath, join(tempDir, 'provider-options', 'link.yaml'));
      const raw = {
        name: 'symlink-provider-options-ref',
        workflow_config: {
          provider_options: {
            $ref: 'provider-options/link.yaml',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, tempDir)).toThrow(/stay inside the workflow directory/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('promotion entry の provider_options $ref を解決し inline で上書きできる', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-promotion-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      writeFileSync(join(tempDir, 'provider-options', 'review.yaml'), [
        'opencode:',
        '  allowed_tools:',
        '    - read',
        '    - glob',
      ].join('\n'));
      const raw = {
        name: 'promotion-provider-options-ref',
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
            promotion: [
              {
                at: 2,
                provider_options: {
                  $ref: 'provider-options/review.yaml',
                  opencode: {
                    allowed_tools: ['read', 'bash'],
                  },
                },
              },
            ],
          },
        ],
      };

      const config = normalizeWorkflowConfig(raw, tempDir);
      const step = config.steps[0];
      if (step?.kind !== 'agent') {
        throw new Error('expected an agent step');
      }

      expect(step.promotion?.[0]?.providerOptions).toEqual({
        opencode: { allowedTools: ['read', 'bash'] },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('workflow_call overrides の provider_options $ref を解決し inline で上書きできる', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-workflow-call-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      writeFileSync(join(tempDir, 'provider-options', 'review.yaml'), [
        'claude:',
        '  allowed_tools:',
        '    - Read',
        'opencode:',
        '  allowed_tools:',
        '    - read',
      ].join('\n'));
      const raw = {
        name: 'workflow-call-provider-options-ref',
        steps: [
          {
            name: 'delegate',
            kind: 'workflow_call',
            call: 'child',
            overrides: {
              provider_options: {
                $ref: 'provider-options/review.yaml',
                opencode: {
                  allowed_tools: ['read', 'bash'],
                },
              },
            },
            rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
          },
        ],
      };

      const config = normalizeWorkflowConfig(raw, tempDir);
      const step = config.steps[0];
      if (step?.kind !== 'workflow_call') {
        throw new Error('expected a workflow_call step');
      }

      expect(step.overrides?.providerOptions).toEqual({
        claude: { allowedTools: ['Read'] },
        opencode: { allowedTools: ['read', 'bash'] },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('workflow_call overrides の空 provider_options を reject する', () => {
    const raw = {
      name: 'workflow-call-empty-provider-options',
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          overrides: {
            provider_options: {},
          },
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, process.cwd())).toThrow(
      /workflow_call overrides provider_options must include at least one provider-specific option/,
    );
  });

  it('workflow_call overrides の provider_options $ref が空 options に解決されたら reject する', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-empty-ref-workflow-call-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      writeFileSync(join(tempDir, 'provider-options', 'empty.yaml'), '{}\n');
      const raw = {
        name: 'workflow-call-empty-provider-options-ref',
        steps: [
          {
            name: 'delegate',
            kind: 'workflow_call',
            call: 'child',
            overrides: {
              provider_options: {
                $ref: 'provider-options/empty.yaml',
              },
            },
            rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, tempDir)).toThrow(
        /workflow_call overrides require at least one of 'provider', 'model', or 'provider_options'/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('parallel sub-step の provider_options $ref を解決し inline で上書きできる', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-parallel-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      writeFileSync(join(tempDir, 'provider-options', 'review.yaml'), [
        'claude:',
        '  allowed_tools:',
        '    - Read',
        'opencode:',
        '  allowed_tools:',
        '    - read',
        '    - glob',
      ].join('\n'));
      const raw = {
        name: 'parallel-provider-options-ref',
        steps: [
          {
            name: 'reviewers',
            instruction: '{task}',
            parallel: [
              {
                name: 'coding-review',
                instruction: '{task}',
                provider_options: {
                  $ref: 'provider-options/review.yaml',
                  opencode: {
                    allowed_tools: ['read', 'grep'],
                  },
                },
              },
            ],
          },
        ],
      };

      const config = normalizeWorkflowConfig(raw, tempDir);
      const step = config.steps[0];
      if (step?.kind !== 'agent') {
        throw new Error('expected an agent step');
      }

      expect(step.parallel?.[0]?.providerOptions).toEqual({
        claude: { allowedTools: ['Read'] },
        opencode: { allowedTools: ['read', 'grep'] },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('kiro agent を workflow-level で設定し step で上書きできる', () => {
    const raw = {
      name: 'kiro-agent',
      workflow_config: {
        provider_options: {
          kiro: {
            agent: 'default-agent',
          },
        },
      },
      steps: [
        {
          name: 'inherit',
          provider: 'kiro',
          instruction: '{task}',
        },
        {
          name: 'override',
          provider: 'kiro',
          provider_options: {
            kiro: {
              agent: 'coder-agent',
            },
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      kiro: { agent: 'default-agent' },
    });
    expect(config.steps[0]?.providerOptions).toEqual({
      kiro: { agent: 'default-agent' },
    });
    expect(config.steps[1]?.providerOptions).toEqual({
      kiro: { agent: 'coder-agent' },
    });
  });

  it('kiro agent に空文字を指定したら reject する', () => {
    const raw = {
      name: 'kiro-agent-empty',
      steps: [
        {
          name: 'plan',
          provider: 'kiro',
          provider_options: {
            kiro: {
              agent: '',
            },
          },
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, process.cwd())).toThrow();
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

  it('kiro.agent を後の層が優先でマージする', () => {
    const global = {
      kiro: { agent: 'global-agent' },
    };
    const step = {
      kiro: { agent: 'step-agent' },
    };

    expect(mergeProviderOptions(global, step)).toEqual({
      kiro: { agent: 'step-agent' },
    });
    expect(mergeProviderOptions(global, undefined)).toEqual({
      kiro: { agent: 'global-agent' },
    });
  });

  it('opencode.allowedTools を後の層が優先でマージする', () => {
    const global = {
      opencode: { allowedTools: ['read', 'glob'] },
    };
    const step = {
      opencode: { allowedTools: ['read', 'edit', 'bash'] },
    };

    expect(mergeProviderOptions(global as never, step as never)).toEqual({
      opencode: { allowedTools: ['read', 'edit', 'bash'] },
    });
  });

  it('すべて undefined なら undefined を返す', () => {
    expect(mergeProviderOptions(undefined, undefined, undefined)).toBeUndefined();
  });
});
