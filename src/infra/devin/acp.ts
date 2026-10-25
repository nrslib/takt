import { Readable, Writable } from 'node:stream';
import type { ReadableStream, WritableStream } from 'node:stream/web';
import { setTimeout as delay } from 'node:timers/promises';
import {
  client,
  MessageTooLargeError,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionUpdate,
  type ToolCallContent,
  type ToolKind,
  type Usage,
} from '@agentclientprotocol/sdk';
import { USAGE_MISSING_REASONS } from '../../core/logging/contracts.js';
import type { PermissionMode, ProviderUsageSnapshot } from '../../core/models/index.js';
import { packageVersion } from '../../shared/package-info.js';
import type { StreamEvent } from '../../shared/types/provider.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import {
  buildCloseErrorMessage,
  createExecError,
  type DevinAcpProcess,
  type DevinExecError,
  type DevinProcessExit,
} from './process.js';
import type { DevinCallOptions } from './types.js';

const log = createLogger('devin-acp');

// Devin reports the underlying tool name on tool calls under this key.
const INFERENCE_TOOL_NAME_META_KEY = 'cognition.ai/inferenceToolName';
// JSON-RPC errors carry Devin's failure taxonomy in
// `data['cognition.ai/errorKind']` (e.g. `resource_exhausted` on
// -32011 "Quota exhausted."). Kept structured on the exec error so the
// client can classify without re-parsing the message.
const DEVIN_ERROR_KIND_META_KEY = 'cognition.ai/errorKind';
// How long to wait for `exit`/`close` once a turn has already failed — the
// events land a few ticks after the stdout EOF or stdin EPIPE that produced
// the generic failure. Short enough to keep error paths responsive when the
// leader is still alive.
const PROCESS_EXIT_PROBE_MS = 100;
const PROCESS_EXIT_POLL_MS = 5;

