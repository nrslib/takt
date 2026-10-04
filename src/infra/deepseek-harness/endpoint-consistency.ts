import type { DeepSeekHarnessProviderOptions } from '../../core/models/workflow-types.js';
import { DEEPSEEK_HARNESS_PUBLIC_BASE_URL } from './constants.js';

const INVALID_STORED_ENDPOINT_MESSAGE = 'DeepSeek Harness credentials settings baseURL must be '
  + 'an absolute http(s) URL; fix or remove llm-deepseek.baseURL in settings.yaml';
const USERINFO_STORED_ENDPOINT_MESSAGE = 'DeepSeek Harness credentials settings baseURL must not '
  + 'contain userinfo; remove the embedded credentials from llm-deepseek.baseURL';
const INVALID_EFFECTIVE_ENDPOINT_MESSAGE = 'DeepSeek Harness effective endpoint must be an '
  + 'absolute http(s) URL; align DEEPSEEK_BASE_URL or the deepseek_harness provider option base_url';
const ENDPOINT_MISMATCH_MESSAGE = 'DeepSeek Harness credentials settings baseURL does not match '
  + 'the effective endpoint; align DEEPSEEK_BASE_URL, the deepseek_harness provider option '
  + 'base_url, or the stored baseURL';

export interface ResolveEffectiveDeepSeekEndpointOptions {
  providerOptions?: DeepSeekHarnessProviderOptions | undefined;
  childProcessEnv?: Readonly<Record<string, string>> | undefined;
  ambientEnv: Readonly<Record<string, string | undefined>>;
}

export interface AssertDeepSeekEndpointConsistencyOptions {
  storedBaseUrl?: string | undefined;
  effectiveBaseUrl: string;
}

export class DeepSeekEndpointError extends Error {
  constructor(
    readonly classification: 'invalid-effective-endpoint' | 'invalid-stored-endpoint' | 'endpoint-mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'DeepSeekEndpointError';
  }
}

/** Keep the existing provider option, child environment, ambient environment, and default order. */
export function resolveConfiguredDeepSeekEndpoint(
  options: ResolveEffectiveDeepSeekEndpointOptions,
): string | undefined {
  return options.providerOptions?.baseUrl
    ?? options.childProcessEnv?.DEEPSEEK_BASE_URL
    ?? options.ambientEnv.DEEPSEEK_BASE_URL;
}

export function resolveEffectiveDeepSeekEndpoint(options: ResolveEffectiveDeepSeekEndpointOptions): string {
  return resolveConfiguredDeepSeekEndpoint(options) ?? DEEPSEEK_HARNESS_PUBLIC_BASE_URL;
}

function normalizeEndpoint(value: string, invalidMessage: string, classification: 'invalid-effective-endpoint' | 'invalid-stored-endpoint'): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DeepSeekEndpointError(classification, invalidMessage);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new DeepSeekEndpointError(classification, invalidMessage);
  }
  // The URL parser already folds scheme/host case and default ports; a trailing
  // slash is the only base-URL form this comparison treats as equivalent.
  const pathname = url.pathname.replace(/\/+$/u, '');
  return `${url.origin}${pathname}${url.search}${url.hash}`;
}

function normalizeStoredEndpoint(storedBaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(storedBaseUrl);
  } catch {
    throw new DeepSeekEndpointError('invalid-stored-endpoint', INVALID_STORED_ENDPOINT_MESSAGE);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new DeepSeekEndpointError('invalid-stored-endpoint', USERINFO_STORED_ENDPOINT_MESSAGE);
  }
  return normalizeEndpoint(storedBaseUrl, INVALID_STORED_ENDPOINT_MESSAGE, 'invalid-stored-endpoint');
}

/**
 * Reject a stored base URL that disagrees with the endpoint the runtime will use,
 * before any HTTP request can carry a stored credential to another host.
 */
export function assertDeepSeekEndpointConsistency(
  options: AssertDeepSeekEndpointConsistencyOptions,
): void {
  const effective = normalizeEndpoint(options.effectiveBaseUrl, INVALID_EFFECTIVE_ENDPOINT_MESSAGE, 'invalid-effective-endpoint');
  if (options.storedBaseUrl === undefined) {
    return;
  }
  const stored = normalizeStoredEndpoint(options.storedBaseUrl);
  if (stored !== effective) {
    throw new DeepSeekEndpointError('endpoint-mismatch', ENDPOINT_MISMATCH_MESSAGE);
  }
}
