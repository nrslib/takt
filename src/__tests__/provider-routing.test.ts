import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';
import type { PartDefinition, WorkflowStep } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { resolveStepProviderModel } from '../core/workflow/provider-resolution.js';
import { createPartStep } from '../core/workflow/engine/team-leader-common.js';
import {
  denormalizeProviderRouting,
  normalizeProviderRouting,
} from '../infra/config/configNormalizers.js';
import {
  getProjectConfigDir,
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
  loadProjectConfig,
  resolveConfigValue,
  saveProjectConfig,
} from '../infra/config/index.js';
import { loadProjectConfigTraceState } from '../infra/config/project/projectConfig.js';
import { loadGlobalConfig } from '../infra/config/global/globalConfigCore.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowLoader.js';

function createStep(overrides: Record<string, unknown> = {}): WorkflowStep {
  return {
    name: 'implement',
    kind: 'agent',
    personaDisplayName: 'implement-coder',
    instruction: '{task}',
    passPreviousResponse: true,
    ...overrides,
  } as WorkflowStep;
}

function createBuilder(
  engineOverrides: Record<string, unknown> = {},
  getSessionId: (key: string) => string | undefined = () => undefined,
): OptionsBuilder {
  const engineOptions = {
    projectCwd: '/project',
    provider: 'mock',
    providerSource: 'project',
    model: 'project-model',
    modelSource: 'project',
    ...engineOverrides,
  } as unknown as WorkflowEngineOptions;

  return new OptionsBuilder(
    engineOptions,
    () => '/project',
    () => '/project',
    getSessionId,
    () => '.takt/runs/provider-routing/reports',
    () => 'ja',
    () => [{ name: 'implement' }],
    () => 'provider-routing-test',
    () => 'Provider routing test workflow',
  );
}

describe('provider_routing provider/model resolution', () => {
  it('Given persona_name changes display name, When routing by persona, Then raw persona key is used before legacy persona_providers', () => {
    const result = resolveStepProviderModel({
      step: createStep({
        personaDisplayName: 'fix-coder',
        providerRoutingPersonaKey: 'coder',
      }),
      provider: 'mock',
      model: 'project-model',
      providerRouting: {
        personas: {
          coder: { provider: 'codex', model: 'gpt-5' },
        },
      },
      personaProviders: {
        'fix-coder': { provider: 'opencode', model: 'legacy-display-model' },
      },
    } as Parameters<typeof resolveStepProviderModel>[0]);

    expect(result).toEqual({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'provider_routing.personas',
      modelSource: 'provider_routing.personas',
    });
  });

  it('Given every layer is configured, When resolving provider/model, Then priority is step, routing steps, tags, personas, legacy, fallback', () => {
    const providerRouting = {
      personas: {
        coder: { provider: 'codex', model: 'persona-model' },
      },
      tags: {
        implementation: { provider: 'opencode', model: 'tag-model' },
      },
      steps: {
        implement: { provider: 'claude', model: 'step-route-model' },
      },
    };
    const personaProviders = {
      'implement-coder': { provider: 'cursor' as const, model: 'legacy-model' },
    };

    expect(resolveStepProviderModel({
      step: createStep({
        provider: 'copilot',
        model: 'direct-model',
        providerRoutingPersonaKey: 'coder',
        tags: ['implementation'],
      }),
      provider: 'mock',
      model: 'project-model',
      providerRouting,
      personaProviders,
    } as Parameters<typeof resolveStepProviderModel>[0])).toMatchObject({
      provider: 'copilot',
      model: 'direct-model',
      providerSource: 'step',
      modelSource: 'step',
    });

    expect(resolveStepProviderModel({
      step: createStep({
        providerRoutingPersonaKey: 'coder',
        tags: ['implementation'],
      }),
      provider: 'mock',
      model: 'project-model',
      providerRouting,
      personaProviders,
    } as Parameters<typeof resolveStepProviderModel>[0])).toMatchObject({
      provider: 'claude',
      model: 'step-route-model',
      providerSource: 'provider_routing.steps',
      modelSource: 'provider_routing.steps',
    });

    expect(resolveStepProviderModel({
      step: createStep({
        name: 'review',
        providerRoutingPersonaKey: 'coder',
        tags: ['implementation'],
      }),
      provider: 'mock',
      model: 'project-model',
      providerRouting,
      personaProviders,
    } as Parameters<typeof resolveStepProviderModel>[0])).toMatchObject({
      provider: 'opencode',
      model: 'tag-model',
      providerSource: 'provider_routing.tags',
      modelSource: 'provider_routing.tags',
    });

    expect(resolveStepProviderModel({
      step: createStep({
        name: 'review',
        providerRoutingPersonaKey: 'coder',
      }),
      provider: 'mock',
      model: 'project-model',
      providerRouting,
      personaProviders,
    } as Parameters<typeof resolveStepProviderModel>[0])).toMatchObject({
      provider: 'codex',
      model: 'persona-model',
      providerSource: 'provider_routing.personas',
      modelSource: 'provider_routing.personas',
    });

    expect(resolveStepProviderModel({
      step: createStep({
        name: 'review',
      }),
      provider: 'mock',
      providerSource: 'project',
      model: 'project-model',
      modelSource: 'project',
      providerRouting,
      personaProviders,
    } as Parameters<typeof resolveStepProviderModel>[0])).toMatchObject({
      provider: 'cursor',
      model: 'legacy-model',
      providerSource: 'persona_providers',
      modelSource: 'persona_providers',
    });

    expect(resolveStepProviderModel({
      step: createStep({
        name: 'review',
      }),
      provider: 'mock',
      providerSource: 'project',
      model: 'project-model',
      modelSource: 'project',
      providerRouting,
    } as Parameters<typeof resolveStepProviderModel>[0])).toMatchObject({
      provider: 'mock',
      model: 'project-model',
      providerSource: 'project',
      modelSource: 'project',
    });
  });

  it('Given multiple matching tags, When resolving provider/model, Then later tags override earlier tags', () => {
    const result = resolveStepProviderModel({
      step: createStep({
        name: 'review',
        providerRoutingPersonaKey: 'reviewer',
        tags: ['review', 'web'],
      }),
      provider: 'mock',
      model: 'project-model',
      providerRouting: {
        tags: {
          review: { provider: 'opencode', model: 'review-model' },
          web: { provider: 'codex', model: 'web-model' },
        },
      },
    } as Parameters<typeof resolveStepProviderModel>[0]);

    expect(result).toMatchObject({
      provider: 'codex',
      model: 'web-model',
      providerSource: 'provider_routing.tags',
      modelSource: 'provider_routing.tags',
    });
  });
});

