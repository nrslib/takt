import type {
  QualityGate,
  RateLimitFallbackConfig,
  StepProviderOptions,
  WorkflowRuntimeConfig,
} from '../../core/models/workflow-types.js';
import type { z } from 'zod';
import type { QualityGatesSchema } from '../../core/models/schema-base.js';
import type { WorkflowOverridesSchema } from '../../core/models/config-schemas.js';
import type { PermissionMode } from '../../core/models/status.js';
import type { ProviderPermissionProfiles } from '../../core/models/provider-profiles.js';
import type {
  AssistantConfig,
  AutoRoutingConfig,
  WorkflowOverrides,
  PersonaProviderEntry,
  PipelineConfig,
  ProviderRoutingConfig,
  ProviderRoutingEntry,
  TaktProviderConfigEntry,
  TaktProvidersConfig,
  TelemetryConfig,
} from '../../core/models/config-types.js';
import { validateProviderModelRequirements } from './providerModelRequirements.js';
import {
  normalizeConfigProviderReferenceDetailed,
  type ConfigProviderReference,
} from './providerReference.js';
import { normalizeProviderOptions, type NormalizeProviderOptionsOptions } from './providerOptions.js';

type RawProviderRoutingEntry = string | {
  type?: string;
  provider?: string;
  model?: string;
  provider_options?: Record<string, unknown>;
};

type RawQualityGate = NonNullable<z.output<typeof QualityGatesSchema>>[number];
type RawWorkflowOverrides = z.output<typeof WorkflowOverridesSchema>;
type SerializedQualityGateOverride = { quality_gates?: RawQualityGate[] };

type RawAutoRoutingConfig = {
  strategy: AutoRoutingConfig['strategy'];
  router: {
    provider: AutoRoutingConfig['router']['provider'];
    model: string;
  };
  candidates: Array<{
    name: string;
    description: string;
    provider: AutoRoutingConfig['candidates'][number]['provider'];
    model: string;
    cost_tier: AutoRoutingConfig['candidates'][number]['costTier'];
    provider_options?: Record<string, unknown>;
  }>;
  rules?: AutoRoutingConfig['rules'];
};

function normalizeQualityGate(gate: RawQualityGate): QualityGate {
  if (typeof gate === 'string') {
    return gate;
  }
  return {
    type: gate.type,
    ...(gate.name !== undefined ? { name: gate.name } : {}),
    command: gate.command,
    ...(gate.cwd !== undefined ? { cwd: gate.cwd } : {}),
    ...(gate.timeout_ms !== undefined ? { timeoutMs: gate.timeout_ms } : {}),
  };
}

export function normalizeQualityGates(gates: RawQualityGate[] | undefined): QualityGate[] | undefined {
  return gates?.map(normalizeQualityGate);
}

function denormalizeQualityGate(gate: QualityGate): RawQualityGate {
  if (typeof gate === 'string') {
    return gate;
  }
  return {
    type: gate.type,
    ...(gate.name !== undefined ? { name: gate.name } : {}),
    command: gate.command,
    ...(gate.cwd !== undefined ? { cwd: gate.cwd } : {}),
    ...(gate.timeoutMs !== undefined ? { timeout_ms: gate.timeoutMs } : {}),
  };
}

function denormalizeQualityGates(gates: QualityGate[] | undefined): RawQualityGate[] | undefined {
  return gates?.map(denormalizeQualityGate);
}

function assertNormalizedProviderOptions(
  path: string,
  providerOptions: unknown,
): void {
  if (providerOptions !== undefined) {
    return;
  }

  throw new Error(
    `Configuration error: ${path}.provider_options must include at least one provider-specific option`,
  );
}

export function normalizeRuntime(
  runtime: { prepare?: string[] } | undefined,
): WorkflowRuntimeConfig | undefined {
  if (!runtime?.prepare || runtime.prepare.length === 0) {
    return undefined;
  }
  return { prepare: [...new Set(runtime.prepare)] };
}

