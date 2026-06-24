import type { ProviderType } from '../../shared/types/provider.js';
import type {
  GlobalConfig,
  PersonaProviderEntry,
  ProjectConfig,
  ProviderRoutingConfig,
} from '../models/config-types.js';
import type { WorkflowConfig, WorkflowStep } from '../models/workflow-types.js';

export const DEFAULT_SUBSCRIPTION_ONLY_ALLOWED_PROVIDERS = [
  'codex-cli',
  'cursor-cli',
  'opencode-cli',
  'agy-cli',
  'mock',
] as const satisfies readonly ProviderType[];

export const SUBSCRIPTION_ONLY_FORBIDDEN_ENV_NAMES = [
  'OPENAI_API_KEY',
  'TAKT_OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'TAKT_ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'TAKT_GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'TAKT_GEMINI_API_KEY',
  'GROQ_API_KEY',
  'TAKT_GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'TAKT_OPENROUTER_API_KEY',
  'TOGETHER_API_KEY',
  'TAKT_TOGETHER_API_KEY',
  'MISTRAL_API_KEY',
  'TAKT_MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'TAKT_DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'TAKT_XAI_API_KEY',
  'VERCEL_AI_GATEWAY_API_KEY',
  'TAKT_VERCEL_AI_GATEWAY_API_KEY',
  'OPENCODE_API_KEY',
  'TAKT_OPENCODE_API_KEY',
  'CURSOR_API_KEY',
  'TAKT_CURSOR_API_KEY',
  'KIRO_API_KEY',
  'TAKT_KIRO_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'TAKT_COPILOT_GITHUB_TOKEN',
] as const;

const DEFAULT_ALLOWED_SET: ReadonlySet<ProviderType> = new Set(DEFAULT_SUBSCRIPTION_ONLY_ALLOWED_PROVIDERS);

const FORBIDDEN_CONFIG_KEYS = new Set([
  'api_key',
  'apiKey',
  'openai_api_key',
  'openaiApiKey',
  'anthropic_api_key',
  'anthropicApiKey',
  'google_api_key',
  'googleApiKey',
  'gemini_api_key',
  'geminiApiKey',
  'groq_api_key',
  'groqApiKey',
  'openrouter_api_key',
  'openrouterApiKey',
  'opencode_api_key',
  'opencodeApiKey',
  'cursor_api_key',
  'cursorApiKey',
  'kiro_api_key',
  'kiroApiKey',
  'copilot_github_token',
  'copilotGithubToken',
  'vercel_ai_gateway_api_key',
  'vercelAiGatewayApiKey',
]);

export interface SubscriptionOnlyPolicyConfig {
  subscriptionOnly?: boolean;
  allowedProviders?: readonly ProviderType[];
  forbiddenProviders?: readonly string[];
}

export function resolveSubscriptionOnlyPolicyConfig(
  globalConfig: SubscriptionOnlyPolicyConfig,
  projectConfig: SubscriptionOnlyPolicyConfig,
): SubscriptionOnlyPolicyConfig {
  return {
    subscriptionOnly: projectConfig.subscriptionOnly ?? globalConfig.subscriptionOnly,
    allowedProviders: projectConfig.allowedProviders ?? globalConfig.allowedProviders,
    forbiddenProviders: projectConfig.forbiddenProviders ?? globalConfig.forbiddenProviders,
  };
}

interface ProviderReferenceDiagnostic {
  path: string;
  provider: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRawSubscriptionOnlyEnabled(rawConfig: Record<string, unknown>): boolean {
  return rawConfig.subscription_only === true || rawConfig.subscriptionOnly === true;
}

interface ForbiddenConfigKeyScanOptions {
  ignoreUndefinedValues?: boolean;
}

export function findForbiddenSubscriptionOnlyConfigKeyPaths(
  value: unknown,
  prefix = '',
  options: ForbiddenConfigKeyScanOptions = {},
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) =>
      findForbiddenSubscriptionOnlyConfigKeyPaths(child, `${prefix}[${index}]`, options)
    );
  }

  if (!isRecord(value)) {
    return [];
  }

  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_CONFIG_KEYS.has(key) && (!options.ignoreUndefinedValues || child !== undefined)) {
      paths.push(path);
    }
    paths.push(...findForbiddenSubscriptionOnlyConfigKeyPaths(child, path, options));
  }
  return paths;
}