export interface DevinAcpTurnOutcome {
  content: string;
  sessionId: string;
  providerUsage: ProviderUsageSnapshot;
  stopReason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolNameOf(call: {
  name?: string | null;
  title?: string | null;
  kind?: ToolKind | null;
  _meta?: { [key: string]: unknown } | null;
}): string {
  const meta = call._meta?.[INFERENCE_TOOL_NAME_META_KEY];
  const name = typeof meta === 'string' && meta.length > 0
    ? meta
    : call.name ?? call.title ?? call.kind ?? 'tool';
  // Devin's shell tool is `exec`; TAKT canonicalizes shell calls as `Bash`
  // (codex does the same) so companion commit-probing and mutation tracking
  // see them like any other provider's shell commands.
  return name === 'exec' ? 'Bash' : name;
}

function toolCallText(content: ToolCallContent[] | null | undefined): string {
  const parts: string[] = [];
  for (const item of content ?? []) {
    if (item.type === 'content') {
      if (item.content.type === 'text') {
        parts.push(item.content.text);
      } else if (item.content.type === 'resource' && 'text' in item.content.resource) {
        parts.push(item.content.resource.text);
      }
    } else if (item.type === 'diff') {
      parts.push(`[diff] ${item.path}`);
    }
  }
  return parts.join('\n').trim();
}

interface DevinToolStreamState {
  name: string;
  /** Last cumulative output text seen; ACP tool content replaces, it does not append. */
  output: string;
  /** Set once a tool_result has been emitted so completion fires exactly once. */
  finalized: boolean;
}

// Maps Devin ACP session updates onto the same stream events other TAKT
// providers emit: `tool_call` -> tool_use, `tool_call_update` -> tool_output
// deltas while running and tool_result once completed/failed, message chunks
// -> text and thought chunks -> thinking. ACP `tool_call_update` content is
// cumulative (marked `cognition.ai/terminalPreview`) and a completed update
// usually carries no content at all, so the last seen output is kept for the
// tool_result and only the appended suffix is streamed as tool_output —
// matching the delta contract codex/pi already emit.
function sessionUpdateToStreamEvents(
  update: SessionUpdate,
  toolStates: Map<string, DevinToolStreamState>,
): StreamEvent[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content.type === 'text' && update.content.text.length > 0
        ? [{ type: 'text', data: { text: update.content.text } }]
        : [];
    case 'agent_thought_chunk':
      return update.content.type === 'text' && update.content.text.length > 0
        ? [{ type: 'thinking', data: { thinking: update.content.text } }]
        : [];
    case 'tool_call': {
      const name = toolNameOf(update);
      const output = toolCallText(update.content);
      const finished = update.status === 'completed' || update.status === 'failed';
      toolStates.set(update.toolCallId, { name, output, finalized: finished });
      const events: StreamEvent[] = [{
        type: 'tool_use',
        data: {
          id: update.toolCallId,
          tool: name,
          input: isRecord(update.rawInput) ? update.rawInput : {},
        },
      }];
      if (finished) {
        events.push({
          type: 'tool_result',
          data: {
            id: update.toolCallId,
            content: output,
            isError: update.status === 'failed',
          },
        });
      } else if (output.length > 0) {
        events.push({
          type: 'tool_output',
          data: { id: update.toolCallId, tool: name, output },
        });
      }
      return events;
    }
    case 'tool_call_update': {
      const events: StreamEvent[] = [];
      let state = toolStates.get(update.toolCallId);
      if (state === undefined) {
        state = { name: toolNameOf(update), output: '', finalized: false };
        toolStates.set(update.toolCallId, state);
        events.push({
          type: 'tool_use',
          data: {
            id: update.toolCallId,
            tool: state.name,
            input: isRecord(update.rawInput) ? update.rawInput : {},
          },
        });
      }
      const output = toolCallText(update.content);
      const current = output.length > 0 ? output : state.output;
      const delta = current.startsWith(state.output)
        ? current.slice(state.output.length)
        : current;
      state.output = current;
      if (delta.length > 0) {
        events.push({
          type: 'tool_output',
          data: { id: update.toolCallId, tool: state.name, output: delta },
        });
      }
      if ((update.status === 'completed' || update.status === 'failed') && !state.finalized) {
        state.finalized = true;
        events.push({
          type: 'tool_result',
          data: {
            id: update.toolCallId,
            content: state.output,
            isError: update.status === 'failed',
          },
        });
      }
      return events;
    }
    default:
      return [];
  }
}

// TAKT permission semantics are enforced by the `--config` rules plus answers
// to permission requests: `full` approves once, every other mode rejects —
// identical to print mode auto-denying prompts. `allow_always`-style options
// are never chosen because they persist decisions into the Devin config.
function permissionOutcome(allow: boolean, options: PermissionOption[]): RequestPermissionResponse {
  const candidate = allow
    ? options.find((option) => option.kind === 'allow_once')
    : options.find((option) => option.kind === 'reject_once')
      ?? options.find((option) => option.kind === 'reject_always');
  if (!candidate) {
    return { outcome: { outcome: 'cancelled' } };
  }
  return { outcome: { outcome: 'selected', optionId: candidate.optionId } };
}

// TAKT `readonly` -> `ask` (the agent has no write/exec tools at all and the
// generated deny rules still block them), `edit`/unset -> `accept-edits`
// (rules decide the rest), `full` -> `bypass`. A failed set_mode still leaves
// the config rules and request answers in place, so it is non-fatal.
function acpModeIdFor(permissionMode: PermissionMode | undefined): string {
  switch (permissionMode) {
    case 'readonly':
      return 'ask';
    case 'full':
      return 'bypass';
    default:
      return 'accept-edits';
  }
}

const MODEL_OPTION_ID = 'model';
const THOUGHT_LEVEL_OPTION_ID = 'thought_level';

