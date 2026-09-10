/**
 * AI call with automatic retry on stale/invalid session.
 *
 * Extracted from conversationLoop.ts for single-responsibility:
 * this module handles only the AI call + retry logic.
 */

import {
  updatePersonaSession,
} from '../../infra/config/index.js';
import { isQuietMode } from '../../shared/context.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { info, error, blankLine, StreamDisplay } from '../../shared/ui/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { EXIT_SIGINT } from '../../shared/exitCodes.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { getProvider } from '../../infra/providers/index.js';
import { createMcpAdapter, type PreparedProviderMcp, type ResolvedMcpServers } from '../../infra/providers/mcp/index.js';
import { buildMcpServerSetIdentity } from '../../infra/config/runtime-provider/mcp-schema.js';
import type { ImageAttachmentReference } from '../../shared/types/image-attachments.js';
import type { StreamCallback, StreamEvent } from '../../shared/types/provider.js';
import type { McpServerConfig, PermissionMode, StepProviderOptions } from '../../core/models/index.js';
import { expandImageAttachmentPlaceholders } from '../../infra/providers/imageAttachmentPrompt.js';
import { buildProviderRuntimeSystemPrompt } from '../../infra/providers/runtimeSystemPrompt.js';
import { parseTaskStateReferenceMarker } from '../../shared/task-state-reference.js';
import {
  providerSupportsAllowedTools,
  providerSupportsPermissionControls,
} from '../../infra/providers/provider-capabilities.js';

const log = createLogger('ai-caller');

/** Result from a single AI call */
export interface CallAIResult {
  content: string;
  sessionId?: string;
  success: boolean;
  /** Run confirmed by a successful `takt_get_run` MCP call in this turn. */
  referenceRunSlug?: string;
}

/** Initialized session context for conversation loops */
export interface SessionContext {
  provider: ReturnType<typeof getProvider>;
  providerType: ProviderType;
  model: string | undefined;
  lang: 'en' | 'ja';
  personaName: string;
  sessionId: string | undefined;
  providerOptions?: StepProviderOptions;
  /** MCP servers available to this conversation. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Internal identity for the TAKT-generated read-only task-state servers. */
  taskStateMcpServers?: Record<string, McpServerConfig>;
  permissionMode?: PermissionMode;
  /** Free-form per-call effort override selected in the interactive TUI. */
  effort?: string;
  /** Do not hide an invalid temporary override behind an automatic retry. */
  disableSessionRetry?: boolean;
}

interface CallAIWithRetryOptions {
  imageAttachments?: ImageAttachmentReference[];
  /** Receives what a terminal caller would have printed alongside the answer. */
  onNotice?: (message: string) => void;
  permissionMode?: PermissionMode;
  outputMode?: 'terminal' | 'silent';
  abortSignal?: AbortSignal;
  /**
   * Persist a returned session ID for later resume. Defaults to true.
   *
   * A predicate is evaluated once the provider has answered, so a caller whose
   * turn can be superseded — the TUI interrupts one and starts the next — can
   * refuse to write the session of a turn nobody is waiting for any more.
   */
  persistSession?: boolean | (() => boolean);
  /** Stream observer for callers that render the response themselves (`outputMode: 'silent'`). */
  onStream?: StreamCallback;
}

const TASK_GET_RUN_TOOL_NAMES = new Set([
  'takt_get_run',
  'mcp__takt__takt_get_run',
  'takt__takt_get_run',
]);

function isTaskGetRunTool(tool: string): boolean {
  return TASK_GET_RUN_TOOL_NAMES.has(tool);
}

function parseRunSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const slug = value.trim();
  return slug.length === 0 || slug === '.' || slug === '..' || /[\\/]/u.test(slug)
    ? undefined
    : slug;
}

interface RunReferenceTracker {
  observe(event: StreamEvent): void;
  getReferenceRunSlug(): string | undefined;
}

