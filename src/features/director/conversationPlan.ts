import { getProvider } from '../../infra/providers/index.js';
import { resolveConfigValue, resolveNonWorkflowProviderOptions } from '../../infra/config/index.js';
import { resolveAssistantProviderModel } from '../interactive/assistantConfig.js';
import { resolveFacetByName, resolveFacetByNameWithSource, resolveRefToContent } from '../../infra/config/loaders/resource-resolver.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import type { ManagerConversationContext } from '../manager/conversationPlan.js';

export interface DirectorConversationPlan {
  cwd: string;
  ctx: ManagerConversationContext;
  systemPrompt: string;
}

export function createDirectorConversationPlan(configDirectory: string, overrides: AssistantCliOverrides): DirectorConversationPlan {
  // The daemon's global directory is the resolution base, never the launching repository.
  const cwd = configDirectory;
  const resolved = resolveAssistantProviderModel(cwd, overrides);
  if (resolved.provider === undefined) throw new Error('Director provider is not configured');
  const provider = getProvider(resolved.provider);
  if (provider.supportsStrictToolAllowlist !== true || !provider.supportedMcpTransports?.has('http')) {
    throw new Error(`Provider "${resolved.provider}" cannot enforce director MCP-only tool access`);
  }
  const lang = resolveConfigValue(cwd, 'language');
  const context = { projectDir: cwd, lang };
  const facets = (['personas', 'policies', 'knowledge'] as const).map((category) =>
    resolveFacetByName('director', category, context));
  const source = resolveFacetByNameWithSource('director', 'instructions', context);
  const instruction = source === undefined ? undefined
    : resolveRefToContent('director', { director: source }, cwd, 'instructions', context);
  const systemPrompt = [...facets, instruction].map((facet) => {
    if (facet === undefined) throw new Error('Director facets are missing');
    return facet.trim();
  }).join('\n\n');
  const configured = resolved.runtimeManaged ? resolved.providerOptions
    : resolveNonWorkflowProviderOptions(cwd, undefined, undefined, resolved.provider);
  const providerOptions = resolved.provider === 'opencode'
    ? { ...configured, opencode: { ...configured?.opencode, skills: { enabled: false } } }
    : configured;
  return { cwd, systemPrompt,
    ctx: { provider, providerType: resolved.provider, model: resolved.model, lang,
      providerOptions } };
}