function selectOptionValues(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== 'select') {
    return [];
  }
  const values: SessionConfigSelectOption[] = [];
  for (const entry of option.options) {
    if ('options' in entry) {
      values.push(...entry.options);
    } else {
      values.push(entry);
    }
  }
  return values;
}

function configSelectOption(
  configOptions: SessionConfigOption[],
  id: string,
): SessionConfigOption | undefined {
  return configOptions.find((option) => option.id === id && option.type === 'select');
}

function selectCurrentValue(option: SessionConfigOption | undefined): string | undefined {
  return option?.type === 'select' ? option.currentValue : undefined;
}

function normalizeModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// `devin acp --model` resolves fuzzy names (family slug, alias, or partial
// name) at session creation, but silently falls back to the configured
// default for names it cannot resolve. The session's config options show
// what was actually selected, so a requested name that matches none of the
// resolved identities means the CLI fell back. Candidates cover the
// '<name>-<level>' spelling too: 'swe-2-max' resolves to model 'swe-2-high'
// (display name 'SWE-2') + thought_level 'max'.
function requestedModelReflected(
  configOptions: SessionConfigOption[],
  requested: string,
): boolean {
  const modelOption = configSelectOption(configOptions, MODEL_OPTION_ID);
  const current = selectCurrentValue(modelOption);
  if (!modelOption || current === undefined) {
    return false;
  }
  const entry = selectOptionValues(modelOption).find((value) => value.value === current);
  const level = selectCurrentValue(configSelectOption(configOptions, THOUGHT_LEVEL_OPTION_ID));
  const candidates = [current, entry?.name ?? ''];
  if (entry?.name !== undefined && level !== undefined) {
    candidates.push(`${entry.name}-${level}`);
  }
  const needle = normalizeModelName(requested);
  // Very short names are too loose for a substring check — fail them instead.
  return needle.length >= 3
    && candidates.some((candidate) => normalizeModelName(candidate).includes(needle));
}

function unavailableModelError(requested: string, sessionModel: string | undefined): DevinExecError {
  return createExecError(
    `Requested Devin model '${requested}' is not available for this session `
    + `(session model: '${sessionModel ?? 'unknown'}'). Pass an exact model option value `
    + `or a '<family>-<level>' name such as 'swe-2-max'.`,
  );
}

function usageFromAcp(usage: Usage | null | undefined): ProviderUsageSnapshot {
  if (!usage) {
    return { usageMissing: true, reason: USAGE_MISSING_REASONS.NOT_AVAILABLE };
  }
  const snapshot: ProviderUsageSnapshot = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    usageMissing: false,
  };
  if (usage.cachedReadTokens != null || usage.cachedWriteTokens != null) {
    const cachedRead = usage.cachedReadTokens ?? 0;
    const cachedWrite = usage.cachedWriteTokens ?? 0;
    snapshot.cachedInputTokens = cachedRead + cachedWrite;
    snapshot.cacheReadInputTokens = cachedRead;
    snapshot.cacheCreationInputTokens = cachedWrite;
  }
  return snapshot;
}

function acpExitError(exit: DevinProcessExit, proc: DevinAcpProcess): DevinExecError {
  const stderr = proc.stderrText();
  if (proc.stderrOverflowed()) {
    return createExecError('devin stderr exceeded buffer limit', {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stderr,
      signal: exit.signal,
    });
  }
  return createExecError(buildCloseErrorMessage(exit.code, exit.signal), {
    code: exit.code === null ? undefined : exit.code,
    stderr,
    signal: exit.signal,
  });
}