export function normalizeRateLimitFallback(
  raw: { switch_chain?: Array<{ provider: RateLimitFallbackConfig['switchChain'][number]['provider']; model?: string }> } | undefined,
): RateLimitFallbackConfig | undefined {
  if (!raw) {
    return undefined;
  }
  const switchChain = raw.switch_chain ?? [];
  return {
    switchChain: switchChain.map((entry, index) => {
      validateProviderModelRequirements(entry.provider, entry.model, {
        modelFieldName: `Configuration error: rate_limit_fallback.switch_chain[${index}].model`,
      });
      return {
        provider: entry.provider,
        ...(entry.model !== undefined ? { model: entry.model } : {}),
      };
    }),
  };
}

export function normalizeAutoRoutingConfig(
  raw: RawAutoRoutingConfig | undefined,
  options: NormalizeProviderOptionsOptions = {},
): AutoRoutingConfig | undefined {
  if (!raw) {
    return undefined;
  }

  validateProviderModelRequirements(raw.router.provider, raw.router.model, {
    modelFieldName: 'Configuration error: auto_routing.router.model',
  });
  return {
    strategy: raw.strategy,
    router: {
      provider: raw.router.provider,
      model: raw.router.model,
    },
    candidates: raw.candidates.map((candidate, index) => {
      validateProviderModelRequirements(candidate.provider, candidate.model, {
        modelFieldName: `Configuration error: auto_routing.candidates[${index}].model`,
      });
      return {
        name: candidate.name,
        description: candidate.description,
        provider: candidate.provider,
        model: candidate.model,
        costTier: candidate.cost_tier,
        providerOptions: normalizeProviderOptions(candidate.provider_options, {
          ...options,
          pathPrefix: `auto_routing.candidates[${index}].provider_options`,
        }),
      };
    }),
    rules: raw.rules,
  };
}

export function denormalizeAutoRoutingConfig(
  config: AutoRoutingConfig | undefined,
): RawAutoRoutingConfig | undefined {
  if (!config) {
    return undefined;
  }
  return {
    strategy: config.strategy,
    router: {
      provider: config.router.provider,
      model: config.router.model,
    },
    candidates: config.candidates.map((candidate, index) => {
      const path = `auto_routing.candidates[${index}]`;
      const rawProviderOptions = denormalizeProviderOptions(candidate.providerOptions);
      if (candidate.providerOptions !== undefined) {
        assertNormalizedProviderOptions(path, rawProviderOptions);
      }
      return {
        name: candidate.name,
        description: candidate.description,
        provider: candidate.provider,
        model: candidate.model,
        cost_tier: candidate.costTier,
        ...(rawProviderOptions !== undefined ? { provider_options: rawProviderOptions } : {}),
      };
    }),
    ...(config.rules !== undefined ? { rules: config.rules } : {}),
  };
}

export function normalizeTelemetryConfig(
  raw: { routing_decisions?: boolean } | undefined,
): TelemetryConfig | undefined {
  if (!raw || raw.routing_decisions === undefined) {
    return undefined;
  }
  return { routingDecisions: raw.routing_decisions };
}

export function denormalizeTelemetryConfig(
  config: TelemetryConfig | undefined,
): Record<string, unknown> | undefined {
  if (!config || config.routingDecisions === undefined) {
    return undefined;
  }
  return { routing_decisions: config.routingDecisions };
}

export function denormalizeRateLimitFallback(
  config: RateLimitFallbackConfig | undefined,
): { switch_chain: Array<{ provider: RateLimitFallbackConfig['switchChain'][number]['provider']; model?: string }> } | undefined {
  if (!config) {
    return undefined;
  }
  return {
    switch_chain: config.switchChain.map((entry) => ({
      provider: entry.provider,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
    })),
  };
}

export function normalizeProviderProfiles(
  raw: Record<string, {
    default_permission_mode: PermissionMode;
    step_permission_overrides?: Record<string, string>;
  }> | undefined,
): ProviderPermissionProfiles | undefined {
  if (!raw) return undefined;

  const entries = Object.entries(raw).map(([provider, profile]) => [
    provider,
    {
      defaultPermissionMode: profile.default_permission_mode,
      stepPermissionOverrides: profile.step_permission_overrides,
    },
  ]);

  return Object.fromEntries(entries) as ProviderPermissionProfiles;
}

