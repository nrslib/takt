import { managedProviderFor, MANAGED_PROVIDER_SIZE_MB } from './definitions.js';
import { inspectProviderInstallation, installProvider, ManagedProviderInstallRequiredError, warnStaleProvider } from './loader.js';
import { getErrorMessage } from '../../shared/utils/error.js';

export type ConfirmManagedProvider = (message: string) => Promise<boolean>;

export class ManagedProviderInstallError extends Error {
  constructor(cause: unknown) {
    super(getErrorMessage(cause), { cause });
    this.name = 'ManagedProviderInstallError';
  }
}

export async function checkManagedProviders(providers: Iterable<string>, confirm: ConfirmManagedProvider | undefined, signal?: AbortSignal): Promise<void> {
  const required = new Set([...providers].map(managedProviderFor).filter((provider) => provider !== undefined));
  for (const provider of required) {
    signal?.throwIfAborted();
    const state = await inspectProviderInstallation(provider);
    if (state.state === 'ready') continue;
    if (confirm === undefined) {
      if (state.state === 'missing') throw new ManagedProviderInstallRequiredError(provider, state.cause);
      warnStaleProvider(provider);
      continue;
    }
    const size = MANAGED_PROVIDER_SIZE_MB[provider];
    const accepted = await confirm(`${state.state === 'missing' ? 'Install' : 'Update'} ${provider} SDK (approximately ${size} MB; varies by OS)?`);
    signal?.throwIfAborted();
    if (accepted) {
      try {
        await installProvider(provider, { signal });
      } catch (cause) {
        if (signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) throw cause;
        throw new ManagedProviderInstallError(cause);
      }
    } else if (state.state === 'missing') throw new ManagedProviderInstallRequiredError(provider);
    else warnStaleProvider(provider);
  }
}
