import type { AgentResponse } from '../../core/models/index.js';
import type { StreamCallback } from '../../shared/types/provider.js';
import { createLogger } from '../../shared/utils/index.js';
import { warn } from '../../shared/ui/index.js';
import { managedProviderFor, type ManagedProvider } from './definitions.js';

const log = createLogger('managed-providers');

export function warnStaleProvider(provider: ManagedProvider): void {
  const message = `Managed SDK for ${provider} differs from the version pinned by TAKT. Run \`takt update ${provider}\`.`;
  log.warn(message);
  warn(message);
}

export function withUpdateAdvice(message: string, provider: ManagedProvider): string {
  for (const match of message.matchAll(/\btakt update ([^\s`]+)/g)) {
    const target = match[1]!.replace(/\.$/, '');
    if (managedProviderFor(target) === provider) return message;
  }
  const updateCommand = `takt update ${provider}`;
  return `${message}\nSDK version differs from TAKT's pinned version. Run \`${updateCommand}\`.`;
}

export function managedFailureResponse(response: AgentResponse, stale: boolean, provider: ManagedProvider): AgentResponse {
  if (!stale || response.status === 'done') return response;
  return { ...response, content: withUpdateAdvice(response.content, provider), ...(response.error === undefined ? {} : { error: withUpdateAdvice(response.error, provider) }) };
}

export function managedFailureStream(stream: StreamCallback | undefined, stale: boolean, provider: ManagedProvider): StreamCallback | undefined {
  if (!stale || stream === undefined) return stream;
  return (event) => {
    if (event.type === 'result' && !event.data.success) {
      stream({ ...event, data: { ...event.data, result: withUpdateAdvice(event.data.result, provider), ...(event.data.error === undefined ? {} : { error: withUpdateAdvice(event.data.error, provider) }) } });
    } else stream(event);
  };
}