export function assertNoForbiddenSubscriptionOnlyConfigKeys(
  rawConfig: Record<string, unknown>,
  configPath: string,
  subscriptionOnlyEnabled = isRawSubscriptionOnlyEnabled(rawConfig),
): void {
  if (!subscriptionOnlyEnabled) {
    return;
  }

  const forbiddenPaths = findForbiddenSubscriptionOnlyConfigKeyPaths(rawConfig);
  if (forbiddenPaths.length === 0) {
    return;
  }

  throw new Error(
    `Subscription-only mode forbids API key config "${forbiddenPaths[0]}" in ${configPath}`,
  );
}

export function assertNoForbiddenEffectiveSubscriptionOnlyConfigKeys(
  policy: SubscriptionOnlyPolicyConfig,
  configs: readonly { config: unknown; configPath: string }[],
): void {
  if (policy.subscriptionOnly !== true) {
    return;
  }

  for (const { config, configPath } of configs) {
    // Normalized configs expose optional credential fields as undefined, so only configured values are violations.
    const forbiddenPaths = findForbiddenSubscriptionOnlyConfigKeyPaths(config, '', {
      ignoreUndefinedValues: true,
    });
    if (forbiddenPaths.length === 0) {
      continue;
    }
    throw new Error(
      `Subscription-only mode forbids API key config "${forbiddenPaths[0]}" in ${configPath}`,
    );
  }
}

export function getSubscriptionOnlyAllowedProviders(
  config: SubscriptionOnlyPolicyConfig,
): ReadonlySet<ProviderType> {
  return new Set(config.allowedProviders ?? DEFAULT_SUBSCRIPTION_ONLY_ALLOWED_PROVIDERS);
}

function assertConfiguredAllowlistIsSubscriptionSafe(config: SubscriptionOnlyPolicyConfig): void {
  for (const provider of config.allowedProviders ?? []) {
    if (DEFAULT_ALLOWED_SET.has(provider)) {
      continue;
    }
    throw new Error(
      `Subscription-only mode cannot allow API-key provider "${provider}" in allowed_providers`,
    );
  }
}

function assertAllowedForbiddenOverlap(config: SubscriptionOnlyPolicyConfig): void {
  const forbidden = new Set(config.forbiddenProviders ?? []);
  for (const provider of config.allowedProviders ?? DEFAULT_SUBSCRIPTION_ONLY_ALLOWED_PROVIDERS) {
    if (!forbidden.has(provider)) {
      continue;
    }
    throw new Error(
      `Subscription-only mode config cannot include provider "${provider}" in both allowed_providers and forbidden_providers`,
    );
  }
}

function assertProviderAllowed(
  provider: string | undefined,
  path: string,
  policy: SubscriptionOnlyPolicyConfig,
): void {
  if (!provider) {
    return;
  }

  const allowed = getSubscriptionOnlyAllowedProviders(policy);
  const forbidden = new Set(policy.forbiddenProviders ?? []);
  if (allowed.has(provider as ProviderType) && !forbidden.has(provider)) {
    return;
  }

  throw new Error(
    `Subscription-only mode rejects ${path} provider "${provider}". Allowed providers: ${[...allowed].join(', ')}`,
  );
}

export function assertSubscriptionOnlyProvider(
  provider: string | undefined,
  path: string,
  policy: SubscriptionOnlyPolicyConfig,
): void {
  if (policy.subscriptionOnly !== true) {
    return;
  }
  assertConfiguredAllowlistIsSubscriptionSafe(policy);
  assertAllowedForbiddenOverlap(policy);
  assertProviderAllowed(provider, path, policy);
}