export function denormalizeProviderProfiles(
  profiles: ProviderPermissionProfiles | undefined,
): Record<string, { default_permission_mode: string; step_permission_overrides?: Record<string, string> }> | undefined {
  if (!profiles) return undefined;
  const entries = Object.entries(profiles);
  if (entries.length === 0) return undefined;

  return Object.fromEntries(entries.map(([provider, profile]) => [provider, {
    default_permission_mode: profile.defaultPermissionMode,
    ...(profile.stepPermissionOverrides
      ? { step_permission_overrides: profile.stepPermissionOverrides }
      : {}),
  }])) as Record<string, { default_permission_mode: string; step_permission_overrides?: Record<string, string> }>;
}

export function normalizeWorkflowOverrides(
  raw: RawWorkflowOverrides,
): WorkflowOverrides | undefined {
  if (!raw) return undefined;
  return {
    qualityGates: normalizeQualityGates(raw.quality_gates),
    qualityGatesEditOnly: raw.quality_gates_edit_only,
    steps: raw.steps
      ? Object.fromEntries(
        Object.entries(raw.steps).map(([name, override]) => [
          name,
          { qualityGates: normalizeQualityGates(override?.quality_gates) },
        ])
      )
      : undefined,
    personas: raw.personas
      ? Object.fromEntries(
        Object.entries(raw.personas).map(([name, override]) => [
          name,
          { qualityGates: normalizeQualityGates(override?.quality_gates) },
        ])
      )
      : undefined,
  };
}

