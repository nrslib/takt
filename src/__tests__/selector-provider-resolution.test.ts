import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowConfig } from '../core/models/types.js';
import {
  resolveSelectorProviderFromConfig,
} from '../infra/config/selectorProviderResolution.js';
import { resolveWorkflowSelector } from '../infra/config/workflowSelectorResolution.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
  loadWorkflowByIdentifier,
} from '../infra/config/index.js';
import { resolveAuxiliaryRuntimeEnvironment } from '../infra/config/runtime-provider/provider-environment.js';

describe('selector provider resolution', () => {
  it.each([
    ['CLI override', { overrides: { model: '   ' } }],
    ['project selector', {
      local: { taktProviders: { selector: { model: '   ' } } },
    }],
    ['global selector', {
      global: { taktProviders: { selector: { model: '   ' } } },
    }],
    ['project top-level fallback', { local: { model: '   ' } }],
    ['global top-level fallback', { global: { model: '   ' } }],
  ])('should reject a blank model from the %s candidate boundary', (_label, testCase) => {
    expect(() => resolveSelectorProviderFromConfig({
      local: testCase.local ?? {},
      global: testCase.global ?? {},
    }, testCase.overrides)).toThrow(/model must not be empty/);
  });

  it('should prioritize CLI provider and model over project and global selector configuration', () => {
    const resolved = resolveSelectorProviderFromConfig({
      local: {
        provider: 'codex',
        model: 'project-default',
        taktProviders: {
          selector: { provider: 'claude', model: 'project-selector' },
        },
      },
      global: {
        provider: 'opencode',
        model: 'global-default',
        taktProviders: {
          selector: { provider: 'codex', model: 'global-selector' },
        },
      },
    }, {
      provider: 'mock',
      model: 'cli-selector',
    });

    expect(resolved).toMatchObject({ provider: 'mock', model: 'cli-selector', providerSource: 'cli', modelSource: 'cli' });
  });

  it('should select a model only from candidates for the resolved selector provider', () => {
    const resolved = resolveSelectorProviderFromConfig({
      local: {
        taktProviders: {
          selector: { provider: 'claude', model: 'project-claude-model' },
        },
      },
      global: {
        taktProviders: {
          selector: { provider: 'codex', model: 'global-codex-model' },
        },
      },
    });

    expect(resolved).toMatchObject({ provider: 'claude', model: 'project-claude-model' });
  });

  it('should resolve top-level provider and model for an options-only selector and merge selector options by leaf', () => {
    const resolved = resolveSelectorProviderFromConfig({
      local: {
        provider: 'codex',
        model: 'project-codex-model',
        taktProviders: {
          selector: {
            providerOptions: {
              codex: { reasoningEffort: 'medium' },
            },
          },
        },
      },
      global: {
        taktProviders: {
          selector: {
            providerOptions: {
              codex: { networkAccess: false },
            },
          },
        },
      },
    });

    expect(resolved).toMatchObject({
      provider: 'codex',
      model: 'project-codex-model',
      providerSource: 'project',
      modelSource: 'project',
    });
    expect(resolved.providerOptions).toEqual({
      codex: { reasoningEffort: 'medium', networkAccess: false },
    });
  });

  it('should retain independent provider and model sources', () => {
    const resolved = resolveSelectorProviderFromConfig({
      local: { provider: 'codex', model: 'project-model' },
      global: { provider: 'claude', model: 'global-model' },
    }, {
      provider: 'mock',
      providerSource: 'env',
      model: 'cli-model',
      modelSource: 'cli',
    });

    expect(resolved).toMatchObject({
      provider: 'mock',
      model: 'cli-model',
      providerSource: 'env',
      modelSource: 'cli',
    });
  });

  it('should pass only applicable option branches to the resolved selector provider', () => {
    const resolved = resolveSelectorProviderFromConfig({
      local: {
        taktProviders: {
          selector: {
            provider: 'claude-terminal',
            providerOptions: {
              codex: { reasoningEffort: 'high' },
              claudeTerminal: { timeoutMs: 4_000 },
            },
          },
        },
      },
      global: {
        taktProviders: {
          selector: {
            providerOptions: {
              codex: { networkAccess: true },
              claude: { allowedTools: ['Read'] },
            },
          },
        },
      },
    });

    expect(resolved.providerOptions).toEqual({
      claude: { allowedTools: ['Read'] },
      claudeTerminal: { timeoutMs: 4_000 },
    });
  });

  it('should exclude foreign provider options for codex selectors', () => {
    const resolved = resolveSelectorProviderFromConfig({
      local: {
        taktProviders: {
          selector: {
            provider: 'codex',
            providerOptions: {
              codex: { reasoningEffort: 'medium' },
              claude: { allowedTools: ['Read'] },
            },
          },
        },
      },
      global: {},
    });

    expect(resolved.providerOptions).toEqual({ codex: { reasoningEffort: 'medium' } });
  });

  it('should pass Pi selector resource options to the resolved provider', () => {
    const resolved = resolveSelectorProviderFromConfig({
      local: {
        taktProviders: {
          selector: {
            provider: 'pi',
            providerOptions: {
              pi: { extensions: ['npm:pi-fff'], noSkills: true },
              codex: { reasoningEffort: 'medium' },
            },
          },
        },
      },
      global: {},
    });

    expect(resolved.providerOptions).toEqual({
      pi: { extensions: ['npm:pi-fff'], noSkills: true },
    });
  });

  it('should validate an OpenCode provider after composing its top-level model', () => {
    const resolved = resolveSelectorProviderFromConfig({
      local: {
        provider: 'opencode',
        model: 'opencode/big-pickle',
        taktProviders: {
          selector: { provider: 'opencode' },
        },
      },
      global: {},
    });

    expect(resolved).toMatchObject({
      provider: 'opencode',
      model: 'opencode/big-pickle',
      providerSource: 'project',
      modelSource: 'project',
    });
  });

  it('should compose an OpenCode selector provider with a model from another config scope', () => {
    const resolved = resolveSelectorProviderFromConfig({
      local: {
        taktProviders: {
          selector: { provider: 'opencode' },
        },
      },
      global: {
        taktProviders: {
          selector: { model: 'opencode/big-pickle' },
        },
      },
    });

    expect(resolved).toMatchObject({
      provider: 'opencode',
      model: 'opencode/big-pickle',
      providerSource: 'project',
      modelSource: 'global',
    });
  });

  it('should reject an OpenCode selector only after all model candidates are exhausted', () => {
    expect(() => resolveSelectorProviderFromConfig({
      local: {
        taktProviders: {
          selector: { provider: 'opencode' },
        },
      },
      global: {},
    })).toThrow(/provider 'opencode' requires model/);
  });
});