function collectProviderEntryRefs(
  entries: Record<string, PersonaProviderEntry> | undefined,
  prefix: string,
): ProviderReferenceDiagnostic[] {
  if (!entries) {
    return [];
  }
  return Object.entries(entries)
    .filter(([, entry]) => entry.provider !== undefined)
    .map(([key, entry]) => ({ path: `${prefix}.${key}`, provider: entry.provider! }));
}

function collectProviderRoutingRefs(providerRouting: ProviderRoutingConfig | undefined): ProviderReferenceDiagnostic[] {
  if (!providerRouting) {
    return [];
  }
  return [
    ...collectProviderEntryRefs(providerRouting.personas, 'provider_routing.personas'),
    ...collectProviderEntryRefs(providerRouting.tags, 'provider_routing.tags'),
    ...collectProviderEntryRefs(providerRouting.steps, 'provider_routing.steps'),
  ];
}

function collectConfigProviderRefs(config: ProjectConfig | GlobalConfig): ProviderReferenceDiagnostic[] {
  return [
    ...(config.provider !== undefined ? [{ path: 'provider', provider: config.provider }] : []),
    ...collectProviderEntryRefs(config.personaProviders, 'persona_providers'),
    ...collectProviderRoutingRefs(config.providerRouting),
    ...(config.taktProviders?.assistant.provider !== undefined
      ? [{ path: 'takt_providers.assistant', provider: config.taktProviders.assistant.provider }]
      : []),
    ...(config.rateLimitFallback?.switchChain.map((entry, index) => ({
      path: `rate_limit_fallback.switch_chain[${index}]`,
      provider: entry.provider,
    })) ?? []),
    ...(config.providerProfiles
      ? Object.keys(config.providerProfiles).map((provider) => ({
          path: `provider_profiles.${provider}`,
          provider,
        }))
      : []),
  ];
}

export function assertSubscriptionOnlyConfig(config: ProjectConfig | GlobalConfig): void {
  if (config.subscriptionOnly !== true) {
    return;
  }

  assertConfiguredAllowlistIsSubscriptionSafe(config);
  assertAllowedForbiddenOverlap(config);
  for (const ref of collectConfigProviderRefs(config)) {
    assertProviderAllowed(ref.provider, ref.path, config);
  }
}

function collectWorkflowStepProviderRefs(step: WorkflowStep): ProviderReferenceDiagnostic[] {
  const refs: ProviderReferenceDiagnostic[] = [];
  if (step.provider !== undefined) {
    refs.push({ path: `step "${step.name}"`, provider: step.provider });
  }
  for (const [index, promotion] of step.promotion?.entries() ?? []) {
    if (promotion.provider !== undefined) {
      refs.push({ path: `step "${step.name}" promotion[${index}]`, provider: promotion.provider });
    }
  }
  for (const subStep of step.parallel ?? []) {
    refs.push(...collectWorkflowStepProviderRefs(subStep));
  }
  if (step.kind === 'workflow_call' && step.overrides?.provider !== undefined) {
    refs.push({ path: `workflow_call step "${step.name}" overrides`, provider: step.overrides.provider });
  }
  return refs;
}

export function assertSubscriptionOnlyWorkflowConfig(
  workflow: WorkflowConfig,
  policy: SubscriptionOnlyPolicyConfig,
): void {
  if (policy.subscriptionOnly !== true) {
    return;
  }

  assertConfiguredAllowlistIsSubscriptionSafe(policy);
  assertAllowedForbiddenOverlap(policy);
  assertProviderAllowed(workflow.provider, 'workflow_config', policy);
  for (const [index, entry] of workflow.rateLimitFallback?.switchChain.entries() ?? []) {
    assertProviderAllowed(entry.provider, `rate_limit_fallback.switch_chain[${index}]`, policy);
  }
  for (const step of workflow.steps) {
    for (const ref of collectWorkflowStepProviderRefs(step)) {
      assertProviderAllowed(ref.provider, ref.path, policy);
    }
  }
  for (const [index, monitor] of workflow.loopMonitors?.entries() ?? []) {
    assertProviderAllowed(monitor.judge.provider, `loop_monitors[${index}].judge`, policy);
  }
}
