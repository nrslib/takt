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
import { resolveFormalSpecConfigurationWithoutPrompt } from '../interactive/taskInstructionFormat.js';
import { loadFormalSpecVerifierConstraints } from '../interactive/formalSpecPrompts.js';
import { renderTemplate } from '../../shared/prompts/index.js';
import { resolveManagerConfig } from '../../infra/config/managerConfig.js';
import { resolveManagerWorkflowSelection } from './workflowSelection.js';
import { warn } from '../../shared/ui/index.js';

export interface ManagerConversationContext {
  provider: Provider;
  providerType: ProviderType;
  model: string | undefined;
  lang: 'ja' | 'en';
  providerOptions?: StepProviderOptions;
  aiReviewPermissions?: boolean;
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
  input: AssistantCliOverrides & { language?: 'ja' | 'en'; repositoryDirectories?: readonly string[] },
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
  const specificationConfiguration = input.repositoryDirectories === undefined
    ? resolveFormalSpecConfigurationWithoutPrompt(cwd)
    : input.repositoryDirectories.map((repositoryDirectory) => ({
      repositoryDirectory, ...resolveFormalSpecConfigurationWithoutPrompt(repositoryDirectory),
    }));
  const specificationSettings = Array.isArray(specificationConfiguration) ? specificationConfiguration : [specificationConfiguration];
  const managerConfig = resolveManagerConfig(cwd, resolved.provider);
  for (const repositoryDirectory of input.repositoryDirectories ?? [cwd]) {
    const config = repositoryDirectory === cwd ? managerConfig : resolveManagerConfig(repositoryDirectory);
    for (const name of resolveManagerWorkflowSelection(repositoryDirectory, config, lang).missingWorkflows) {
      warn(`Manager workflow not found: ${name}; ignored in ${repositoryDirectory}. Check manager.workflows / manager.default_workflow in config.yaml.`);
    }
  }
  const instructionSource = resolveFacetByNameWithSource('manager', 'instructions', context);
  const instruction = instructionSource === undefined ? undefined
    : resolveRefToContent('manager', { manager: instructionSource }, cwd, 'instructions', context);
  if (persona === undefined || instruction === undefined || policy === undefined || knowledge === undefined) throw new Error('Manager facets are missing');
  return {
    ctx: {
      provider,
      providerType: resolved.provider, model: resolved.model, lang,
      providerOptions: configured, mcpServers: servers,
      aiReviewPermissions: managerConfig.permission === 'auto',
    },
    strategy: {
      systemPrompt: [
        persona.trim(), policy.trim(), knowledge.trim(), renderTemplate(instruction.trim(), {
          formalSpec: specificationSettings.some((setting) => setting.mode),
          formalSpecCommentsEnabled: specificationSettings.some((setting) => setting.mode && setting.comments),
          formalSpecVerifierConstraints: loadFormalSpecVerifierConstraints(lang),
        }),
        `Formal specification configuration: ${JSON.stringify(specificationConfiguration)}`,
        `Repository: ${JSON.stringify(cwd)}`,
        `Default workflow: ${JSON.stringify(managerConfig.defaultWorkflow ?? null)}`,
        `Repository manager.main_merge: ${JSON.stringify(managerConfig.mainMerge)}`,
        `Concurrency limit: ${resolveConfigValue(cwd, 'concurrency')}`,
      ].join('\n\n'),
    },
  };
}