function normalizeAcpError(error: unknown, proc: DevinAcpProcess): DevinExecError {
  const stderr = proc.stderrText();
  if (error instanceof RequestError) {
    const data = error.data === undefined ? '' : ` ${JSON.stringify(error.data)}`;
    const errorKind = isRecord(error.data) && typeof error.data[DEVIN_ERROR_KIND_META_KEY] === 'string'
      ? error.data[DEVIN_ERROR_KIND_META_KEY]
      : undefined;
    return createExecError(`devin acp error ${error.code}: ${error.message}${data}`, { stderr, errorKind });
  }
  if (error instanceof MessageTooLargeError) {
    return createExecError('devin acp message exceeded buffer limit', {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stderr,
    });
  }
  const execError = error as DevinExecError;
  if (execError instanceof Error) {
    // Internal errors (e.g. the model check) are raised without stderr; the
    // captured diagnostics still explain why the turn failed downstream.
    execError.stderr ??= stderr;
    return execError;
  }
  return createExecError(getErrorMessage(error), { stderr });
}

// Transport-level failures that carry no diagnostic of their own — when the
// process is gone, the exit code plus stderr explain them better.
const TRANSPORT_FAILURE_PATTERN = /ACP connection closed|stream error|EPIPE|ECONNRESET/i;

// A dying process makes the SDK reject in-flight requests with a generic
// "ACP connection closed" — or the stdin write EPIPEs — because the pipes
// break before `exit`/`close` settle. Structured JSON-RPC errors keep their
// own detail; for anything else, when the process is already gone the exit
// code/signal plus captured stderr explain the failure far better than the
// connection-close fallback. A clean exit racing an application-level error
// (e.g. the model check aborting the session) is a consequence, not the
// cause, so the original error stands.
async function normalizeAcpFailure(error: unknown, proc: DevinAcpProcess): Promise<DevinExecError> {
  if (error instanceof RequestError || error instanceof MessageTooLargeError) {
    return normalizeAcpError(error, proc);
  }
  const normalized = normalizeAcpError(error, proc);
  const deadline = Date.now() + PROCESS_EXIT_PROBE_MS;
  let exit = proc.exitInfo();
  while (exit === undefined && Date.now() < deadline) {
    await delay(PROCESS_EXIT_POLL_MS);
    exit = proc.exitInfo();
  }
  if (exit === undefined) {
    return normalized;
  }
  const abnormalExit = exit.signal !== null || (exit.code ?? 0) !== 0;
  return abnormalExit || TRANSPORT_FAILURE_PATTERN.test(normalized.message)
    ? acpExitError(exit, proc)
    : normalized;
}

