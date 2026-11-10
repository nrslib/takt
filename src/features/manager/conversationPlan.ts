import { resolve } from 'node:path';
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
import { invalidateGlobalConfigCache, loadGlobalConfig } from '../../infra/config/global/globalConfig.js';
import { loadGlobalConfigTraceState } from '../../infra/config/global/globalConfigCore.js';
import { loadProjectConfig, loadProjectConfigTraceState } from '../../infra/config/project/projectConfig.js';
import { withConfigSnapshot } from '../../infra/config/configSnapshot.js';

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

type ManagerConversationInput = AssistantCliOverrides & { language?: 'ja' | 'en'; repositoryDirectories?: readonly string[] };
type RepositoryConfigScope = <T>(directory: string, action: () => T) => T;

export function createManagerConversationPlan(cwd: string, input: ManagerConversationInput): ManagerConversationPlan {
  invalidateGlobalConfigCache();
  const global = loadGlobalConfig();
  const globalTrace = loadGlobalConfigTraceState();
  const directories = new Set([cwd, ...(input.repositoryDirectories ?? [])].map((directory) => resolve(directory)));
  const snapshots = new Map([...directories].map((projectDir) => [projectDir, {
    projectDir, project: loadProjectConfig(projectDir), global,
    projectTrace: loadProjectConfigTraceState(projectDir), globalTrace,
  }]));
  const withRepositoryConfig: RepositoryConfigScope = (directory, action) => withConfigSnapshot(snapshots.get(resolve(directory))!, action);
  return withRepositoryConfig(cwd, () => buildManagerConversationPlan(cwd, input, withRepositoryConfig));
}

function buildManagerConversationPlan(
  cwd: string,
  input: ManagerConversationInput,
  withRepositoryConfig: RepositoryConfigScope,
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
      repositoryDirectory, ...withRepositoryConfig(repositoryDirectory, () => resolveFormalSpecConfigurationWithoutPrompt(repositoryDirectory)),
    }));
  const specificationSettings = Array.isArray(specificationConfiguration) ? specificationConfiguration : [specificationConfiguration];
  const managerConfig = resolveManagerConfig(cwd, resolved.provider);
  const workflowSelection = resolveManagerWorkflowSelection(cwd, managerConfig, lang);
  for (const repositoryDirectory of new Set([cwd, ...(input.repositoryDirectories ?? [])])) {
    const selection = resolve(repositoryDirectory) === resolve(cwd) ? workflowSelection
      : withRepositoryConfig(repositoryDirectory, () => resolveManagerWorkflowSelection(repositoryDirectory, resolveManagerConfig(repositoryDirectory), lang));
    for (const name of selection.missingWorkflows) {
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
        `Default workflow: ${JSON.stringify(workflowSelection.defaultWorkflow ?? null)}`,
        `Repository manager.main_merge: ${JSON.stringify(managerConfig.mainMerge)}`,
        `Concurrency limit: ${resolveConfigValue(cwd, 'concurrency')}`,
      ].join('\n\n'),
    },
  };
}
