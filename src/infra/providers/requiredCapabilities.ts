import { isDeepStrictEqual } from 'node:util';
import type { StepProviderOptions } from '../../core/models/index.js';
import type { ProviderType } from '../../shared/types/provider.js';
import type { Provider } from './types.js';
import { resolveCapabilitySets } from '../config/loaders/capabilitySetResolver.js';
import type { FacetResolutionContext } from '../config/loaders/resource-resolver.js';
import { mergeProviderOptions } from '../config/providerOptions.js';

export function resolveRequiredReadOnlyCapabilities(
  name: string,
  cwd: string,
  context: FacetResolutionContext,
  providerType: ProviderType,
  provider: Provider,
  configured: StepProviderOptions | undefined,
  mcpTools: readonly string[],
): { providerOptions: StepProviderOptions; allowedTools: string[] } {
  if (provider.supportsStrictToolAllowlist !== true
    || !provider.supportsStructuredOutput
    || !provider.supportedMcpTransports?.has('stdio')) {
    throw new Error(`Provider "${providerType}" cannot enforce the required read-only tool capabilities`);
  }
  const capabilities = resolveCapabilitySets(name, cwd, context);
  // These capability leaves are the enforcement inputs; an override cannot widen them.
  if (!isDeepStrictEqual(capabilities.claude?.allowedTools, ['Read'])
    || capabilities.claude?.skills?.enabled !== false
    || capabilities.claude?.sandbox?.allowUnsandboxedCommands !== false
    || !isDeepStrictEqual(capabilities.claude?.sandbox?.excludedCommands, [])
    || !isDeepStrictEqual(capabilities.opencode?.allowedTools, ['read'])
    || capabilities.opencode?.networkAccess !== false
    || capabilities.codex?.networkAccess !== false) {
    throw new Error(`Capabilities "${name}" do not preserve the required read-only restrictions`);
  }
  if (configured?.claude?.allowedTools?.some((tool) => tool !== 'Read')
    || configured?.claude?.sandbox?.allowUnsandboxedCommands === true
    || (configured?.claude?.sandbox?.excludedCommands?.length ?? 0) > 0
    || configured?.claude?.skills?.enabled === true
    || configured?.opencode?.networkAccess === true
    || configured?.opencode?.allowedTools?.some((tool) => tool !== 'read')
    || configured?.codex?.networkAccess === true) {
    throw new Error('Configured provider options conflict with the required read-only restrictions');
  }
  const providerOptions = mergeProviderOptions(configured, capabilities);
  if (providerOptions === undefined) throw new Error('Required capability options are missing');
  return { providerOptions, allowedTools: ['Read', ...mcpTools] };
}
