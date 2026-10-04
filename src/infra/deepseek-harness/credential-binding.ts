import { createHash } from 'node:crypto';
import type { DeepSeekHarnessProviderOptions } from '../../core/models/workflow-types.js';
import {
  resolveDeepSeekCredentialHome,
  type DeepSeekCredentialSourceHome,
} from './credential-home.js';
import {
  readDeepSeekCredentialSelector,
  DeepSeekCredentialSettingsError,
  type DeepSeekCredentialSelector,
} from './credential-settings.js';
import {
  assertDeepSeekEndpointConsistency,
  DeepSeekEndpointError,
  resolveEffectiveDeepSeekEndpoint,
} from './endpoint-consistency.js';
import { DeepSeekCredentialDiagnosticError } from './credential-diagnostics.js';

export interface DeepSeekCredentialBinding {
  home: DeepSeekCredentialSourceHome;
  ref: string;
  endpoint: string;
  fingerprint: string;
}

export interface ResolveDeepSeekCredentialBindingOptions {
  childProcessEnv?: Readonly<Record<string, string>> | undefined;
  ambientEnv: Readonly<Record<string, string | undefined>>;
  userHome: string;
  providerOptions?: DeepSeekHarnessProviderOptions | undefined;
}

function createFingerprint(
  home: DeepSeekCredentialSourceHome,
  reference: string,
  endpoint: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      origin: home.origin,
      homePath: home.homePath,
      reference,
      endpoint,
    }))
    .digest('hex');
}

/**
 * Resolve the non-secret credential binding for one turn: source home, selector, and
 * endpoint consistency. Credential values stay in the official runtime; only the
 * fingerprint of these non-secret inputs is kept for process reuse decisions.
 */
export async function resolveDeepSeekCredentialBinding(
  options: ResolveDeepSeekCredentialBindingOptions,
): Promise<DeepSeekCredentialBinding> {
  const home = resolveDeepSeekCredentialHome({
    childProcessEnv: options.childProcessEnv,
    ambientEnv: options.ambientEnv,
    userHome: options.userHome,
  });
  let selector: DeepSeekCredentialSelector;
  try {
    selector = await readDeepSeekCredentialSelector(home.settingsPath);
  } catch (error) {
    throw new DeepSeekCredentialDiagnosticError(
      error instanceof DeepSeekCredentialSettingsError ? error.classification : 'invalid-settings',
      error instanceof DeepSeekCredentialSettingsError ? error.message : 'DeepSeek Harness credentials settings are invalid',
      { sourceHomeOrigin: home.origin },
    );
  }
  const endpoint = resolveEffectiveDeepSeekEndpoint({
    providerOptions: options.providerOptions,
    childProcessEnv: options.childProcessEnv,
    ambientEnv: options.ambientEnv,
  });
  try {
    assertDeepSeekEndpointConsistency({
      storedBaseUrl: selector.storedBaseUrl,
      effectiveBaseUrl: endpoint,
    });
  } catch (error) {
    throw new DeepSeekCredentialDiagnosticError(
      error instanceof DeepSeekEndpointError ? error.classification : 'runtime-failure',
      error instanceof DeepSeekEndpointError ? error.message : 'DeepSeek Harness endpoint validation failed',
      { sourceHomeOrigin: home.origin, reference: selector.ref },
    );
  }
  return {
    home,
    ref: selector.ref,
    endpoint,
    fingerprint: createFingerprint(home, selector.ref, endpoint),
  };
}