describe('provider_routing provider_options resolution', () => {
  it('Given provider_routing resolves the provider, When building agent options, Then session key uses {persona}:{provider}', () => {
    const step = createStep({
      persona: 'coder',
      providerRoutingPersonaKey: 'coder',
    });
    const builder = createBuilder({
      providerRouting: {
        personas: {
          coder: { provider: 'codex' },
        },
      },
    }, (key) => (key === 'coder:codex' ? 'session-codex' : undefined));

    const options = builder.buildAgentOptions(step);

    expect(options.resolvedProvider).toBe('codex');
    expect(options.sessionId).toBe('session-codex');
  });

  it('Given provider_routing layers, When building options, Then provider_options merge by leaf using routing priority', () => {
    const step = createStep({
      providerRoutingPersonaKey: 'coder',
      tags: ['implementation', 'edit'],
      providerOptions: {
        codex: { networkAccess: false },
      },
    });
    const builder = createBuilder({
      providerOptionsSource: 'project',
      providerOptions: {
        codex: { networkAccess: true, reasoningEffort: 'low' },
        claude: { allowedTools: ['Read'] },
      },
      personaProviders: {
        'implement-coder': {
          providerOptions: {
            codex: { reasoningEffort: 'medium' },
          },
        },
      },
      providerRouting: {
        personas: {
          coder: {
            providerOptions: {
              codex: { reasoningEffort: 'high' },
              claude: { allowedTools: ['Read', 'Glob'] },
            },
          },
        },
        tags: {
          implementation: {
            providerOptions: {
              claude: {
                allowedTools: ['Read', 'Edit'],
                sandbox: { allowUnsandboxedCommands: false },
              },
              opencode: { variant: 'tag-route' },
            },
          },
          edit: {
            providerOptions: {
              claude: { sandbox: { allowUnsandboxedCommands: true } },
            },
          },
        },
        steps: {
          implement: {
            providerOptions: {
              opencode: { variant: 'step-route' },
            },
          },
        },
      },
    });

    expect(builder.buildBaseOptions(step).providerOptions).toEqual({
      codex: { networkAccess: false, reasoningEffort: 'high' },
      claude: {
        allowedTools: ['Read', 'Edit'],
        sandbox: { allowUnsandboxedCommands: true },
      },
      opencode: { variant: 'step-route' },
    });
  });

  it('Given env-origin config leaf, When provider_routing and step set same leaf, Then env-origin config still wins', () => {
    const step = createStep({
      providerRoutingPersonaKey: 'coder',
      tags: ['edit'],
      providerOptions: {
        codex: { networkAccess: false },
      },
    });
    const builder = createBuilder({
      providerOptionsSource: 'project',
      providerOptionsOriginResolver: (path: string) => (path === 'codex.networkAccess' ? 'env' : 'local'),
      providerOptions: {
        codex: { networkAccess: true },
      },
      providerRouting: {
        personas: {
          coder: { providerOptions: { codex: { networkAccess: false } } },
        },
        tags: {
          edit: { providerOptions: { codex: { networkAccess: false } } },
        },
      },
    });

    expect(builder.buildBaseOptions(step).providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });

  it('Given env-origin base_url config leaf, When provider_routing sets base_url, Then routing layers win by scope', () => {
    const builder = createBuilder({
      providerOptionsSource: 'project',
      providerOptionsOriginResolver: (path: string) =>
        path === 'codex.baseUrl' || path === 'claude.baseUrl' ? 'env' : 'local',
      providerOptions: {
        codex: { baseUrl: 'http://env.example.test/v1' },
        claude: { baseUrl: 'http://env.example.test' },
      },
      providerRouting: {
        personas: {
          coder: { providerOptions: { codex: { baseUrl: 'http://persona.example.test/v1' } } },
        },
        tags: {
          edit: { providerOptions: { claude: { baseUrl: 'http://tag.example.test' } } },
        },
        steps: {
          implement: { providerOptions: { codex: { baseUrl: 'http://step-route.example.test/v1' } } },
        },
      },
    });

    const routedStep = createStep({
      providerRoutingPersonaKey: 'coder',
      tags: ['edit'],
    });
    expect(builder.buildBaseOptions(routedStep).providerOptions).toEqual({
      codex: { baseUrl: 'http://step-route.example.test/v1' },
      claude: { baseUrl: 'http://tag.example.test' },
    });
    expect(builder.resolveStepProviderModel(routedStep).providerOptionsSources).toMatchObject({
      'codex.baseUrl': 'provider_routing.steps',
      'claude.baseUrl': 'provider_routing.tags',
    });

    const personaOnlyStep = createStep({
      name: 'review',
      providerRoutingPersonaKey: 'coder',
    });
    expect(builder.buildBaseOptions(personaOnlyStep).providerOptions).toEqual({
      codex: { baseUrl: 'http://persona.example.test/v1' },
      claude: { baseUrl: 'http://env.example.test' },
    });
    expect(builder.resolveStepProviderModel(personaOnlyStep).providerOptionsSources).toMatchObject({
      'codex.baseUrl': 'provider_routing.personas',
      'claude.baseUrl': 'env',
    });
  });

  it('Given routed provider_options, When resolving step provider info, Then source tracing names the routing layer', () => {
    const step = createStep({
      providerRoutingPersonaKey: 'coder',
      tags: ['implementation', 'edit'],
    });
    const builder = createBuilder({
      providerOptionsSource: 'project',
      providerOptions: {
        codex: { networkAccess: false },
      },
      providerRouting: {
        personas: {
          coder: { providerOptions: { codex: { reasoningEffort: 'medium' } } },
        },
        tags: {
          implementation: { providerOptions: { claude: { allowedTools: ['Read'] } } },
          edit: { providerOptions: { claude: { allowedTools: ['Read', 'Edit'] } } },
        },
        steps: {
          implement: { providerOptions: { opencode: { variant: 'route-step' } } },
        },
      },
    });

    expect(builder.resolveStepProviderModel(step).providerOptionsSources).toEqual({
      'codex.networkAccess': 'project',
      'codex.reasoningEffort': 'provider_routing.personas',
      'claude.allowedTools': 'provider_routing.tags',
      'opencode.variant': 'provider_routing.steps',
    });
  });

  it('Given tag routing only defines provider_options, When resolving provider/model, Then fallback provider/model stay separate', () => {
    const step = createStep({
      tags: ['edit'],
    });
    const providerRouting = {
      tags: {
        edit: {
          providerOptions: {
            codex: { networkAccess: true },
          },
        },
      },
    };
    const builder = createBuilder({ providerRouting });

    expect(resolveStepProviderModel({
      step,
      provider: 'mock',
      providerSource: 'project',
      model: 'project-model',
      modelSource: 'project',
      providerRouting,
    } as Parameters<typeof resolveStepProviderModel>[0])).toEqual({
      provider: 'mock',
      model: 'project-model',
      providerSource: 'project',
      modelSource: 'project',
    });
    expect(builder.buildBaseOptions(step).providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });

  it('Given team_leader part with workflow fallback and tags, When building part options, Then routing overrides workflow fallback', () => {
    const parentStep = createStep({
      name: 'implement',
      persona: 'leader',
      providerRoutingPersonaKey: 'leader',
      provider: 'claude',
      providerSpecified: false,
      model: 'workflow-model',
      modelSpecified: false,
      tags: ['implementation', 'edit'],
      providerOptions: {
        codex: { networkAccess: false },
      },
      workflowProviderOptions: {
        codex: { networkAccess: false },
      },
      teamLeader: {
        persona: 'planner',
        maxConcurrency: 3,
        maxTotalParts: 20,
        refillThreshold: 0,
        timeoutMs: 900000,
        partPersona: 'coder',
      },
    });
    const part: PartDefinition = {
      id: 'api',
      title: 'API',
      instruction: 'implement api',
    };
    const partStep = createPartStep(parentStep, part);
    const builder = createBuilder({
      providerRouting: {
        personas: {
          coder: {
            providerOptions: {
              codex: { reasoningEffort: 'medium' },
            },
          },
        },
        tags: {
          implementation: {
            provider: 'codex',
            model: 'gpt-5',
            providerOptions: {
              codex: { reasoningEffort: 'high' },
            },
          },
          edit: {
            providerOptions: {
              codex: { networkAccess: true },
            },
          },
        },
      },
    });

    expect(partStep).toMatchObject({
      name: 'implement.api',
      providerRoutingPersonaKey: 'coder',
      tags: ['implementation', 'edit'],
      providerSpecified: false,
      modelSpecified: false,
      workflowProviderOptions: {
        codex: { networkAccess: false },
      },
    });
    expect(builder.resolveStepProviderModel(partStep)).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'provider_routing.tags',
      modelSource: 'provider_routing.tags',
    });
    expect(builder.buildBaseOptions(partStep).providerOptions).toEqual({
      codex: {
        networkAccess: true,
        reasoningEffort: 'high',
      },
    });
  });

  it('Given team_leader parent tags and part_tags differ, When resolving provider/model, Then parent and part route separately', () => {
    const parentStep = createStep({
      name: 'implement',
      persona: 'leader',
      providerRoutingPersonaKey: 'leader',
      tags: ['leader'],
      teamLeader: {
        persona: 'planner',
        maxConcurrency: 3,
        maxTotalParts: 20,
        refillThreshold: 0,
        timeoutMs: 900000,
        partPersona: 'coder',
        partTags: ['coding'],
      },
    });
    const part: PartDefinition = {
      id: 'api',
      title: 'API',
      instruction: 'implement api',
    };
    const providerRouting = {
      tags: {
        leader: { provider: 'codex' as const, model: 'gpt-5.5' },
        coding: { provider: 'opencode' as const, model: 'ollama-cloud/qwen3-coder-next' },
      },
    };

    const partStep = createPartStep(parentStep, part);

    expect(parentStep.tags).toEqual(['leader']);
    expect(partStep).toMatchObject({
      name: 'implement.api',
      providerRoutingPersonaKey: 'coder',
      tags: ['coding'],
    });
    expect(resolveStepProviderModel({
      step: parentStep,
      provider: 'mock',
      model: 'project-model',
      providerRouting,
    } as Parameters<typeof resolveStepProviderModel>[0])).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      providerSource: 'provider_routing.tags',
      modelSource: 'provider_routing.tags',
    });
    expect(resolveStepProviderModel({
      step: partStep,
      provider: 'mock',
      model: 'project-model',
      providerRouting,
    } as Parameters<typeof resolveStepProviderModel>[0])).toMatchObject({
      provider: 'opencode',
      model: 'ollama-cloud/qwen3-coder-next',
      providerSource: 'provider_routing.tags',
      modelSource: 'provider_routing.tags',
    });
  });

  it('Given team_leader part_persona and part_tags, When resolving provider/model, Then tag routing wins over persona routing', () => {
    const parentStep = createStep({
      name: 'implement',
      persona: 'leader',
      providerRoutingPersonaKey: 'leader',
      tags: ['leader'],
      teamLeader: {
        persona: 'planner',
        maxConcurrency: 3,
        maxTotalParts: 20,
        refillThreshold: 0,
        timeoutMs: 900000,
        partPersona: 'coder',
        partTags: ['coding'],
      },
    });
    const part: PartDefinition = {
      id: 'api',
      title: 'API',
      instruction: 'implement api',
    };
    const partStep = createPartStep(parentStep, part);

    expect(resolveStepProviderModel({
      step: partStep,
      provider: 'mock',
      model: 'project-model',
      providerRouting: {
        personas: {
          coder: { provider: 'codex', model: 'persona-model' },
        },
        tags: {
          coding: { provider: 'opencode', model: 'ollama-cloud/qwen3-coder-next' },
        },
      },
    } as Parameters<typeof resolveStepProviderModel>[0])).toMatchObject({
      provider: 'opencode',
      model: 'ollama-cloud/qwen3-coder-next',
      providerSource: 'provider_routing.tags',
      modelSource: 'provider_routing.tags',
    });
  });
});