export function denormalizeWorkflowOverrides(
  overrides: WorkflowOverrides | undefined,
): {
  quality_gates?: RawQualityGate[];
  quality_gates_edit_only?: boolean;
  steps?: Record<string, SerializedQualityGateOverride>;
  personas?: Record<string, SerializedQualityGateOverride>;
} | undefined {
  if (!overrides) return undefined;
  const result: {
    quality_gates?: RawQualityGate[];
    quality_gates_edit_only?: boolean;
    steps?: Record<string, SerializedQualityGateOverride>;
    personas?: Record<string, SerializedQualityGateOverride>;
  } = {};
  if (overrides.qualityGates !== undefined) {
    result.quality_gates = denormalizeQualityGates(overrides.qualityGates);
  }
  if (overrides.qualityGatesEditOnly !== undefined) {
    result.quality_gates_edit_only = overrides.qualityGatesEditOnly;
  }
  if (overrides.steps) {
    result.steps = Object.fromEntries(
      Object.entries(overrides.steps).map(([name, override]) => {
        const stepOverride: SerializedQualityGateOverride = {};
        if (override.qualityGates !== undefined) {
          stepOverride.quality_gates = denormalizeQualityGates(override.qualityGates);
        }
        return [name, stepOverride];
      })
    );
  }
  if (overrides.personas) {
    result.personas = Object.fromEntries(
      Object.entries(overrides.personas).map(([name, override]) => {
        const personaOverride: SerializedQualityGateOverride = {};
        if (override.qualityGates !== undefined) {
          personaOverride.quality_gates = denormalizeQualityGates(override.qualityGates);
        }
        return [name, personaOverride];
      })
    );
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizePersonaProviders(
  raw: Record<string, RawProviderRoutingEntry> | undefined,
  options: NormalizeProviderOptionsOptions = {},
): Record<string, PersonaProviderEntry> | undefined {
  return normalizeProviderRoutingEntries(raw, 'persona_providers', options);
}

export function denormalizePersonaProviders(
  personaProviders: Record<string, PersonaProviderEntry> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  return denormalizeProviderRoutingEntries(personaProviders, 'persona_providers');
}

function normalizeProviderRoutingEntries<TEntry extends PersonaProviderEntry>(
  raw: Record<string, RawProviderRoutingEntry> | undefined,
  pathPrefix: string,
  options: NormalizeProviderOptionsOptions,
  allowProviderOnlyOpenCode = false,
): Record<string, TEntry> | undefined {
  if (!raw) return undefined;
  const entries = Object.entries(raw);
  if (entries.length === 0) return undefined;

  return Object.fromEntries(entries.map(([key, entry]) => {
    const path = `${pathPrefix}.${key}`;
    const rawProviderOptions = typeof entry === 'string' ? undefined : entry.provider_options;
    const normalizedReference = normalizeConfigProviderReferenceDetailed(
      (typeof entry === 'string' ? entry : (entry.provider ?? entry.type)) as ConfigProviderReference<NonNullable<TEntry['provider']>>,
      typeof entry === 'string' ? undefined : entry.model,
      rawProviderOptions,
      {
        ...options,
        pathPrefix: `${path}.provider_options`,
      },
    );
    if (rawProviderOptions !== undefined) {
      assertNormalizedProviderOptions(path, normalizedReference.providerOptions);
    }
    const normalizedEntry: PersonaProviderEntry = {
      ...(normalizedReference.provider !== undefined ? { provider: normalizedReference.provider } : {}),
      ...(normalizedReference.model !== undefined ? { model: normalizedReference.model } : {}),
      ...(normalizedReference.providerOptions !== undefined
        ? { providerOptions: normalizedReference.providerOptions }
        : {}),
    };
    if (
      normalizedEntry.provider === undefined
      && normalizedEntry.model === undefined
      && normalizedEntry.providerOptions === undefined
    ) {
      throw new Error(
        `Configuration error: ${path} must include at least one of 'provider', 'model', or 'provider_options'`,
      );
    }
    if (
      !allowProviderOnlyOpenCode
      || normalizedEntry.provider !== 'opencode'
      || normalizedEntry.model !== undefined
    ) {
      validateProviderModelRequirements(
        normalizedEntry.provider,
        normalizedEntry.model,
        {
          modelFieldName: `Configuration error: ${path}.model`,
        },
      );
    }
    return [key, normalizedEntry as TEntry];
  }));
}

function denormalizeProviderRoutingEntries<TEntry extends PersonaProviderEntry>(
  entriesByKey: Record<string, TEntry> | undefined,
  pathPrefix: string,
): Record<string, Record<string, unknown>> | undefined {
  if (!entriesByKey) {
    return undefined;
  }

  const entries = Object.entries(entriesByKey);
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries.map(([key, entry]) => {
    const path = `${pathPrefix}.${key}`;
    const rawEntry: Record<string, unknown> = {};
    if (entry.provider !== undefined) {
      rawEntry.provider = entry.provider;
    }
    if (entry.model !== undefined) {
      rawEntry.model = entry.model;
    }

    const rawProviderOptions = denormalizeProviderOptions(entry.providerOptions);
    if (entry.providerOptions !== undefined) {
      assertNormalizedProviderOptions(path, rawProviderOptions);
    }
    if (rawProviderOptions !== undefined) {
      rawEntry.provider_options = rawProviderOptions;
    }

    if (Object.keys(rawEntry).length === 0) {
      throw new Error(
        `Configuration error: ${path} must include at least one of 'provider', 'model', or 'provider_options'`,
      );
    }

    return [key, rawEntry];
  }));
}

export function normalizeProviderRouting(
  raw: {
    personas?: Record<string, RawProviderRoutingEntry>;
    tags?: Record<string, RawProviderRoutingEntry>;
    steps?: Record<string, RawProviderRoutingEntry>;
  } | undefined,
  options: NormalizeProviderOptionsOptions = {},
): ProviderRoutingConfig | undefined {
  if (!raw) return undefined;
  const result: ProviderRoutingConfig = {
    personas: normalizeProviderRoutingEntries<ProviderRoutingEntry>(raw.personas, 'provider_routing.personas', options, true),
    tags: normalizeProviderRoutingEntries<ProviderRoutingEntry>(raw.tags, 'provider_routing.tags', options, true),
    steps: normalizeProviderRoutingEntries<ProviderRoutingEntry>(raw.steps, 'provider_routing.steps', options, true),
  };
  return result.personas || result.tags || result.steps ? result : undefined;
}

export function denormalizeProviderRouting(
  providerRouting: ProviderRoutingConfig | undefined,
): {
  personas?: Record<string, Record<string, unknown>>;
  tags?: Record<string, Record<string, unknown>>;
  steps?: Record<string, Record<string, unknown>>;
} | undefined {
  if (!providerRouting) return undefined;
  const result = {
    personas: denormalizeProviderRoutingEntries(providerRouting.personas, 'provider_routing.personas'),
    tags: denormalizeProviderRoutingEntries(providerRouting.tags, 'provider_routing.tags'),
    steps: denormalizeProviderRoutingEntries(providerRouting.steps, 'provider_routing.steps'),
  };
  return result.personas || result.tags || result.steps ? result : undefined;
}

export function normalizePipelineConfig(raw: {
  default_branch_prefix?: string;
  commit_message_template?: string;
  pr_body_template?: string;
} | undefined): PipelineConfig | undefined {
  if (!raw) return undefined;
  const { default_branch_prefix, commit_message_template, pr_body_template } = raw;
  if (default_branch_prefix === undefined && commit_message_template === undefined && pr_body_template === undefined) {
    return undefined;
  }
  return {
    defaultBranchPrefix: default_branch_prefix,
    commitMessageTemplate: commit_message_template,
    prBodyTemplate: pr_body_template,
  };
}

export function normalizeAssistantConfig(
  raw: { init_files?: string[] } | undefined,
): AssistantConfig | undefined {
  if (!raw?.init_files || raw.init_files.length === 0) {
    return undefined;
  }
  return { initFiles: raw.init_files };
}

export function denormalizeAssistantConfig(
  config: AssistantConfig | undefined,
): { init_files: string[] } | undefined {
  if (!config?.initFiles || config.initFiles.length === 0) {
    return undefined;
  }
  return { init_files: config.initFiles };
}

export function normalizeTaktProviders(raw: {
  assistant?: {
    provider?: TaktProviderConfigEntry['provider'];
    model?: string;
  };
} | undefined): TaktProvidersConfig | undefined {
  if (!raw) {
    return undefined;
  }
  const normalizedAssistant = normalizeTaktAssistantProvider(raw.assistant);
  if (!normalizedAssistant) {
    return undefined;
  }
  return { assistant: normalizedAssistant };
}

export function normalizeTaktAssistantProvider(
  assistant:
    | {
      provider?: TaktProviderConfigEntry['provider'];
      model?: string;
    }
    | undefined,
): TaktProviderConfigEntry | undefined {
  if (!assistant) {
    return undefined;
  }
  const { provider, model } = assistant;
  if (provider === undefined && model === undefined) {
    throw new Error("Configuration error: 'takt_providers.assistant' must include provider or model.");
  }
  validateProviderModelRequirements(
    provider,
    model,
    {
      modelFieldName: 'Configuration error: takt_providers.assistant.model',
    },
  );
  if (provider !== undefined) {
    return {
      provider,
      ...(model !== undefined ? { model } : {}),
    };
  }
  if (model === undefined) {
    throw new Error("Configuration error: 'takt_providers.assistant' must include provider or model.");
  }
  return { model };
}

export function buildRawTaktProvidersOrThrow(
  taktProviders: TaktProvidersConfig | undefined,
): { assistant: TaktProviderConfigEntry } | undefined {
  if (taktProviders === undefined) {
    return undefined;
  }
  if (taktProviders.assistant === undefined) {
    throw new Error("Configuration error: 'takt_providers.assistant' is required when takt_providers is set.");
  }
  const assistant = normalizeTaktAssistantProvider(taktProviders.assistant);
  if (!assistant) {
    throw new Error("Configuration error: 'takt_providers.assistant' must include provider or model.");
  }
  return { assistant };
}

export function denormalizeProviderOptions(
  providerOptions: StepProviderOptions | undefined,
): Record<string, unknown> | undefined {
  if (!providerOptions) {
    return undefined;
  }

  const raw: Record<string, unknown> = {};
  if (
    providerOptions.codex?.baseUrl !== undefined
    || providerOptions.codex?.networkAccess !== undefined
    || providerOptions.codex?.reasoningEffort !== undefined
  ) {
    raw.codex = {
      ...(providerOptions.codex.baseUrl !== undefined
        ? { base_url: providerOptions.codex.baseUrl }
        : {}),
      ...(providerOptions.codex.networkAccess !== undefined
        ? { network_access: providerOptions.codex.networkAccess }
        : {}),
      ...(providerOptions.codex.reasoningEffort !== undefined
        ? { reasoning_effort: providerOptions.codex.reasoningEffort }
        : {}),
    };
  }
  if (
    providerOptions.opencode?.networkAccess !== undefined
    || providerOptions.opencode?.variant !== undefined
    || providerOptions.opencode?.allowedTools !== undefined
  ) {
    raw.opencode = {
      ...(providerOptions.opencode.networkAccess !== undefined
        ? { network_access: providerOptions.opencode.networkAccess }
        : {}),
      ...(providerOptions.opencode.variant !== undefined
        ? { variant: providerOptions.opencode.variant }
        : {}),
      ...(providerOptions.opencode.allowedTools !== undefined
        ? { allowed_tools: providerOptions.opencode.allowedTools }
        : {}),
    };
  }
  if (providerOptions.claude) {
    const claude: Record<string, unknown> = {};
    if (providerOptions.claude.baseUrl !== undefined) {
      claude.base_url = providerOptions.claude.baseUrl;
    }
    if (providerOptions.claude.allowedTools !== undefined) {
      claude.allowed_tools = providerOptions.claude.allowedTools;
    }
    if (providerOptions.claude.effort !== undefined) {
      claude.effort = providerOptions.claude.effort;
    }
    const sandbox: Record<string, unknown> = {};
    if (providerOptions.claude.sandbox?.allowUnsandboxedCommands !== undefined) {
      sandbox.allow_unsandboxed_commands = providerOptions.claude.sandbox.allowUnsandboxedCommands;
    }
    if (providerOptions.claude.sandbox?.excludedCommands !== undefined) {
      sandbox.excluded_commands = providerOptions.claude.sandbox.excludedCommands;
    }
    if (Object.keys(sandbox).length > 0) {
      claude.sandbox = sandbox;
    }
    if (Object.keys(claude).length > 0) {
      raw.claude = claude;
    }
  }
  if (providerOptions.copilot?.effort !== undefined) {
    raw.copilot = { effort: providerOptions.copilot.effort };
  }
  if (providerOptions.kiro?.agent !== undefined) {
    raw.kiro = { agent: providerOptions.kiro.agent };
  }
  if (providerOptions.claudeTerminal) {
    const claudeTerminal: Record<string, unknown> = {};
    if (providerOptions.claudeTerminal.backend !== undefined) {
      claudeTerminal.backend = providerOptions.claudeTerminal.backend;
    }
    if (providerOptions.claudeTerminal.timeoutMs !== undefined) {
      claudeTerminal.timeout_ms = providerOptions.claudeTerminal.timeoutMs;
    }
    if (providerOptions.claudeTerminal.keepSession !== undefined) {
      claudeTerminal.keep_session = providerOptions.claudeTerminal.keepSession;
    }
    if (providerOptions.claudeTerminal.transcriptPollIntervalMs !== undefined) {
      claudeTerminal.transcript_poll_interval_ms = providerOptions.claudeTerminal.transcriptPollIntervalMs;
    }
    if (Object.keys(claudeTerminal).length > 0) {
      raw.claude_terminal = claudeTerminal;
    }
  }

  return Object.keys(raw).length > 0 ? raw : undefined;
}
