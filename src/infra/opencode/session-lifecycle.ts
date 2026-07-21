import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';

interface OpenCodeSessionAbortClient {
  session: {
    abort: (
      parameters: { sessionID: string; directory: string },
      options: { signal: AbortSignal },
    ) => Promise<{ data?: boolean; error?: unknown }>;
  };
}

export type OpenCodeSessionStopResult =
  | { ok: true }
  | { ok: false; error: Error };

interface OpenCodeSessionLifecycleOptions {
  client: OpenCodeSessionAbortClient;
  sessionId: string;
  directory: string;
  abortTimeoutMs: number;
  invalidateServer: (error: Error) => void;
}

const HTTP_URL_PATTERN = /https?:\/\/[^\s'"`<>|]+/gi;

export interface OpenCodeSessionLifecycle {
  markPromptSent(): void;
  confirmIdle(): void;
  stopServerSessionOnce(): Promise<OpenCodeSessionStopResult>;
}

export function createOpenCodeSessionLifecycle(
  options: OpenCodeSessionLifecycleOptions,
): OpenCodeSessionLifecycle {
  let promptSent = false;
  let idleConfirmed = false;
  let stopPromise: Promise<OpenCodeSessionStopResult> | undefined;

  const stopServerSessionOnce = (): Promise<OpenCodeSessionStopResult> => {
    if (!promptSent || idleConfirmed) {
      return Promise.resolve({ ok: true });
    }
    if (stopPromise !== undefined) {
      return stopPromise;
    }

    stopPromise = stopActiveServerSession(options);
    return stopPromise;
  };

  return {
    markPromptSent: () => {
      promptSent = true;
    },
    confirmIdle: () => {
      idleConfirmed = true;
    },
    stopServerSessionOnce,
  };
}

async function stopActiveServerSession(
  options: OpenCodeSessionLifecycleOptions,
): Promise<OpenCodeSessionStopResult> {
  const cleanupController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      options.client.session.abort(
        { sessionID: options.sessionId, directory: options.directory },
        { signal: cleanupController.signal },
      ),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          cleanupController.abort();
          reject(new Error('OpenCode server session abort timed out'));
        }, options.abortTimeoutMs);
      }),
    ]);
    if (response.error === undefined && response.data === true) {
      return { ok: true };
    }
    return failClosed(options, response.error);
  } catch (error) {
    return failClosed(options, error);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function failClosed(options: OpenCodeSessionLifecycleOptions, cause: unknown): OpenCodeSessionStopResult {
  const detail = safeAbortFailureDetail(cause, options.sessionId, options.directory);
  const error = new Error(`OpenCode server session abort failed${detail === undefined ? '' : `: ${detail}`}`);
  options.invalidateServer(error);
  return { ok: false, error };
}

function safeAbortFailureDetail(
  cause: unknown,
  sessionId: string,
  directory: string,
): string | undefined {
  const message = cause instanceof Error
    ? cause.message
    : typeof cause === 'object' && cause !== null && typeof (cause as { message?: unknown }).message === 'string'
      ? (cause as { message: string }).message
      : undefined;
  if (message === undefined) return undefined;
  const providerSanitized = redactKnownValue(
    redactKnownValue(message.replace(HTTP_URL_PATTERN, '[URL]'), sessionId, '[session]'),
    directory,
    '[directory]',
  );
  return safeExternalErrorMessage(new Error(providerSanitized)).slice(0, 160);
}

function redactKnownValue(text: string, value: string, replacement: string): string {
  return value.length === 0 ? text : text.split(value).join(replacement);
}