describe('provider_routing config normalization', () => {
  it('Given raw provider_routing, When normalizing, Then all buckets use persona_providers entry shape and provider_options are camelCased', () => {
    const normalized = normalizeProviderRouting({
      personas: {
        coder: {
          provider: 'codex',
          model: 'gpt-5',
          provider_options: {
            codex: { reasoning_effort: 'high' },
          },
        },
      },
      tags: {
        edit: {
          provider_options: {
            codex: { network_access: true },
          },
        },
      },
      steps: {
        implement: {
          provider: 'opencode',
          model: 'opencode/qwen3-coder-next',
        },
      },
    });

    expect(normalized).toEqual({
      personas: {
        coder: {
          provider: 'codex',
          model: 'gpt-5',
          providerOptions: {
            codex: { reasoningEffort: 'high' },
          },
        },
      },
      tags: {
        edit: {
          providerOptions: {
            codex: { networkAccess: true },
          },
        },
      },
      steps: {
        implement: {
          provider: 'opencode',
          model: 'opencode/qwen3-coder-next',
        },
      },
    });
  });

  it('Given normalized provider_routing, When denormalizing, Then provider_options are persisted as snake_case', () => {
    const denormalized = denormalizeProviderRouting({
      personas: {
        coder: {
          provider: 'codex',
          providerOptions: {
            codex: { reasoningEffort: 'high' },
          },
        },
      },
      tags: {
        edit: {
          providerOptions: {
            codex: { networkAccess: true },
          },
        },
      },
    });

    expect(denormalized).toEqual({
      personas: {
        coder: {
          provider: 'codex',
          provider_options: {
            codex: { reasoning_effort: 'high' },
          },
        },
      },
      tags: {
        edit: {
          provider_options: {
            codex: { network_access: true },
          },
        },
      },
    });
  });

  it('Given an empty provider_routing entry, When normalizing, Then it fails fast with the routing path', () => {
    expect(() => normalizeProviderRouting({
      tags: {
        edit: {},
      },
    })).toThrow(/provider_routing\.tags\.edit/);
  });

  it('Given provider_routing entry has provider_options without provider leaves, When normalizing, Then it propagates the routing path error', () => {
    expect(() => normalizeProviderRouting({
      personas: {
        coder: {
          provider_options: {},
        },
      },
    })).toThrow(/provider_routing\.personas\.coder\.provider_options/);
  });

  it('Given provider_routing entry uses opencode without a local model, When normalizing, Then provider-only routing is preserved', () => {
    expect(normalizeProviderRouting({
      steps: {
        review: {
          provider: 'opencode',
        },
      },
    })?.steps?.review).toEqual({ provider: 'opencode' });
  });

  it('Given provider_routing entry uses opencode with a bare model, When normalizing, Then provider/model validation fails', () => {
    expect(() => normalizeProviderRouting({
      steps: {
        review: {
          provider: 'opencode',
          model: 'big-pickle',
        },
      },
    })).toThrow(/provider\/model/);
  });
});

