import { resolveAssistantProviderModelFromConfig } from '../../core/config/provider-resolution.js';
import type { AgentResponse } from '../../core/models/index.js';
import { resolveAssistantConfigLayers } from '../../features/interactive/assistantConfig.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { getLanguage, resolveConfigValues } from '../config/index.js';
import { getProvider, type ProviderCallOptions, type ProviderType } from '../providers/index.js';

interface RunSyncConflictResolverOptions {
  projectCwd: string;
  cwd: string;
  originalInstruction: string;
  onStream?: ProviderCallOptions['onStream'];
}

async function autoApproveToolRequest(request: { input: Record<string, unknown> }) {
  return { behavior: 'allow' as const, updatedInput: request.input };
}

export async function runSyncConflictResolver(
  options: RunSyncConflictResolverOptions,
): Promise<AgentResponse> {
  const lang = getLanguage();
  const systemPrompt = loadTemplate('sync_conflict_resolver_system_prompt', lang);
  const prompt = loadTemplate('sync_conflict_resolver_message', lang, {
    originalInstruction: options.originalInstruction,
  });
  const config = resolveConfigValues(options.projectCwd, ['syncConflictResolver']);
  const resolvedProviderModel = resolveAssistantProviderModelFromConfig(
    resolveAssistantConfigLayers(options.projectCwd),
  );

  if (!resolvedProviderModel.provider) {
    throw new Error('No provider configured. Set "provider" in ~/.takt/config.yaml');
  }

  const provider = getProvider(resolvedProviderModel.provider as ProviderType);
  const agent = provider.setup({ name: 'conflict-resolver', systemPrompt });
  const onPermissionRequest = config.syncConflictResolver?.autoApproveTools
    ? autoApproveToolRequest
    : undefined;

  return agent.call(prompt, {
    cwd: options.cwd,
    model: resolvedProviderModel.model,
    permissionMode: 'edit',
    onPermissionRequest,
    onStream: options.onStream,
  });
}