function createRunReferenceTracker(): RunReferenceTracker {
  const pending = new Map<string, string>();
  let referenceRunSlug: string | undefined;

  const complete = (id: string | undefined): void => {
    if (id === undefined) {
      return;
    }
    const runSlug = pending.get(id);
    if (runSlug !== undefined) {
      referenceRunSlug = runSlug;
      pending.delete(id);
    }
  };
  const observeReferenceResult = (value: string): void => {
    const runSlug = parseTaskStateReferenceMarker(value);
    if (runSlug !== undefined) {
      referenceRunSlug = runSlug;
    }
  };

  return {
    observe(event: StreamEvent): void {
      if (event.type === 'tool_use' && isTaskGetRunTool(event.data.tool)) {
        const runSlug = parseRunSlug(event.data.input.runSlug);
        if (runSlug !== undefined) {
          pending.set(event.data.id, runSlug);
        }
        return;
      }
      if (event.type === 'tool_result' && event.data.isError) {
        pending.delete(event.data.id ?? '');
        return;
      }
      if (event.type === 'tool_result' && !event.data.isError) {
        if (event.data.id === undefined || !pending.has(event.data.id)) {
          return;
        }
        observeReferenceResult(event.data.content);
        complete(event.data.id);
        return;
      }
      if (event.type === 'tool_output' && isTaskGetRunTool(event.data.tool)) {
        const resultId = event.data.id ?? [...pending.keys()].at(-1);
        if (resultId === undefined || !pending.has(resultId)) {
          return;
        }
        observeReferenceResult(event.data.output);
        complete(resultId);
        return;
      }
    },
    getReferenceRunSlug(): string | undefined {
      return referenceRunSlug;
    },
  };
}

function resolveConversationMcpServers(
  servers: Record<string, McpServerConfig> | undefined,
): ResolvedMcpServers | undefined {
  if (servers === undefined || Object.keys(servers).length === 0) {
    return undefined;
  }
  const serverNames = Object.keys(servers).sort();
  return {
    enabled: true,
    servers,
    serverNames,
    identity: buildMcpServerSetIdentity(servers),
  };
}

async function prepareConversationMcp(
  ctx: SessionContext,
  cwd: string,
  abortSignal: AbortSignal,
  permissionMode: PermissionMode | undefined,
  servers: ResolvedMcpServers,
): Promise<{ readonly servers: ResolvedMcpServers; readonly prepared: PreparedProviderMcp } | undefined> {
  const adapter = createMcpAdapter(ctx.providerType);
  adapter.validate(servers);
  const prepared = await adapter.prepare(servers, {
    cwd,
    abortSignal,
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(ctx.taskStateMcpServers === servers.servers
      ? { taskStateMcpServers: ctx.taskStateMcpServers }
      : {}),
  });
  return { servers, prepared };
}

async function disposeConversationMcp(
  prepared: PreparedProviderMcp | undefined,
): Promise<void> {
  if (prepared === undefined) {
    return;
  }
  try {
    await prepared.dispose();
  } catch (error) {
    log.warn('Failed to dispose interactive MCP resources', { error: getErrorMessage(error) });
  }
}

/**
 * Call AI with automatic retry on stale/invalid session.
 *
 * On session failure, clears sessionId and retries once without session.
 * Updates sessionId and persists it on success.
 */
