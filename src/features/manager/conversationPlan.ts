import { resolveConfigValue, resolveNonWorkflowProviderOptions } from '../../infra/config/index.js';
import { resolveAssistantProviderModel } from '../interactive/assistantConfig.js';
import { getProvider } from '../../infra/providers/index.js';
import { resolveRequiredReadOnlyCapabilities } from '../../infra/providers/requiredCapabilities.js';
import { resolveFacetByName, resolveFacetByNameWithSource, resolveRefToContent } from '../../infra/config/loaders/resource-resolver.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import type { McpServerConfig, StepProviderOptions } from '../../core/models/index.js';
import type { Provider, ProviderType } from '../../infra/providers/index.js';
import { TAKT_MCP_MANAGER_TOOL_NAMES } from '../mcp/server.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from './managerMcp.js';

export interface ManagerConversationContext {
  provider: Provider;
  providerType: ProviderType;
  model: string | undefined;
  lang: 'ja' | 'en';
  providerOptions?: StepProviderOptions;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface ManagerConversationPlan {
  ctx: ManagerConversationContext;
  strategy: {
    systemPrompt: string;
    allowedTools: string[];
  };
}

export function createManagerConversationPlan(
  cwd: string,
  input: AssistantCliOverrides & { language?: 'ja' | 'en' },
): ManagerConversationPlan {
  const resolved = resolveAssistantProviderModel(cwd, input);
  if (resolved.provider === undefined) throw new Error('Provider is not configured.');
  const provider = getProvider(resolved.provider);
  const lang = input.language ?? resolveConfigValue(cwd, 'language');
  const context = { projectDir: cwd, lang };
  const configured = resolved.runtimeManaged
    ? resolved.providerOptions
    : resolveNonWorkflowProviderOptions(cwd, undefined, undefined, resolved.provider);
  const restrictions = resolveRequiredReadOnlyCapabilities(
    'manager', cwd, context, resolved.provider, provider, configured,
    TAKT_MCP_MANAGER_TOOL_NAMES.map((name) => `mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__${name}`),
  );
  const persona = resolveFacetByName('manager', 'personas', context);
  const instructionSource = resolveFacetByNameWithSource('manager', 'instructions', context);
  const instruction = instructionSource === undefined ? undefined
    : resolveRefToContent('manager', { manager: instructionSource }, cwd, 'instructions', context);
  if (persona === undefined || instruction === undefined) throw new Error('Manager facets are missing');
  return {
    ctx: {
      provider, providerType: resolved.provider, model: resolved.model, lang,
      providerOptions: restrictions.providerOptions,
    },
    strategy: {
      systemPrompt: [persona.trim(), instruction.trim(), `Repository: ${JSON.stringify(cwd)}`].join('\n\n'),
      allowedTools: restrictions.allowedTools,
    },
  };
}
