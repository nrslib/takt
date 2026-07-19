import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';
import { mergeProviderOptions } from '../infra/config/providerOptions.js';

function writeProviderOptionsPreset(providerOptionsDir: string, name: string, lines: string[]): void {
  mkdirSync(providerOptionsDir, { recursive: true });
  writeFileSync(join(providerOptionsDir, `${name}.yaml`), lines.join('\n'));
}

function withTaktConfigDir<T>(configDir: string, run: () => T): T {
  const originalConfigDir = process.env.TAKT_CONFIG_DIR;
  process.env.TAKT_CONFIG_DIR = configDir;
  try {
    return run();
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
  }
}

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

  it('base_url provider_options を workflow-level で設定し step で上書きできる', () => {
    const raw = {
      name: 'provider-option-base-url',
      workflow_config: {
        provider_options: {
          codex: { base_url: 'http://127.0.0.1:8787/v1' },
          claude: { base_url: 'http://localhost:8787' },
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
            codex: { base_url: 'http://127.0.0.2:8787/v1' },
            claude: { base_url: 'http://proxy.localhost:8787' },
          },
          instruction: '{task}',
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.providerOptions).toEqual({
      codex: { baseUrl: 'http://127.0.0.1:8787/v1' },
      claude: { baseUrl: 'http://localhost:8787' },
    });
    expect(config.steps[0]?.providerOptions).toEqual({
      codex: { baseUrl: 'http://127.0.0.1:8787/v1' },
      claude: { baseUrl: 'http://localhost:8787' },
    });
    expect(config.steps[1]?.providerOptions).toEqual({
      codex: { baseUrl: 'http://127.0.0.2:8787/v1' },
      claude: { baseUrl: 'http://proxy.localhost:8787' },
    });
  });

  it('workflow 由来の非 loopback base_url を拒否する', () => {
    const raw = {
      name: 'provider-option-external-base-url',
      steps: [
        {
          name: 'implement',
          provider_options: {
            codex: { base_url: 'https://attacker.example.test/v1' },
          },
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, process.cwd()))
      .toThrow(/provider_options\.codex\.base_url must use a loopback base_url/);
  });

  it('workflow 由来 auto_routing candidate の非 loopback base_url を拒否する', () => {
    const raw = {
      name: 'auto-routing-external-base-url',
      workflow_config: {
        provider: 'mock',
      },
      auto_routing: {
        strategy: 'cost',
        router: {
          provider: 'claude-sdk',
          model: 'claude-haiku-4-5-20251001',
        },
        candidates: [
	          {
	            name: 'coding',
	            description: 'Implementation',
	            provider: 'codex',
	            model: 'gpt-5',
	            cost_tier: 'medium',
	            provider_options: {
	              codex: { base_url: 'https://attacker.example.test/v1' },
	            },
	          },
	          {
	            name: 'lightweight',
	            description: 'Formatting',
	            provider: 'claude-sdk',
	            model: 'claude-haiku-4-5-20251001',
	            cost_tier: 'low',
	          },
	        ],
	      },
      steps: [
        {
          name: 'implement',
          instruction: '{task}',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, process.cwd()))
      .toThrow(/auto_routing\.candidates\[0\]\.provider_options\.codex\.base_url must use a loopback base_url/);
  });

  it('workflow 由来 auto_routing candidate の loopback base_url を許可する', () => {
    const raw = {
      name: 'auto-routing-loopback-base-url',
      workflow_config: {
        provider: 'mock',
      },
      auto_routing: {
        strategy: 'cost',
        router: {
          provider: 'claude-sdk',
          model: 'claude-haiku-4-5-20251001',
        },
        candidates: [
	          {
	            name: 'coding',
	            description: 'Implementation',
	            provider: 'codex',
	            model: 'gpt-5',
	            cost_tier: 'medium',
	            provider_options: {
	              codex: { base_url: 'http://127.0.0.1:8787/v1' },
	            },
	          },
	          {
	            name: 'lightweight',
	            description: 'Formatting',
	            provider: 'claude-sdk',
	            model: 'claude-haiku-4-5-20251001',
	            cost_tier: 'low',
	          },
	        ],
	      },
      steps: [
        {
          name: 'implement',
          instruction: '{task}',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());

    expect(config.autoRouting?.candidates[0]?.providerOptions).toEqual({
      codex: { baseUrl: 'http://127.0.0.1:8787/v1' },
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

  it('provider_options の extends を workflowDir 相対で解決し inline で上書きできる', () => {
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
            extends: 'provider-options/review-readonly.yaml',
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
              extends: 'provider-options/review-readonly.yaml',
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

  it('provider_options の削除済み参照キーは reject する', () => {
    const removedReferenceKey = `$${'ref'}`;
    const raw = {
      name: 'removed-provider-options-reference-key',
      workflow_config: {
        provider_options: {
          [removedReferenceKey]: 'provider-options/review-readonly.yaml',
        },
      },
      steps: [
        {
          name: 'plan',
          instruction: '{task}',
        },
      ],
    };

    expect(() => normalizeWorkflowConfig(raw, process.cwd())).toThrow(/Unrecognized key/);
  });

  it('provider_options の名前 extends は project provider-options を global より優先する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-project-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-global-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      writeProviderOptionsPreset(
        join(projectDir, '.takt', 'provider-options'),
        'review-readonly',
        [
          'claude:',
          '  allowed_tools:',
          '    - ProjectRead',
        ],
      );
      writeProviderOptionsPreset(
        join(globalConfigDir, 'provider-options'),
        'review-readonly',
        [
          'claude:',
          '  allowed_tools:',
          '    - GlobalRead',
        ],
      );
      const raw = {
        name: 'named-provider-options-project',
        workflow_config: {
          provider_options: {
            extends: 'review-readonly',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      const config = withTaktConfigDir(globalConfigDir, () => normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir: join(globalConfigDir, 'repertoire'),
      }));

      expect(config.providerOptions).toEqual({
        claude: { allowedTools: ['ProjectRead'] },
      });
      expect(config.steps[0]?.providerOptions).toEqual({
        claude: { allowedTools: ['ProjectRead'] },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('provider_options の名前 extends は project provider-options の .yml も解決する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-yml-project-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-yml-global-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      const providerOptionsDir = join(projectDir, '.takt', 'provider-options');
      mkdirSync(workflowDir, { recursive: true });
      mkdirSync(providerOptionsDir, { recursive: true });
      writeFileSync(join(providerOptionsDir, 'review-yml.yml'), [
        'opencode:',
        '  allowed_tools:',
        '    - project-yml-read',
      ].join('\n'));
      const raw = {
        name: 'named-provider-options-yml',
        workflow_config: {
          provider_options: {
            extends: 'review-yml',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      const config = withTaktConfigDir(globalConfigDir, () => normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir: join(globalConfigDir, 'repertoire'),
      }));

      expect(config.providerOptions).toEqual({
        opencode: { allowedTools: ['project-yml-read'] },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('provider_options の名前 extends は project に無い場合 global provider-options を解決する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-global-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-global-config-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      writeProviderOptionsPreset(
        join(globalConfigDir, 'provider-options'),
        'review-readonly',
        [
          'opencode:',
          '  allowed_tools:',
          '    - global-read',
        ],
      );
      const raw = {
        name: 'named-provider-options-global',
        workflow_config: {
          provider_options: {
            extends: 'review-readonly',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      const config = withTaktConfigDir(globalConfigDir, () => normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir: join(globalConfigDir, 'repertoire'),
      }));

      expect(config.providerOptions).toEqual({
        opencode: { allowedTools: ['global-read'] },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('provider_options の名前 extends は project/global に無い場合 builtin provider-options を解決する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-builtin-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-builtin-global-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      const raw = {
        name: 'named-provider-options-builtin',
        workflow_config: {
          provider_options: {
            extends: 'review-files',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      const config = withTaktConfigDir(globalConfigDir, () => normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir: join(globalConfigDir, 'repertoire'),
      }));

      expect(config.providerOptions).toEqual({
        claude: { allowedTools: ['Read', 'Glob', 'Grep'] },
        opencode: { allowedTools: ['read', 'glob', 'grep'] },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('provider_options の名前 extends は inline provider_options で leaf 上書きできる', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-inline-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      writeProviderOptionsPreset(
        join(projectDir, '.takt', 'provider-options'),
        'review-readonly',
        [
          'codex:',
          '  network_access: true',
          'opencode:',
          '  allowed_tools:',
          '    - read',
          '    - glob',
        ],
      );
      const raw = {
        name: 'named-provider-options-inline',
        workflow_config: {
          provider_options: {
            extends: 'review-readonly',
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

      const config = normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir: join(projectDir, '.takt', 'repertoire'),
      });

      expect(config.providerOptions).toEqual({
        codex: { networkAccess: true },
        opencode: { allowedTools: ['read', 'bash'] },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('repertoire workflow 内の provider_options 名前 extends は package-local provider-options を最優先する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-package-project-'));
    const repertoireDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-package-repertoire-'));
    try {
      const workflowDir = join(repertoireDir, '@nrslib', 'takt-review', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      writeProviderOptionsPreset(
        join(repertoireDir, '@nrslib', 'takt-review', 'provider-options'),
        'review',
        [
          'claude:',
          '  allowed_tools:',
          '    - PackageRead',
        ],
      );
      writeProviderOptionsPreset(
        join(projectDir, '.takt', 'provider-options'),
        'review',
        [
          'claude:',
          '  allowed_tools:',
          '    - ProjectRead',
        ],
      );
      const raw = {
        name: 'package-local-provider-options',
        workflow_config: {
          provider_options: {
            extends: 'review',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      const config = normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir,
      });

      expect(config.providerOptions).toEqual({
        claude: { allowedTools: ['PackageRead'] },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(repertoireDir, { recursive: true, force: true });
    }
  });

  it('provider_options の @scope extends は repertoire package の provider-options を解決する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-scope-project-'));
    const repertoireDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-scope-repertoire-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      writeProviderOptionsPreset(
        join(repertoireDir, '@nrslib', 'takt-review', 'provider-options'),
        'review-readonly',
        [
          'opencode:',
          '  allowed_tools:',
          '    - scope-read',
        ],
      );
      const raw = {
        name: 'scope-provider-options',
        workflow_config: {
          provider_options: {
            extends: '@nrslib/takt-review/review-readonly',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      const config = normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir,
      });

      expect(config.providerOptions).toEqual({
        opencode: { allowedTools: ['scope-read'] },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(repertoireDir, { recursive: true, force: true });
    }
  });

  it('provider_options の @scope extends 内の相対 extends は scoped preset のディレクトリ基準で解決する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-scope-relative-project-'));
    const repertoireDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-scope-relative-repertoire-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      const providerOptionsDir = join(repertoireDir, '@nrslib', 'takt-review', 'provider-options');
      mkdirSync(workflowDir, { recursive: true });
      writeProviderOptionsPreset(providerOptionsDir, 'base', [
        'claude:',
        '  allowed_tools:',
        '    - ScopeBaseRead',
      ]);
      writeProviderOptionsPreset(providerOptionsDir, 'review', [
        'extends: base.yaml',
        'opencode:',
        '  allowed_tools:',
        '    - scope-review',
      ]);
      const raw = {
        name: 'scoped-provider-options-relative-ref',
        workflow_config: {
          provider_options: {
            extends: '@nrslib/takt-review/review',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      const config = normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir,
      });

      expect(config.providerOptions).toEqual({
        claude: { allowedTools: ['ScopeBaseRead'] },
        opencode: { allowedTools: ['scope-review'] },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(repertoireDir, { recursive: true, force: true });
    }
  });

  it('provider_options の名前 extends が candidate dir 内 symlink 経由で外部実体を指す場合は reject する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-symlink-project-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-symlink-outside-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      const providerOptionsDir = join(projectDir, '.takt', 'provider-options');
      mkdirSync(workflowDir, { recursive: true });
      mkdirSync(providerOptionsDir, { recursive: true });
      const secretPath = join(outsideDir, 'secret.yaml');
      writeFileSync(secretPath, 'opencode:\n  allowed_tools:\n    - outside-read\n');
      symlinkSync(secretPath, join(providerOptionsDir, 'linked.yaml'));
      const raw = {
        name: 'named-provider-options-symlink',
        workflow_config: {
          provider_options: {
            extends: 'linked',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir: join(projectDir, '.takt', 'repertoire'),
      })).toThrow(/named resource must stay inside its candidate directory: linked/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('provider_options の名前 extends が symlink の project provider-options directory を使う場合は reject する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-dir-symlink-project-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-dir-symlink-outside-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      mkdirSync(join(projectDir, '.takt'), { recursive: true });
      writeProviderOptionsPreset(outsideDir, 'linked-dir', [
        'opencode:',
        '  allowed_tools:',
        '    - outside-read',
      ]);
      symlinkSync(outsideDir, join(projectDir, '.takt', 'provider-options'));
      const raw = {
        name: 'named-provider-options-dir-symlink',
        workflow_config: {
          provider_options: {
            extends: 'linked-dir',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir: join(projectDir, '.takt', 'repertoire'),
      })).toThrow(/candidate directory must not be a symlink/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('provider_options の @scope extends が package provider-options 内 symlink 経由で外部実体を指す場合は reject する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-scope-symlink-project-'));
    const repertoireDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-scope-symlink-repertoire-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-scope-symlink-outside-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      const providerOptionsDir = join(repertoireDir, '@nrslib', 'takt-review', 'provider-options');
      mkdirSync(workflowDir, { recursive: true });
      mkdirSync(providerOptionsDir, { recursive: true });
      const secretPath = join(outsideDir, 'secret.yaml');
      writeFileSync(secretPath, 'opencode:\n  allowed_tools:\n    - outside-read\n');
      symlinkSync(secretPath, join(providerOptionsDir, 'linked.yaml'));
      const raw = {
        name: 'scoped-provider-options-symlink',
        workflow_config: {
          provider_options: {
            extends: '@nrslib/takt-review/linked',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir,
      })).toThrow(/named resource must stay inside its candidate directory: linked/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(repertoireDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('provider_options の @scope extends が symlink の package provider-options directory を使う場合は reject する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-scope-dir-symlink-project-'));
    const repertoireDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-scope-dir-symlink-repertoire-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-scope-dir-symlink-outside-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      const packageDir = join(repertoireDir, '@nrslib', 'takt-review');
      mkdirSync(workflowDir, { recursive: true });
      mkdirSync(packageDir, { recursive: true });
      writeProviderOptionsPreset(outsideDir, 'linked-dir', [
        'opencode:',
        '  allowed_tools:',
        '    - outside-read',
      ]);
      symlinkSync(outsideDir, join(packageDir, 'provider-options'));
      const raw = {
        name: 'scoped-provider-options-dir-symlink',
        workflow_config: {
          provider_options: {
            extends: '@nrslib/takt-review/linked-dir',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir,
      })).toThrow(/candidate directory must not be a symlink/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(repertoireDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('provider_options の名前 extends が存在しない場合は参照名を含めて reject する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-missing-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-missing-global-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      const raw = {
        name: 'missing-named-provider-options-ref',
        workflow_config: {
          provider_options: {
            extends: 'missing-preset',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => withTaktConfigDir(globalConfigDir, () => normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir: join(projectDir, '.takt', 'repertoire'),
      }))).toThrow(/provider_options\.extends not found: missing-preset/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('provider_options の @scope extends が存在しない場合は scope ref を含めて reject する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-scope-missing-project-'));
    const repertoireDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-scope-missing-repertoire-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      const raw = {
        name: 'missing-scoped-provider-options-ref',
        workflow_config: {
          provider_options: {
            extends: '@nrslib/takt-review/missing',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir,
      })).toThrow(/provider_options\.extends not found: @nrslib\/takt-review\/missing/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(repertoireDir, { recursive: true, force: true });
    }
  });

  it('provider_options の @scope extends は repertoireDir がない場合 reject する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-scope-no-repertoire-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      const raw = {
        name: 'scope-provider-options-without-repertoire',
        workflow_config: {
          provider_options: {
            extends: '@nrslib/takt-review/review-readonly',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      expect(() => normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
      })).toThrow(/requires repertoireDir/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('provider_options の nested 名前 extends は参照元層以降だけを探索する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-nested-layer-project-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-nested-layer-global-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      writeProviderOptionsPreset(join(projectDir, '.takt', 'provider-options'), 'base', [
        'claude:',
        '  allowed_tools:',
        '    - ProjectRead',
      ]);
      writeProviderOptionsPreset(join(globalConfigDir, 'provider-options'), 'review', [
        'extends: base',
        'opencode:',
        '  allowed_tools:',
        '    - global-review',
      ]);
      writeProviderOptionsPreset(join(globalConfigDir, 'provider-options'), 'base', [
        'claude:',
        '  allowed_tools:',
        '    - GlobalRead',
      ]);
      const raw = {
        name: 'nested-provider-options-layer-boundary',
        workflow_config: {
          provider_options: {
            extends: 'review',
          },
        },
        steps: [
          {
            name: 'plan',
            instruction: '{task}',
          },
        ],
      };

      const config = withTaktConfigDir(globalConfigDir, () => normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir: join(projectDir, '.takt', 'repertoire'),
      }));

      expect(config.providerOptions).toEqual({
        claude: { allowedTools: ['GlobalRead'] },
        opencode: { allowedTools: ['global-review'] },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('provider_options の名前 extends を workflow/step/promotion/workflow_call/parallel に配線する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-name-wire-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      const providerOptionsDir = join(projectDir, '.takt', 'provider-options');
      mkdirSync(workflowDir, { recursive: true });
      writeProviderOptionsPreset(providerOptionsDir, 'workflow-preset', [
        'codex:',
        '  network_access: true',
      ]);
      writeProviderOptionsPreset(providerOptionsDir, 'step-preset', [
        'opencode:',
        '  variant: step-variant',
      ]);
      writeProviderOptionsPreset(providerOptionsDir, 'promotion-preset', [
        'claude:',
        '  allowed_tools:',
        '    - PromotionRead',
      ]);
      writeProviderOptionsPreset(providerOptionsDir, 'call-preset', [
        'opencode:',
        '  allowed_tools:',
        '    - call-read',
      ]);
      writeProviderOptionsPreset(providerOptionsDir, 'parallel-preset', [
        'claude:',
        '  sandbox:',
        '    allow_unsandboxed_commands: true',
      ]);
      const raw = {
        name: 'provider-options-name-wiring',
        workflow_config: {
          provider_options: {
            extends: 'workflow-preset',
          },
        },
        steps: [
          {
            name: 'implement',
            instruction: '{task}',
            provider_options: {
              extends: 'step-preset',
            },
            promotion: [
              {
                at: 2,
                provider_options: {
                  extends: 'promotion-preset',
                },
              },
            ],
          },
          {
            name: 'delegate',
            kind: 'workflow_call',
            call: 'child',
            overrides: {
              provider_options: {
                extends: 'call-preset',
              },
            },
            rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
          },
          {
            name: 'reviewers',
            instruction: '{task}',
            parallel: [
              {
                name: 'parallel-review',
                instruction: '{task}',
                provider_options: {
                  extends: 'parallel-preset',
                },
              },
            ],
          },
        ],
      };

      const config = normalizeWorkflowConfig(raw, workflowDir, {
        lang: 'en',
        projectDir,
        workflowDir,
        repertoireDir: join(projectDir, '.takt', 'repertoire'),
      });
      const implementStep = config.steps[0];
      const delegateStep = config.steps[1];
      const reviewersStep = config.steps[2];
      if (implementStep?.kind !== 'agent') {
        throw new Error('expected implement to be an agent step');
      }
      if (delegateStep?.kind !== 'workflow_call') {
        throw new Error('expected delegate to be a workflow_call step');
      }
      if (reviewersStep?.kind !== 'agent') {
        throw new Error('expected reviewers to be an agent step');
      }

      expect(config.providerOptions).toEqual({
        codex: { networkAccess: true },
      });
      expect(implementStep.providerOptions).toEqual({
        codex: { networkAccess: true },
        opencode: { variant: 'step-variant' },
      });
      expect(implementStep.promotion?.[0]?.providerOptions).toEqual({
        claude: { allowedTools: ['PromotionRead'] },
      });
      expect(delegateStep.overrides?.providerOptions).toEqual({
        opencode: { allowedTools: ['call-read'] },
      });
      expect(reviewersStep.parallel?.[0]?.providerOptions).toEqual({
        codex: { networkAccess: true },
        claude: { sandbox: { allowUnsandboxedCommands: true } },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('loadWorkflowFromFile は project provider-options の名前 extends を workflow loader context で解決する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-loader-project-'));
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-loader-global-'));
    try {
      const workflowDir = join(projectDir, '.takt', 'workflows');
      const workflowPath = join(workflowDir, 'named-provider-options.yaml');
      mkdirSync(workflowDir, { recursive: true });
      writeProviderOptionsPreset(
        join(projectDir, '.takt', 'provider-options'),
        'review-readonly',
        [
          'claude:',
          '  allowed_tools:',
          '    - LoaderRead',
        ],
      );
      writeFileSync(workflowPath, [
        'name: named-provider-options-loader',
        'workflow_config:',
        '  provider_options:',
        '    extends: review-readonly',
        'steps:',
        '  - name: plan',
        '    instruction: "{task}"',
      ].join('\n'));

      const config = withTaktConfigDir(globalConfigDir, () => loadWorkflowFromFile(workflowPath, projectDir));

      expect(config.providerOptions).toEqual({
        claude: { allowedTools: ['LoaderRead'] },
      });
      expect(config.steps[0]?.providerOptions).toEqual({
        claude: { allowedTools: ['LoaderRead'] },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(globalConfigDir, { recursive: true, force: true });
    }
  });

  it('provider_options の extends が存在しない場合は参照パスを含めて reject する', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-missing-'));
    try {
      const raw = {
        name: 'missing-provider-options-ref',
        workflow_config: {
          provider_options: {
            extends: 'provider-options/missing.yaml',
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

  it('provider_options の extends 先も inline と同じ schema で検証する', () => {
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
            extends: 'provider-options/invalid.yaml',
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

  it('provider_options の nested extends を解決し inline で上書きできる', () => {
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
        'extends: base.yaml',
        'opencode:',
        '  allowed_tools:',
        '    - read',
        '    - grep',
      ].join('\n'));
      const raw = {
        name: 'nested-provider-options-ref',
        workflow_config: {
          provider_options: {
            extends: 'provider-options/review.yaml',
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

  it('provider_options の extends が循環参照する場合は reject する', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-circular-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      writeFileSync(join(tempDir, 'provider-options', 'a.yaml'), 'extends: b.yaml\n');
      writeFileSync(join(tempDir, 'provider-options', 'b.yaml'), 'extends: a.yaml\n');
      const raw = {
        name: 'circular-provider-options-ref',
        workflow_config: {
          provider_options: {
            extends: 'provider-options/a.yaml',
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

  it('provider_options の extends 先 YAML が object でない場合は reject する', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-non-object-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      writeFileSync(join(tempDir, 'provider-options', 'scalar.yaml'), 'read\n');
      const raw = {
        name: 'non-object-provider-options-ref',
        workflow_config: {
          provider_options: {
            extends: 'provider-options/scalar.yaml',
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

  it('provider_options の extends に absolute path を指定したら reject する', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-absolute-'));
    try {
      const secretPath = join(tempDir, 'secret.yaml');
      writeFileSync(secretPath, 'opencode:\n  allowed_tools:\n    - read\n');
      const raw = {
        name: 'absolute-provider-options-ref',
        workflow_config: {
          provider_options: {
            extends: secretPath,
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

  it('provider_options の extends が workflowDir 外へ出る場合は reject する', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-root-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'takt-provider-options-ref-outside-'));
    try {
      const secretPath = join(outsideDir, 'secret.yaml');
      writeFileSync(secretPath, 'opencode:\n  allowed_tools:\n    - read\n');
      const raw = {
        name: 'escaping-provider-options-ref',
        workflow_config: {
          provider_options: {
            extends: relative(tempDir, secretPath),
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

  it('provider_options の extends が workflowDir 内 symlink 経由で外部実体を指す場合は reject する', () => {
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
            extends: 'provider-options/link.yaml',
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

  it('promotion entry の provider_options extends を解決し inline で上書きできる', () => {
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
                  extends: 'provider-options/review.yaml',
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

  it('workflow_call overrides の provider_options extends を解決し inline で上書きできる', () => {
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
                extends: 'provider-options/review.yaml',
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

  it('workflow_call overrides の provider_options extends が空 options に解決されたら reject する', () => {
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
                extends: 'provider-options/empty.yaml',
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

  it('parallel sub-step の provider_options extends を解決し inline で上書きできる', () => {
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
                  extends: 'provider-options/review.yaml',
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