describe('provider_routing config loading', () => {
  let tempDir: string;
  let previousTaktConfigDir: string | undefined;
  let previousProviderRoutingEnv: string | undefined;

  beforeEach(() => {
    previousTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    previousProviderRoutingEnv = process.env.TAKT_PROVIDER_ROUTING;
    tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-routing-'));
    const globalConfigDir = join(tempDir, 'global-takt');
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(join(globalConfigDir, 'config.yaml'), 'language: en\n');
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    delete process.env.TAKT_PROVIDER_ROUTING;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    if (previousTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousTaktConfigDir;
    }
    if (previousProviderRoutingEnv === undefined) {
      delete process.env.TAKT_PROVIDER_ROUTING;
    } else {
      process.env.TAKT_PROVIDER_ROUTING = previousProviderRoutingEnv;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('Given project config provider_routing, When loading config, Then providerRouting is normalized', () => {
    const projectConfigDir = getProjectConfigDir(tempDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'provider_routing:',
      '  personas:',
      '    coder:',
      '      provider: codex',
      '      model: gpt-5',
      '  tags:',
      '    edit:',
      '      provider_options:',
      '        codex:',
      '          network_access: true',
      '  steps:',
      '    implement:',
      '      provider: opencode',
      '      model: opencode/qwen3-coder-next',
    ].join('\n'));

    expect(loadProjectConfig(tempDir).providerRouting).toEqual({
      personas: {
        coder: { provider: 'codex', model: 'gpt-5' },
      },
      tags: {
        edit: { providerOptions: { codex: { networkAccess: true } } },
      },
      steps: {
        implement: { provider: 'opencode', model: 'opencode/qwen3-coder-next' },
      },
    });
  });

  it('Given invalid project config provider_routing, When loading config, Then the routing error is not swallowed', () => {
    const projectConfigDir = getProjectConfigDir(tempDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'provider_routing:',
      '  steps:',
      '    implement:',
      '      provider_options: {}',
    ].join('\n'));

    expect(() => loadProjectConfig(tempDir)).toThrow(/provider_routing\.steps\.implement\.provider_options/);
  });

  it('Given project config provider_routing has external base_url, When loading config, Then it fails at the routing path', () => {
    const projectConfigDir = getProjectConfigDir(tempDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'provider_routing:',
      '  tags:',
      '    edit:',
      '      provider_options:',
      '        codex:',
      '          base_url: https://attacker.example.test/v1',
    ].join('\n'));

    expect(() => loadProjectConfig(tempDir))
      .toThrow(/provider_routing\.tags\.edit\.provider_options\.codex\.base_url must use a loopback base_url/);
  });

  it('Given providerRouting is saved, When reading raw config, Then key is written as provider_routing', () => {
    saveProjectConfig(tempDir, {
      providerRouting: {
        personas: {
          coder: { provider: 'codex' },
        },
      },
    } as unknown as Parameters<typeof saveProjectConfig>[1]);

    const saved = readFileSync(join(getProjectConfigDir(tempDir), 'config.yaml'), 'utf-8');

    expect(saved).toContain('provider_routing:');
    expect(loadProjectConfig(tempDir).providerRouting).toEqual({
      personas: {
        coder: { provider: 'codex' },
      },
    });
  });

  it('Given project and global provider_routing, When resolving config value, Then project overrides global like personaProviders', () => {
    const globalConfigDir = process.env.TAKT_CONFIG_DIR;
    if (globalConfigDir === undefined) {
      throw new Error('TAKT_CONFIG_DIR must be set for provider_routing config tests');
    }
    writeFileSync(join(globalConfigDir, 'config.yaml'), [
      'language: en',
      'provider_routing:',
      '  personas:',
      '    coder:',
      '      provider: claude',
    ].join('\n'));

    const projectConfigDir = getProjectConfigDir(tempDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'provider_routing:',
      '  personas:',
      '    coder:',
      '      provider: codex',
    ].join('\n'));
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    expect(resolveConfigValue(tempDir, 'providerRouting')).toEqual({
      personas: {
        coder: { provider: 'codex' },
      },
    });
  });

  it('Given TAKT_PROVIDER_ROUTING is set, When loading project config, Then env JSON overrides file config with env origin', () => {
    const projectConfigDir = getProjectConfigDir(tempDir);
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'config.yaml'), [
      'provider_routing:',
      '  personas:',
      '    coder:',
      '      provider: claude',
    ].join('\n'));
    process.env.TAKT_PROVIDER_ROUTING = JSON.stringify({
      personas: {
        coder: { provider: 'codex', model: 'gpt-5' },
      },
    });
    invalidateAllResolvedConfigCache();

    expect(loadProjectConfig(tempDir).providerRouting).toEqual({
      personas: {
        coder: { provider: 'codex', model: 'gpt-5' },
      },
    });
    expect(loadProjectConfigTraceState(tempDir).getOrigin('provider_routing')).toBe('env');
  });

  it('Given TAKT_PROVIDER_ROUTING is set, When loading global config, Then env JSON is normalized', () => {
    process.env.TAKT_PROVIDER_ROUTING = JSON.stringify({
      tags: {
        review: { provider: 'codex', model: 'gpt-5' },
      },
    });
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    expect(loadGlobalConfig().providerRouting).toEqual({
      tags: {
        review: { provider: 'codex', model: 'gpt-5' },
      },
    });
  });
});

