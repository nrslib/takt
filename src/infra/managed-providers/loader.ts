import { pathToFileURL } from 'node:url';
import { inspectDeepSeekHarnessInstallation, installDeepSeekHarness } from '../deepseek-harness/managed-package.js';
import { warnStaleProvider } from './messages.js';
export { warnStaleProvider } from './messages.js';
import { inspectManagedProvider, installManagedSdk, managedModulePath, type ManagedInstallOptions, type ManagedProviderInstallation } from './package.js';
import { MANAGED_MODULES, type ManagedProvider } from './definitions.js';

export class ManagedProviderInstallRequiredError extends Error {
  constructor(provider: ManagedProvider, cause?: unknown) {
    super(`Managed provider ${provider} is not installed or failed an integrity check. Run \`takt install ${provider}\`.`, { cause });
  }
}

export function inspectProviderInstallation(provider: ManagedProvider): Promise<ManagedProviderInstallation> {
  return provider === 'deepseek-harness' ? inspectDeepSeekHarnessInstallation() : inspectManagedProvider(provider);
}

export function installProvider(provider: ManagedProvider, options: ManagedInstallOptions): Promise<void> {
  return provider === 'deepseek-harness' ? installDeepSeekHarness(options) : installManagedSdk(provider, options);
}

export async function requireProviderInstallation(provider: ManagedProvider): Promise<ManagedProviderInstallation & { directory: string }> {
  const state = await inspectProviderInstallation(provider);
  if (state.state === 'missing' || state.directory === undefined) throw new ManagedProviderInstallRequiredError(provider, state.cause);
  if (state.state === 'stale') warnStaleProvider(provider);
  return { ...state, directory: state.directory };
}

interface ManagedModuleTypes {
  'claude-sdk': [typeof import('@anthropic-ai/claude-agent-sdk')];
  codex: [typeof import('@openai/codex-sdk')];
  opencode: [typeof import('@opencode-ai/sdk/v2'), typeof import('@opencode/client')];
  pi: [typeof import('@earendil-works/pi-coding-agent'), typeof import('@earendil-works/pi-ai')];
}

export async function loadManagedSdk<P extends keyof ManagedModuleTypes>(provider: P): Promise<{ directory: string; modules: ManagedModuleTypes[P]; stale: boolean }> {
  const state = await requireProviderInstallation(provider);
  const modules = await Promise.all(MANAGED_MODULES[provider].map(async (module) => {
    const entry = await managedModulePath(state.directory, module.name, module.export);
    return import(pathToFileURL(entry).href);
  }));
  return { directory: state.directory, modules: modules as ManagedModuleTypes[P], stale: state.state === 'stale' };
}
