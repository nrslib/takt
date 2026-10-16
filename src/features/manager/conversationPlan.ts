import { resolveConfigValue, resolveNonWorkflowProviderOptions } from '../../infra/config/index.js';
import { resolveAssistantProviderModel } from '../interactive/assistantConfig.js';
import { getProvider } from '../../infra/providers/index.js';
import { getGlobalConfigDir, getProjectConfigDir } from '../../infra/config/paths.js';
import { resolveInvocationRuntimeProviderFileWithOrigins } from '../../infra/config/runtime-provider/invocation.js';
import { resolveInternalAgentMcpServers } from '../../infra/config/runtime-provider/mcp-assignment.js';
import { resolveFacetByName, resolveFacetByNameWithSource, resolveRefToContent } from '../../infra/config/loaders/resource-resolver.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import type { McpServerConfig, StepProviderOptions } from '../../core/models/index.js';
import type { Provider, ProviderType } from '../../infra/providers/index.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';

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
  if (!provider.supportsStructuredOutput) {
    throw new Error(`Provider "${resolved.provider}" does not support manager structured output`);
  }
  if (!provider.supportedMcpTransports?.has('stdio')) {
    throw new Error(`Provider "${resolved.provider}" does not support manager stdio MCP`);
  }
  const { runtimeFile } = resolveInvocationRuntimeProviderFileWithOrigins({
    globalConfigDir: getGlobalConfigDir(), projectConfigDir: getProjectConfigDir(cwd),
  });
  const { servers } = resolveInternalAgentMcpServers(runtimeFile?.mcp, 'manager');
  const persona = resolveFacetByName('manager', 'personas', context);
  const policy = resolveFacetByName('manager', 'policies', context);
  const knowledge = resolveFacetByName('manager', 'knowledge', context);
  const managerConfig = resolveManagerConfig(cwd);
  const instructionSource = resolveFacetByNameWithSource('manager', 'instructions', context);
  const instruction = instructionSource === undefined ? undefined
    : resolveRefToContent('manager', { manager: instructionSource }, cwd, 'instructions', context);
  if (persona === undefined || instruction === undefined || policy === undefined || knowledge === undefined) throw new Error('Manager facets are missing');
  return {
    ctx: {
      provider, providerType: resolved.provider, model: resolved.model, lang,
      providerOptions: configured, mcpServers: servers,
    },
    strategy: {
      systemPrompt: [
        persona.trim(), policy.trim(), knowledge.trim(), instruction.trim(),
        `Repository: ${JSON.stringify(cwd)}`,
        `Default workflow: ${JSON.stringify(managerConfig.defaultWorkflow ?? null)}`,
        `Repository manager.main_merge: ${JSON.stringify(managerConfig.mainMerge)}`,
        `Concurrency limit: ${resolveConfigValue(cwd, 'concurrency')}`,
      ].join('\n\n'),
    },
  };
}