export async function callAIWithRetry(
  prompt: string,
  systemPrompt: string,
  allowedTools: string[],
  cwd: string,
  ctx: SessionContext,
  options: CallAIWithRetryOptions = {},
): Promise<{
  result: CallAIResult | null;
  sessionId: string | undefined;
  /**
   * Why there is no result. A terminal caller reads it off the screen, but a
   * silent one (the Ink TUI) has no screen to read — without this the failure
   * would reach the user as "the assistant returned no response".
   */
  error?: string;
}> {
  const outputMode = options.outputMode ?? 'terminal';
  const display = outputMode === 'terminal'
    ? new StreamDisplay('assistant', isQuietMode())
    : undefined;
  const resolveStreamHandler = (activeDisplay: StreamDisplay | undefined): StreamCallback | undefined =>
    activeDisplay === undefined ? options.onStream : activeDisplay.createHandler();
  const abortController = new AbortController();
  const onExternalAbort = (): void => {
    abortController.abort(options.abortSignal?.reason);
  };
  if (options.abortSignal?.aborted) {
    onExternalAbort();
  } else {
    options.abortSignal?.addEventListener('abort', onExternalAbort, { once: true });
  }
  let sigintCount = 0;
  let forceExitRequested = false;
  const onSigInt = (): void => {
    sigintCount += 1;
    if (sigintCount === 1) {
      blankLine();
      info(getLabel('workflow.sigintGraceful', ctx.lang));
      abortController.abort();
      return;
    }
    blankLine();
    error(getLabel('workflow.sigintForce', ctx.lang));
    forceExitRequested = true;
    abortController.abort();
  };
  if (outputMode === 'terminal') {
    process.on('SIGINT', onSigInt);
  }
  const shouldPersistSession = (): boolean =>
    typeof options.persistSession === 'function'
      ? options.persistSession()
      : options.persistSession !== false;
  let { sessionId } = ctx;

  try {
    const resolvedSystemPrompt = buildProviderRuntimeSystemPrompt(
      systemPrompt,
      ctx.lang,
      ctx.provider.getRuntimeInstructions(),
    );
    const agent = ctx.provider.setup({ name: ctx.personaName, systemPrompt: resolvedSystemPrompt });
    const hasImageAttachments = options.imageAttachments !== undefined && options.imageAttachments.length > 0;
    const nativeImageAttachments = ctx.provider.supportsNativeImageInput
      ? options.imageAttachments
      : undefined;
    const promptForProvider = ctx.provider.supportsNativeImageInput
      ? prompt
      : expandImageAttachmentPlaceholders(prompt, options.imageAttachments);
    const allowedToolsForProvider = providerSupportsAllowedTools(ctx.providerType) === false
      ? undefined
      : allowedTools;
    // Per-call permissionMode is synthesized by the assistant strategy; a session-level mode is
    // resolved user configuration and must still reach the provider for explicit-constraint errors.
    const permissionModeForProvider = providerSupportsPermissionControls(ctx.providerType) === false
      ? ctx.permissionMode
      : options.permissionMode ?? ctx.permissionMode;
    // Only the terminal caller owns stdout; a silent caller (the Ink TUI) renders
    // its own frames and a stray write would corrupt them.
    if (hasImageAttachments && nativeImageAttachments === undefined) {
      // The image did not go to the provider as an image, and the user has to
      // know that. A terminal caller prints it; a silent one is handed the same
      // sentence to render its own way.
      const note = `Provider "${ctx.providerType}" does not support native image input; image paths were added to the prompt.`;
      if (outputMode === 'terminal') {
        info(note);
      } else {
        options.onNotice?.(note);
      }
    }
    const providerCallOptions = (
      activeSessionId: string | undefined,
      stream: StreamCallback | undefined,
      conversationMcp: { readonly servers: ResolvedMcpServers; readonly prepared: PreparedProviderMcp } | undefined,
    ) => ({
      cwd,
      model: ctx.model,
      sessionId: activeSessionId,
      ...(allowedToolsForProvider === undefined ? {} : { allowedTools: allowedToolsForProvider }),
      ...(permissionModeForProvider === undefined ? {} : { permissionMode: permissionModeForProvider }),
      providerOptions: ctx.providerOptions,
      effort: ctx.effort,
      abortSignal: abortController.signal,
      onStream: stream,
      imageAttachments: nativeImageAttachments,
      ...(conversationMcp === undefined ? {} : {
        mcpServers: conversationMcp.servers.servers,
        preparedMcp: conversationMcp.prepared,
      }),
    });

    const callProvider = async (
      providerAgent: ReturnType<SessionContext['provider']['setup']>,
      activeSessionId: string | undefined,
      activeDisplay: StreamDisplay | undefined,
    ): Promise<{ response: Awaited<ReturnType<typeof providerAgent.call>>; referenceRunSlug?: string }> => {
      // Some provider clients dispose the prepared MCP material when their call
      // ends. Prepare per attempt so a stale-session retry gets a live config.
      const referenceTracker = createRunReferenceTracker();
      const stream = resolveStreamHandler(activeDisplay);
      const trackedStream: StreamCallback | undefined = stream === undefined
        ? undefined
        : (event) => {
          referenceTracker.observe(event);
          stream(event);
        };
      const resolvedMcpServers = resolveConversationMcpServers(ctx.mcpServers);
      const conversationMcp = resolvedMcpServers === undefined
        ? undefined
        : await prepareConversationMcp(
          ctx,
          cwd,
          abortController.signal,
          permissionModeForProvider,
          resolvedMcpServers,
        );
      try {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason ?? new DOMException('The AI call was aborted', 'AbortError');
        }
        const response = await providerAgent.call(
          promptForProvider,
          providerCallOptions(activeSessionId, trackedStream, conversationMcp),
        );
        return {
          response,
          ...(response.status !== 'blocked' && response.status !== 'error'
            && referenceTracker.getReferenceRunSlug() !== undefined
            ? { referenceRunSlug: referenceTracker.getReferenceRunSlug() }
            : {}),
        };
      } finally {
        await disposeConversationMcp(conversationMcp?.prepared);
      }
    };

    const firstAttempt = await callProvider(agent, sessionId, display);
    const response = firstAttempt.response;
    display?.flush();
    const success = response.status !== 'blocked' && response.status !== 'error';

    if (!abortController.signal.aborted
      && !forceExitRequested
      && !success
      && sessionId
      && ctx.effort === undefined
      && ctx.disableSessionRetry !== true) {
      log.info('Session invalid, retrying without session');
      sessionId = undefined;
      const retryDisplay = outputMode === 'terminal'
        ? new StreamDisplay('assistant', isQuietMode())
        : undefined;
      const retryAgent = ctx.provider.setup({ name: ctx.personaName, systemPrompt: resolvedSystemPrompt });
      const retryAttempt = await callProvider(retryAgent, undefined, retryDisplay);
      const retry = retryAttempt.response;
      retryDisplay?.flush();
      if (retry.sessionId) {
        sessionId = retry.sessionId;
        if (shouldPersistSession()) {
          updatePersonaSession(cwd, ctx.personaName, sessionId, ctx.providerType);
        }
      }
      const retrySucceeded = retry.status !== 'blocked' && retry.status !== 'error';
      return {
        // A provider that fails puts its reason in `error`; the content of a
        // failed call is often empty, and reporting that empty string would hide
        // what went wrong.
        result: {
          content: retrySucceeded ? retry.content : (retry.error ?? retry.content),
          sessionId: retry.sessionId,
          success: retrySucceeded,
          ...(retrySucceeded && retryAttempt.referenceRunSlug === undefined
            ? {}
            : retrySucceeded
              ? { referenceRunSlug: retryAttempt.referenceRunSlug }
              : {}),
        },
        sessionId,
      };
    }

    if (response.sessionId) {
      sessionId = response.sessionId;
      if (shouldPersistSession()) {
        updatePersonaSession(cwd, ctx.personaName, sessionId, ctx.providerType);
      }
    }
    return {
      result: {
        content: success ? response.content : (response.error ?? response.content),
        sessionId: response.sessionId,
        success,
        ...(success && firstAttempt.referenceRunSlug === undefined
          ? {}
          : success
            ? { referenceRunSlug: firstAttempt.referenceRunSlug }
            : {}),
      },
      sessionId,
    };
  } catch (e) {
    const msg = getErrorMessage(e);
    log.error('AI call failed', { error: msg });
    if (outputMode === 'terminal') {
      error(msg);
      blankLine();
    }
    return { result: null, sessionId, error: msg };
  } finally {
    options.abortSignal?.removeEventListener('abort', onExternalAbort);
    if (outputMode === 'terminal') {
      process.removeListener('SIGINT', onSigInt);
    }
    if (forceExitRequested) {
      process.exit(EXIT_SIGINT);
    }
  }
}