describe('workflow step tags', () => {
  let tempDir: string;
  let previousTaktConfigDir: string | undefined;

  beforeEach(() => {
    previousTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    tempDir = mkdtempSync(join(tmpdir(), 'takt-provider-routing-workflow-'));
    const globalConfigDir = join(tempDir, 'global-takt');
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(join(globalConfigDir, 'config.yaml'), 'language: en\n');
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    if (previousTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousTaktConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('Given workflow step tags, When loading workflow, Then tags and raw persona routing key are preserved', () => {
    const workflowPath = join(tempDir, 'provider-routing-workflow.yaml');
    writeFileSync(workflowPath, [
      'name: provider-routing-workflow',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      '    persona_name: fix-coder',
      '    tags:',
      '      - implementation',
      '      - edit',
      '    instruction: "{task}"',
    ].join('\n'));

    const workflow = loadWorkflowFromFile(workflowPath, tempDir);

    expect(workflow.steps[0]).toMatchObject({
      name: 'implement',
      personaDisplayName: 'fix-coder',
      providerRoutingPersonaKey: 'coder',
      tags: ['implementation', 'edit'],
    });
  });

  it.each([
    {
      name: 'null',
      tagsYaml: ['    tags: null'],
      error: /expected array, received null/,
    },
    {
      name: 'string',
      tagsYaml: ['    tags: implementation'],
      error: /expected array, received string/,
    },
    {
      name: 'blank entry',
      tagsYaml: ['    tags:', '      - "   "'],
      error: /Step "implement" has an empty tags entry/,
    },
  ])('Given workflow step tags is $name, When loading workflow, Then invalid tags fail fast', ({ name, tagsYaml, error }) => {
    const workflowPath = join(tempDir, `provider-routing-invalid-tags-${name}.yaml`);
    writeFileSync(workflowPath, [
      'name: provider-routing-invalid-tags',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      ...tagsYaml,
      '    instruction: "{task}"',
    ].join('\n'));

    expect(() => loadWorkflowFromFile(workflowPath, tempDir)).toThrow(error);
  });

  it('Given workflow_config and provider_routing both define provider, When loading workflow and resolving step, Then routing is above workflow fallback', () => {
    const workflowPath = join(tempDir, 'provider-routing-workflow-config.yaml');
    writeFileSync(workflowPath, [
      'name: provider-routing-workflow-config',
      'initial_step: implement',
      'max_steps: 1',
      'workflow_config:',
      '  provider: claude',
      '  model: workflow-model',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      '    tags:',
      '      - implementation',
      '    instruction: "{task}"',
    ].join('\n'));

    const workflow = loadWorkflowFromFile(workflowPath, tempDir);
    const result = resolveStepProviderModel({
      step: workflow.steps[0],
      provider: 'claude',
      providerSource: 'project',
      model: 'workflow-model',
      modelSource: 'project',
      providerRouting: {
        tags: {
          implementation: { provider: 'codex', model: 'gpt-5' },
        },
      },
    });

    expect(result).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'provider_routing.tags',
      modelSource: 'provider_routing.tags',
    });
  });

  it('Given workflow_config has a concrete fallback and provider_routing defines provider, When resolving step, Then routing is above the fallback', () => {
    const workflowPath = join(tempDir, 'provider-routing-workflow-config-auto.yaml');
    writeFileSync(workflowPath, [
      'name: provider-routing-workflow-config-auto',
      'initial_step: implement',
      'max_steps: 1',
      'workflow_config:',
      '  provider: mock',
      '  model: workflow-model',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      '    tags:',
      '      - implementation',
      '    instruction: "{task}"',
    ].join('\n'));

    const workflow = loadWorkflowFromFile(workflowPath, tempDir);
    const step = workflow.steps[0];

    expect(step).toMatchObject({
      provider: 'mock',
      providerSpecified: false,
    });
    expect(resolveStepProviderModel({
      step,
      provider: 'mock',
      providerSource: 'project',
      model: 'workflow-model',
      modelSource: 'project',
      providerRouting: {
        tags: {
          implementation: { provider: 'codex', model: 'gpt-5' },
        },
      },
    })).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'provider_routing.tags',
      modelSource: 'provider_routing.tags',
    });
  });

  it('Given parallel sub-step inherits workflow_config fallback, When resolving sub-step, Then routing remains above workflow fallback', () => {
    const workflowPath = join(tempDir, 'provider-routing-parallel-workflow-config.yaml');
    writeFileSync(workflowPath, [
      'name: provider-routing-parallel-workflow-config',
      'initial_step: implement',
      'max_steps: 1',
      'workflow_config:',
      '  provider: claude',
      '  model: workflow-model',
      '  provider_options:',
      '    codex:',
      '      network_access: false',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      '    parallel:',
      '      - name: implement-api',
      '        persona: coder',
      '        tags:',
      '          - implementation',
      '        instruction: "{task}"',
    ].join('\n'));

    const workflow = loadWorkflowFromFile(workflowPath, tempDir);
    const subStep = workflow.steps[0].parallel?.[0];
    if (!subStep) {
      throw new Error('parallel sub-step must be normalized');
    }

    expect(subStep).toMatchObject({
      provider: 'claude',
      providerSpecified: false,
      model: 'workflow-model',
      modelSpecified: false,
      workflowProviderOptions: {
        codex: { networkAccess: false },
      },
    });
    expect(resolveStepProviderModel({
      step: subStep,
      providerRouting: {
        tags: {
          implementation: { provider: 'codex', model: 'gpt-5' },
        },
      },
    })).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'provider_routing.tags',
      modelSource: 'provider_routing.tags',
    });
    expect(createBuilder({
      providerRouting: {
        tags: {
          implementation: {
            providerOptions: {
              codex: { networkAccess: true },
            },
          },
        },
      },
    }).buildBaseOptions(subStep).providerOptions).toEqual({
      codex: { networkAccess: true },
    });
  });

  it('Given parallel sub-step inherits a concrete workflow fallback, When resolving sub-step, Then routing remains above the fallback', () => {
    const workflowPath = join(tempDir, 'provider-routing-parallel-workflow-config-auto.yaml');
    writeFileSync(workflowPath, [
      'name: provider-routing-parallel-workflow-config-auto',
      'initial_step: implement',
      'max_steps: 1',
      'workflow_config:',
      '  provider: mock',
      '  model: workflow-model',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      '    parallel:',
      '      - name: implement-api',
      '        persona: coder',
      '        tags:',
      '          - implementation',
      '        instruction: "{task}"',
    ].join('\n'));

    const workflow = loadWorkflowFromFile(workflowPath, tempDir);
    const subStep = workflow.steps[0].parallel?.[0];
    if (!subStep) {
      throw new Error('parallel sub-step must be normalized');
    }

    expect(subStep).toMatchObject({
      provider: 'mock',
      providerSpecified: false,
      model: 'workflow-model',
      modelSpecified: false,
    });
    expect(resolveStepProviderModel({
      step: subStep,
      providerRouting: {
        tags: {
          implementation: { provider: 'codex', model: 'gpt-5' },
        },
      },
    })).toMatchObject({
      provider: 'codex',
      model: 'gpt-5',
      providerSource: 'provider_routing.tags',
      modelSource: 'provider_routing.tags',
    });
  });

  it('Given parallel sub-step omits model explicitly while inheriting provider, When resolving sub-step, Then parent model is not inherited', () => {
    const workflowPath = join(tempDir, 'provider-inherited-model-null.yaml');
    writeFileSync(workflowPath, [
      'name: provider-inherited-model-null',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      '    provider: claude',
      '    model: parent-model',
      '    instruction: "{task}"',
      '    parallel:',
      '      - name: implement-api',
      '        persona: coder',
      '        model: null',
      '        instruction: "{task}"',
    ].join('\n'));

    const workflow = loadWorkflowFromFile(workflowPath, tempDir);
    const subStep = workflow.steps[0].parallel?.[0];
    if (!subStep) {
      throw new Error('parallel sub-step must be normalized');
    }

    expect(subStep).toMatchObject({
      provider: 'claude',
      providerSpecified: true,
      model: undefined,
      modelSpecified: true,
    });
    expect(resolveStepProviderModel({
      step: subStep,
      provider: 'claude',
      providerSource: 'project',
      model: 'project-model',
      modelSource: 'project',
    })).toMatchObject({
      provider: 'claude',
      model: undefined,
      providerSource: 'step',
      modelSource: 'step',
    });
  });

  it('Given parallel parent omits model explicitly, When sub-step omits model, Then engine model is not inherited', () => {
    const workflowPath = join(tempDir, 'provider-parent-model-null.yaml');
    writeFileSync(workflowPath, [
      'name: provider-parent-model-null',
      'initial_step: implement',
      'max_steps: 1',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      '    provider: cursor',
      '    model: null',
      '    instruction: "{task}"',
      '    parallel:',
      '      - name: implement-api',
      '        persona: coder',
      '        instruction: "{task}"',
    ].join('\n'));

    const workflow = loadWorkflowFromFile(workflowPath, tempDir);
    const subStep = workflow.steps[0].parallel?.[0];
    if (!subStep) {
      throw new Error('parallel sub-step must be normalized');
    }

    expect(subStep).toMatchObject({
      provider: 'cursor',
      providerSpecified: true,
      model: undefined,
      modelSpecified: true,
    });
    expect(resolveStepProviderModel({
      step: subStep,
      provider: 'cursor',
      providerSource: 'project',
      model: 'project-model',
      modelSource: 'project',
    })).toMatchObject({
      provider: 'cursor',
      model: undefined,
      providerSource: 'step',
      modelSource: 'step',
    });
  });
});

