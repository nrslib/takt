import { Readable, Writable } from 'node:stream';
import type { ReadableStream, WritableStream } from 'node:stream/web';
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
  if (typeof meta === 'string' && meta.length > 0) {
    return meta;
  }
  return call.name ?? call.title ?? call.kind ?? 'tool';
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
// Used to split `<family>-<level>` model names when the session does not
// advertise a `thought_level` option to enumerate levels from.
const FALLBACK_THOUGHT_LEVELS = ['xhigh', 'medium', 'high', 'low', 'max'];

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

function thoughtLevelSuffix(normalized: string, levels: string[]): string | undefined {
  return levels.find(
    (level) => normalized.endsWith(`-${level}`) && normalized.length > level.length + 1,
  );
}

function modelValueStem(value: string, levels: string[]): string {
  const normalized = normalizeModelName(value);
  const suffix = thoughtLevelSuffix(normalized, levels);
  return suffix === undefined ? normalized : normalized.slice(0, -suffix.length - 1);
}

interface ResolvedModelRequest {
  modelValue: string;
  thoughtLevel?: string;
}

// Devin splits a display model name such as "SWE-2 Max" into the `model`
// config option (the family, e.g. value 'swe-2-high') plus the
// `thought_level` option ('max'). `devin acp --model swe-2-max` resolves to
// exactly that pair, while `session/set_config_option` accepts exact option
// values only — so the same split is reproduced here to verify new sessions
// and to apply overrides on resumed ones.
function resolveRequestedModel(
  configOptions: SessionConfigOption[],
  requested: string,
): ResolvedModelRequest | undefined {
  const option = configSelectOption(configOptions, MODEL_OPTION_ID);
  if (!option) {
    return undefined;
  }
  const levelOption = configSelectOption(configOptions, THOUGHT_LEVEL_OPTION_ID);
  const levelValues = levelOption ? selectOptionValues(levelOption).map((entry) => entry.value) : [];
  const levels = levelValues.length > 0 ? levelValues : FALLBACK_THOUGHT_LEVELS;
  const values = selectOptionValues(option);
  const normalized = normalizeModelName(requested);

  const direct = values.find(
    (entry) =>
      normalizeModelName(entry.value) === normalized
      || normalizeModelName(entry.name) === normalized,
  );
  if (direct) {
    return {
      modelValue: direct.value,
      thoughtLevel: thoughtLevelSuffix(normalizeModelName(direct.value), levels),
    };
  }

  const requestedLevel = thoughtLevelSuffix(normalized, levels);
  const stem = requestedLevel === undefined
    ? normalized
    : normalized.slice(0, -requestedLevel.length - 1);
  const byStem = values.find(
    (entry) =>
      modelValueStem(entry.value, levels) === stem
      || normalizeModelName(entry.name) === stem,
  );
  if (!byStem) {
    return undefined;
  }
  return {
    modelValue: byStem.value,
    thoughtLevel: requestedLevel ?? thoughtLevelSuffix(normalizeModelName(byStem.value), levels),
  };
}

// `devin acp --model <alias>` resolves fuzzy aliases (e.g. 'opus') to a
// catalog model, but silently falls back to the configured default for names
// it cannot resolve. This check accepts the former and rejects the latter:
// a requested name the CLI actually resolved still shows up in the resolved
// option value or its display name.
function modelSelectionReflects(option: SessionConfigOption, requested: string): boolean {
  const needle = normalizeModelName(requested);
  const current = selectCurrentValue(option) ?? '';
  const entry = selectOptionValues(option).find((value) => value.value === current);
  // Very short names are too loose for a substring check — fail them instead.
  return needle.length >= 3
    && [current, entry?.name ?? '']
      .some((candidate) => normalizeModelName(candidate).includes(needle));
}

function unavailableModelError(requested: string, option: SessionConfigOption): DevinExecError {
  const current = selectCurrentValue(option) ?? 'unknown';
  return createExecError(
    `Requested Devin model '${requested}' is not available for this session `
    + `(session model: '${current}'). Pass an exact model option value `
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
    return createExecError(`devin acp error ${error.code}: ${error.message}${data}`, { stderr });
  }
  if (error instanceof MessageTooLargeError) {
    return createExecError('devin acp message exceeded buffer limit', {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stderr,
    });
  }
  const execError = error as DevinExecError;
  if (execError instanceof Error && execError.stderr !== undefined) {
    return execError;
  }
  return createExecError(getErrorMessage(error), { stderr });
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

        // `--model` on the process only applies to session creation; on a
        // resumed session the override goes through set_config_option. On a
        // new session the resolved state is verified because `devin acp`
        // silently falls back to the configured default for names it cannot
        // resolve (unlike `devin -p`, which errors with "Unknown model").
        if (options.model) {
          const modelOption = configSelectOption(configOptions, MODEL_OPTION_ID);
          if (modelOption) {
            const resolution = resolveRequestedModel(configOptions, options.model);
            if (resolution === undefined) {
              if (options.sessionId || !modelSelectionReflects(modelOption, options.model)) {
                throw unavailableModelError(options.model, modelOption);
              }
            } else {
              // Set the model before the level: selecting a model resets the
              // thought level to that model's default tier.
              if (selectCurrentValue(modelOption) !== resolution.modelValue) {
                const updated = await ctx.request(methods.agent.session.setConfigOption, {
                  sessionId: activeSessionId,
                  configId: MODEL_OPTION_ID,
                  value: resolution.modelValue,
                });
                configOptions = updated.configOptions;
              }
              const levelOption = configSelectOption(configOptions, THOUGHT_LEVEL_OPTION_ID);
              if (
                resolution.thoughtLevel !== undefined
                && levelOption
                && selectCurrentValue(levelOption) !== resolution.thoughtLevel
              ) {
                const updated = await ctx.request(methods.agent.session.setConfigOption, {
                  sessionId: activeSessionId,
                  configId: THOUGHT_LEVEL_OPTION_ID,
                  value: resolution.thoughtLevel,
                });
                configOptions = updated.configOptions;
              }
              const appliedModel = selectCurrentValue(configSelectOption(configOptions, MODEL_OPTION_ID));
              const appliedLevel = selectCurrentValue(configSelectOption(configOptions, THOUGHT_LEVEL_OPTION_ID));
              const modelOk = appliedModel === resolution.modelValue;
              const levelOk = resolution.thoughtLevel === undefined
                || !levelOption
                || appliedLevel === resolution.thoughtLevel;
              if (!modelOk || !levelOk) {
                throw createExecError(
                  `Devin session did not apply requested model '${options.model}' `
                  + `(session model: '${appliedModel ?? 'unknown'}', thought level: '${appliedLevel ?? 'unknown'}')`,
                );
              }
            }
          }
        }

        const sessionModel = selectCurrentValue(configSelectOption(configOptions, MODEL_OPTION_ID));
        const sessionLevel = selectCurrentValue(configSelectOption(configOptions, THOUGHT_LEVEL_OPTION_ID));
        const model = sessionModel === undefined
          ? options.model ?? 'unknown'
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
    throw normalizeAcpError(error, proc);
  } finally {
    options.abortSignal?.removeEventListener('abort', onAbort);
    proc.terminate();
  }
}