describe('workflow selector resolution', () => {
  const roots: string[] = [];
  const originalConfigDir = process.env.TAKT_CONFIG_DIR;

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  function createProject(config: string): string {
    const root = mkdtempSync(join(tmpdir(), 'takt-workflow-selector-resolution-'));
    const globalDir = join(root, 'global');
    mkdirSync(join(root, '.takt', 'workflows'), { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(root, '.takt', 'config.yaml'), config, 'utf-8');
    process.env.TAKT_CONFIG_DIR = globalDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    roots.push(root);
    return root;
  }

  function makeDynamicWorkflow(): WorkflowConfig {
    return {
      name: 'dynamic',
      initialStep: 'reviewers',
      maxSteps: 1,
      steps: [{
        name: 'reviewers',
        instruction: 'Review',
        parallel: {
          kind: 'dynamic',
          fixed: [],
          pool: [{
            name: 'security',
            description: 'Review security',
            instruction: 'Review security',
            personaDisplayName: 'security',
            rules: [{ condition: 'approved' }],
          }],
          selection: { mode: 'replace' },
        },
        personaDisplayName: 'reviewers',
        rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
      }],
    };
  }

  function resolveWorkflowSelectorForProject(
    workflow: WorkflowConfig,
    projectDir: string,
    options: { companionEnabled?: boolean } = {},
  ) {
    const runtimeEnvironment = resolveAuxiliaryRuntimeEnvironment(projectDir, workflow);
    return resolveWorkflowSelector(workflow, {
      projectCwd: projectDir,
      lookupCwd: projectDir,
      ...options,
      companionEnabled: options.companionEnabled ?? runtimeEnvironment.companionEnabled,
      providerEnvironment: runtimeEnvironment.providerEnvironment,
      providerConfigMode: runtimeEnvironment.providerConfigMode,
    });
  }

  it('should not resolve an invalid unused selector for a workflow without dynamic parallel', () => {
    const projectDir = createProject([
      'takt_providers:',
      '  selector:',
      '    provider: opencode',
    ].join('\n'));
    const workflow: WorkflowConfig = {
      name: 'ordinary',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [{ name: 'implement', instruction: 'Implement' }],
    };

    expect(resolveWorkflowSelectorForProject(workflow, projectDir)).toEqual({ applies: false });
  });

  it('should resolve selector configuration for a companion pool', () => {
    const projectDir = createProject('provider: codex\nmodel: gpt-selector\n');
    const workflow: WorkflowConfig = {
      name: 'companion-pool',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [{
        name: 'implement',
        instruction: 'Implement',
        companion: { fixed: [], pool: ['security-reviewer'] },
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    };

    expect(resolveWorkflowSelectorForProject(workflow, projectDir, {
      companionEnabled: true,
    })).toMatchObject({
      applies: true,
      selectorProvider: { provider: 'codex', model: 'gpt-selector' },
    });
  });

  it('should resolve selector configuration for Team Leader dynamic facets and companion pool', () => {
    const projectDir = createProject('provider: codex\nmodel: gpt-selector\n');
    const workflow = {
      name: 'team-leader-selector',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [{
        name: 'implement',
        personaDisplayName: 'implement',
        instruction: 'Implement',
        teamLeader: { maxConcurrency: 1, timeoutMs: 900000 },
        dynamicFacets: { pool: 'review', maxSelected: 1 },
        companion: { fixed: [], pool: ['security-reviewer'] },
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    };

    expect(resolveWorkflowSelectorForProject(workflow, projectDir, {
      companionEnabled: true,
    })).toMatchObject({
      applies: true,
      selectorProvider: { provider: 'codex', model: 'gpt-selector' },
    });
  });

  it('should ignore a companion pool when companion is disabled', () => {
    const projectDir = createProject('provider: opencode\nmodel: opencode/model\n');
    const workflow: WorkflowConfig = {
      name: 'disabled-companion-pool',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [{
        name: 'implement',
        instruction: 'Implement',
        companion: { fixed: [], pool: ['security-reviewer'] },
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    };

    expect(resolveWorkflowSelectorForProject(workflow, projectDir, {
      companionEnabled: false,
    })).toEqual({ applies: false });
  });

  it('should resolve selector configuration when only a called workflow is dynamic', () => {
    const projectDir = createProject('provider: codex\nmodel: gpt-selector\n');
    const workflowDir = join(projectDir, '.takt', 'workflows');
    writeFileSync(join(workflowDir, 'child.yaml'), [
      'name: child',
      'subworkflow:',
      '  callable: true',
      'initial_step: reviewers',
      'max_steps: 1',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      pool:',
      '        - name: security',
      '          description: Review security',
      '          instruction: Review security',
      '          rules:',
      '            - condition: approved',
      '      selection:',
      '        mode: replace',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
    ].join('\n'));
    writeFileSync(join(workflowDir, 'parent.yaml'), [
      'name: parent',
      'initial_step: delegate',
      'max_steps: 1',
      'steps:',
      '  - name: delegate',
      '    kind: workflow_call',
      '    call: child',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ].join('\n'));
    const workflow = loadWorkflowByIdentifier('parent', projectDir);
    if (workflow === null) {
      throw new Error('Expected parent workflow');
    }

    expect(resolveWorkflowSelectorForProject(workflow, projectDir)).toMatchObject({
      applies: true,
      selectorProvider: {
        provider: 'codex',
        model: 'gpt-selector',
      },
    });
  });

  it('should resolve selector configuration for called workflows and static parallel children (DFP-008)', () => {
    const projectDir = createProject('provider: codex\nmodel: gpt-selector\n');
    const workflowDir = join(projectDir, '.takt', 'workflows');
    writeFileSync(join(workflowDir, 'child.yaml'), [
      'name: child',
      'subworkflow:',
      '  callable: true',
      'initial_step: fix',
      'max_steps: 1',
      'facet_pools:',
      '  fix:',
      '    policies:',
      '      coding: ./facets/policies/coding.md',
      '    candidates:',
      '      - id: backend',
      '        description: backend facet',
      '        policy: coding',
      'steps:',
      '  - name: fix',
      '    persona: coder',
      '    dynamic_facets:',
      '      pool: fix',
      '      max_selected: 1',
      '    instruction: fix',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));
    mkdirSync(join(workflowDir, 'facets', 'policies'), { recursive: true });
    writeFileSync(join(workflowDir, 'facets', 'policies', 'coding.md'), '# coding policy\n', 'utf-8');
    writeFileSync(join(workflowDir, 'parent.yaml'), [
      'name: parent',
      'initial_step: delegate',
      'max_steps: 1',
      'steps:',
      '  - name: delegate',
      '    kind: workflow_call',
      '    call: child',
      '    rules:',
      '      - condition: COMPLETE',
      '        next: COMPLETE',
    ].join('\n'));
    const workflow = loadWorkflowByIdentifier('parent', projectDir);
    if (workflow === null) {
      throw new Error('Expected parent workflow');
    }

    expect(resolveWorkflowSelectorForProject(workflow, projectDir)).toMatchObject({
      applies: true,
      selectorProvider: {
        provider: 'codex',
        model: 'gpt-selector',
      },
    });

    const staticChildWorkflow: WorkflowConfig = {
      name: 'static-child-facet',
      initialStep: 'reviewers',
      maxSteps: 1,
      steps: [{
        name: 'reviewers',
        personaDisplayName: 'reviewers',
        instruction: 'Review',
        parallel: [{
          name: 'security',
          personaDisplayName: 'security',
          instruction: 'Review security',
          dynamicFacets: { pool: 'security', maxSelected: 1 },
          rules: [{ condition: 'approved' }],
        }],
        rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
      }],
    };

    expect(resolveWorkflowSelectorForProject(staticChildWorkflow, projectDir)).toMatchObject({
      applies: true,
      selectorProvider: { provider: 'codex', model: 'gpt-selector' },
    });
  });

  it('should resolve selector configuration through a workflow_call nested in legacy parallel', () => {
    const projectDir = createProject('provider: codex\nmodel: gpt-selector\n');
    const workflowDir = join(projectDir, '.takt', 'workflows');
    writeFileSync(join(workflowDir, 'child.yaml'), [
      'name: child',
      'subworkflow:',
      '  callable: true',
      'initial_step: reviewers',
      'max_steps: 1',
      'steps:',
      '  - name: reviewers',
      '    parallel:',
      '      pool:',
      '        - name: security',
      '          description: Review security',
      '          instruction: Review security',
      '          rules:',
      '            - condition: approved',
      '      selection:',
      '        mode: replace',
      '    rules:',
      '      - condition: all("approved")',
      '        next: COMPLETE',
    ].join('\n'));
    writeFileSync(join(workflowDir, 'parent.yaml'), [
      'name: parent',
      'initial_step: delegates',
      'max_steps: 1',
      'steps:',
      '  - name: delegates',
      '    parallel:',
      '      - name: delegate',
      '        kind: workflow_call',
      '        call: child',
      '        rules:',
      '          - condition: COMPLETE',
      '            next: COMPLETE',
      '    rules:',
      '      - condition: all("COMPLETE")',
      '        next: COMPLETE',
    ].join('\n'));
    const workflow = loadWorkflowByIdentifier('parent', projectDir);
    if (workflow === null) {
      throw new Error('Expected parent workflow');
    }

    expect(resolveWorkflowSelectorForProject(workflow, projectDir)).toMatchObject({
      applies: true,
      selectorProvider: { provider: 'codex', model: 'gpt-selector' },
    });
  });

  it('should preserve compatible Codex options', () => {
    const projectDir = createProject([
      'takt_providers:',
      '  selector:',
      '    provider: codex',
      '    model: gpt-selector',
      '    provider_options:',
      '      codex:',
      '        reasoning_effort: high',
      '        skills:',
      '          repo: true',
      '          user: false',
    ].join('\n'));

    expect(resolveWorkflowSelectorForProject(makeDynamicWorkflow(), projectDir)).toEqual({
      applies: true,
      selectorProvider: expect.objectContaining({
        provider: 'codex',
        model: 'gpt-selector',
        providerOptions: {
          codex: {
            reasoningEffort: 'high',
            skills: { repo: true, user: false },
          },
        },
      }),
    });
  });

  it('should keep compatible Claude options', () => {
    const projectDir = createProject([
      'takt_providers:',
      '  selector:',
      '    provider: claude',
      '    provider_options:',
      '      claude:',
      '        effort: low',
      '        skills:',
      '          enabled: false',
    ].join('\n'));

    expect(resolveWorkflowSelectorForProject(makeDynamicWorkflow(), projectDir)).toEqual({
      applies: true,
      selectorProvider: expect.objectContaining({
        provider: 'claude',
        providerOptions: {
          claude: { effort: 'low', skills: { enabled: false } },
        },
      }),
    });
  });

  it.each([
    {
      label: 'non-empty allowed tools',
      config: [
        '        allowed_tools:',
        '          - Read',
      ],
    },
    {
      label: 'enabled skills',
      config: [
        '        skills:',
        '          enabled: true',
      ],
    },
  ])('should accept configured Claude $label for the shared selector transport', ({ config }) => {
    const projectDir = createProject([
      'takt_providers:',
      '  selector:',
      '    provider: claude',
      '    provider_options:',
      '      claude:',
      ...config,
    ].join('\n'));

    expect(() => resolveWorkflowSelectorForProject(makeDynamicWorkflow(), projectDir)).not.toThrow();
  });

  it.each(['copilot', 'cursor', 'kiro', 'opencode'] as const)(
    'should accept dynamic selector provider %s at the shared workflow resolution boundary',
    (provider) => {
      const config = provider === 'opencode'
        ? 'provider: opencode\nmodel: opencode/big-pickle\n'
        : `provider: ${provider}\n`;
      const projectDir = createProject(config);
      const workflow = makeDynamicWorkflow();

      expect(resolveWorkflowSelectorForProject(workflow, projectDir)).toMatchObject({
        applies: true,
        selectorProvider: { provider },
      });
    },
  );
});