describe('provider_routing provider/model validation', () => {
  it('Given routing layers compose a codex provider with arbitrary model, When validating workflow, Then provider decides support', () => {
    expect(() => validateWorkflowConfig({
      name: 'provider-routing-validation',
      initialStep: 'review',
      maxSteps: 1,
      steps: [
        createStep({
          name: 'review',
          tags: ['codex-provider', 'claude-model'],
        }),
      ],
    }, {
      projectCwd: '/project',
      providerRouting: {
        tags: {
          'codex-provider': { provider: 'codex' },
          'claude-model': { model: 'sonnet' },
        },
      },
    } as WorkflowEngineOptions)).not.toThrow();
  });

  it('Given routing resolves opencode without a model, When validating workflow, Then it fails fast', () => {
    expect(() => validateWorkflowConfig({
      name: 'provider-routing-opencode-validation',
      initialStep: 'review',
      maxSteps: 1,
      steps: [
        createStep({
          name: 'review',
          tags: ['opencode-provider'],
        }),
      ],
    }, {
      projectCwd: '/project',
      providerRouting: {
        tags: {
          'opencode-provider': { provider: 'opencode' },
        },
      },
    } as WorkflowEngineOptions)).toThrow(/provider 'opencode' requires model/);
  });

  it('Given routing resolves opencode and the input model is provider-qualified, When validating workflow, Then it passes', () => {
    expect(() => validateWorkflowConfig({
      name: 'provider-routing-opencode-input-model-validation',
      initialStep: 'review',
      maxSteps: 1,
      steps: [
        createStep({
          name: 'review',
          tags: ['opencode-provider'],
        }),
      ],
    }, {
      projectCwd: '/project',
      model: 'opencode/big-pickle',
      modelSource: 'project',
      providerRouting: {
        tags: {
          'opencode-provider': { provider: 'opencode' },
        },
      },
    } as WorkflowEngineOptions)).not.toThrow();
  });

  it('Given a workflow step uses opencode with a bare model, When validating workflow, Then it fails fast', () => {
    expect(() => validateWorkflowConfig({
      name: 'workflow-step-opencode-validation',
      initialStep: 'review',
      maxSteps: 1,
      steps: [
        createStep({
          name: 'review',
          provider: 'opencode',
          model: 'big-pickle',
        }),
      ],
    }, {
      projectCwd: '/project',
    } as WorkflowEngineOptions)).toThrow(/provider\/model/);
  });

  it('Given promotion switches to opencode without a model, When validating workflow, Then it fails fast', () => {
    expect(() => validateWorkflowConfig({
      name: 'promotion-opencode-missing-model-validation',
      initialStep: 'review',
      maxSteps: 1,
      steps: [
        createStep({
          name: 'review',
          provider: 'codex',
          model: 'gpt-5',
          promotion: [
            {
              at: 1,
              provider: 'opencode',
              providerSpecified: true,
            },
          ],
        }),
      ],
    }, {
      projectCwd: '/project',
    } as WorkflowEngineOptions)).toThrow(/provider 'opencode' requires model/);
  });

  it('Given promotion switches to opencode with a bare model, When validating workflow, Then it fails fast', () => {
    expect(() => validateWorkflowConfig({
      name: 'promotion-opencode-bare-model-validation',
      initialStep: 'review',
      maxSteps: 1,
      steps: [
        createStep({
          name: 'review',
          provider: 'codex',
          model: 'gpt-5',
          promotion: [
            {
              at: 1,
              provider: 'opencode',
              providerSpecified: true,
              model: 'big-pickle',
            },
          ],
        }),
      ],
    }, {
      projectCwd: '/project',
    } as WorkflowEngineOptions)).toThrow(/provider\/model/);
  });

  it('Given promotion model inherits an opencode provider, When the promotion model is bare, Then validation fails fast', () => {
    expect(() => validateWorkflowConfig({
      name: 'promotion-opencode-inherited-provider-validation',
      initialStep: 'review',
      maxSteps: 1,
      steps: [
        createStep({
          name: 'review',
          provider: 'opencode',
          model: 'opencode/base-model',
          promotion: [
            {
              at: 1,
              model: 'big-pickle',
            },
          ],
        }),
      ],
    }, {
      projectCwd: '/project',
    } as WorkflowEngineOptions)).toThrow(/provider\/model/);
  });

  it('Given persona_providers resolves opencode with a bare model, When validating workflow, Then it fails fast', () => {
    expect(() => validateWorkflowConfig({
      name: 'persona-providers-opencode-validation',
      initialStep: 'review',
      maxSteps: 1,
      steps: [
        createStep({
          name: 'review',
          personaDisplayName: 'reviewer',
        }),
      ],
    }, {
      projectCwd: '/project',
      personaProviders: {
        reviewer: { provider: 'opencode', model: 'big-pickle' },
      },
    } as WorkflowEngineOptions)).toThrow(/provider\/model/);
  });

  it('Given parallel sub-step routing composes a codex provider with arbitrary model, When validating workflow, Then provider decides support', () => {
    expect(() => validateWorkflowConfig({
      name: 'provider-routing-parallel-validation',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [
        createStep({
          name: 'implement',
          parallel: [
            createStep({
              name: 'implement-api',
            }),
          ],
        }),
      ],
    }, {
      projectCwd: '/project',
      providerRouting: {
        steps: {
          'implement-api': { provider: 'codex', model: 'sonnet' },
        },
      },
    } as WorkflowEngineOptions)).not.toThrow();
  });

  it('Given parallel sub-step uses opencode with a bare model, When validating workflow, Then it fails fast', () => {
    expect(() => validateWorkflowConfig({
      name: 'parallel-opencode-validation',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [
        createStep({
          name: 'implement',
          parallel: [
            createStep({
              name: 'implement-api',
              provider: 'opencode',
              model: 'big-pickle',
            }),
          ],
        }),
      ],
    }, {
      projectCwd: '/project',
    } as WorkflowEngineOptions)).toThrow(/provider\/model/);
  });
});
