import type { ProviderType } from '../../infra/providers/types.js';
import { providerSupportsToolFreeExecution } from '../../infra/providers/provider-capabilities.js';

/**
 * Return whether `/verify` can keep both verifier provider calls tool-free.
 * Providers must explicitly guarantee tool-free execution on their regular
 * setup path; an undeclared capability fails closed.
 */
export function providerSupportsFormalSpecVerification(
  provider: ProviderType | undefined,
): boolean {
  return providerSupportsToolFreeExecution(provider) === true;
}

export * from './formalSpecVerifier.js';