// Runs one Devin turn over `devin acp` JSON-RPC: initialize -> session/new or
// session/load -> session/set_mode -> session/prompt. Text deltas and tool
// events stream through `options.onStream` while the prompt request is in
// flight; the accumulated text is returned as `content`.
export async function runDevinAcpPrompt(
  proc: DevinAcpProcess,
  promptText: string,
  options: DevinCallOptions,
): Promise<DevinAcpTurnOutcome> {
  const childStdin = proc.child.stdin;
  const childStdout = proc.child.stdout;
  if (!childStdin || !childStdout) {
    throw createExecError('devin acp stdio pipes are unavailable');
  }

  const stream = ndJsonStream(
    Writable.toWeb(childStdin) as WritableStream<Uint8Array>,
    Readable.toWeb(childStdout) as ReadableStream<Uint8Array>,
  );

  let sessionId = options.sessionId;
  // History replays over session/update notifications during session/load, so
  // text collection and event emission only run while a prompt is in flight.
  let promptActive = false;
  let sendCancel: (() => void) | undefined;
  const textParts: string[] = [];
  const toolStates = new Map<string, DevinToolStreamState>();

  const app = client({ name: 'takt' })
    .onRequest(methods.client.session.requestPermission, ({ params }) =>
      permissionOutcome(options.permissionMode === 'full', params.options))
    .onNotification(methods.client.session.update, ({ params }) => {
      if (!promptActive || params.sessionId !== sessionId) {
        return;
      }
      const update = params.update;
      // Session updates cluster around tool activity — exactly when exec
      // children spawn. Keep the detached-descendant snapshot fresh so a
      // leader exit can still find them after reparenting.
      proc.refreshDescendants();
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        textParts.push(update.content.text);
      }
      for (const event of sessionUpdateToStreamEvents(update, toolStates)) {
        options.onStream?.(event);
      }
    });

  const exitFailure = proc.exited.then((exit) => {
    throw acpExitError(exit, proc);
  });
  // A clean shutdown after a finished turn still resolves `exited`; the
  // derived rejection must not go unhandled once the race is settled.
  exitFailure.catch(() => {});

  const onAbort = (): void => {
    sendCancel?.();
    proc.terminate();
  };
  if (options.abortSignal?.aborted) {
    proc.terminate();
    throw createExecError('Devin execution aborted', { name: 'AbortError', stderr: proc.stderrText() });
  }
  options.abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await Promise.race([
      app.connectWith(stream, async (ctx) => {
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: 'takt', version: packageVersion },
        });

        let configOptions: SessionConfigOption[];
        if (sessionId) {
          const loaded = await ctx.request(methods.agent.session.load, {
            sessionId,
            cwd: options.cwd,
            mcpServers: [],
          });
          configOptions = loaded.configOptions ?? [];
        } else {
          const created = await ctx.request(methods.agent.session.new, {
            cwd: options.cwd,
            mcpServers: [],
          });
          sessionId = created.sessionId;
          configOptions = created.configOptions ?? [];
        }
        if (!sessionId) {
          throw createExecError('devin acp did not return a session ID');
        }
        const activeSessionId = sessionId;
        sendCancel = () => {
          void ctx.notify(methods.agent.session.cancel, { sessionId: activeSessionId }).catch(() => {});
        };

        try {
          await ctx.request(methods.agent.session.setMode, {
            sessionId: activeSessionId,
            modeId: acpModeIdFor(options.permissionMode),
          });
        } catch (error) {
          log.debug('Devin ACP session mode could not be set', { error: getErrorMessage(error) });
        }

        // `--model` is only passed on session creation; a resumed session
        // keeps the model it was created with (a TAKT step never switches
        // model mid-flight), so nothing is applied here on resume. On a new
        // session the resolved options are verified because `devin acp`
        // silently falls back to the configured default for names it cannot
        // resolve (unlike `devin -p`, which errors with "Unknown model").
        if (options.model && options.sessionId === undefined
          && !requestedModelReflected(configOptions, options.model)) {
          throw unavailableModelError(
            options.model,
            selectCurrentValue(configSelectOption(configOptions, MODEL_OPTION_ID)),
          );
        }

        const sessionModel = selectCurrentValue(configSelectOption(configOptions, MODEL_OPTION_ID));
        const sessionLevel = selectCurrentValue(configSelectOption(configOptions, THOUGHT_LEVEL_OPTION_ID));
        const model = sessionModel === undefined
          ? 'unknown'
          : sessionLevel === undefined ? sessionModel : `${sessionModel}@${sessionLevel}`;
        options.onStream?.({ type: 'init', data: { model, sessionId: activeSessionId } });

        promptActive = true;
        let response: PromptResponse;
        try {
          response = await ctx.request(methods.agent.session.prompt, {
            sessionId: activeSessionId,
            prompt: [{ type: 'text', text: promptText }],
          });
        } finally {
          promptActive = false;
        }

        return {
          content: textParts.join(''),
          sessionId: activeSessionId,
          providerUsage: usageFromAcp(response.usage),
          stopReason: response.stopReason,
        };
      }),
      exitFailure,
    ]);
  } catch (error) {
    const normalized = await normalizeAcpFailure(error, proc);
    // The session may already exist (session/new resolved) even though the
    // turn failed — report it so the caller can resume or inspect it.
    normalized.sessionId = sessionId;
    throw normalized;
  } finally {
    options.abortSignal?.removeEventListener('abort', onAbort);
    proc.terminate();
  }
}
