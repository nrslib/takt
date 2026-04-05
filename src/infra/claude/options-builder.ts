import type {
  Options,
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
  PermissionMode as SdkPermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import { delimiter, dirname } from 'node:path';
import type { PermissionMode } from '../../core/models/index.js';
import { createLogger } from '../../shared/utils/index.js';
import { taktPermissionModeToClaudeExpression } from './permission-mode-expression.js';
import type {
  PermissionHandler,
  AskUserQuestionInput,
  AskUserQuestionHandler,
  ClaudeSpawnOptions,
} from './types.js';
import { AskUserQuestionDeniedError, createAskUserQuestionHandler } from './ask-user-question-handler.js';

const log = createLogger('claude-sdk');

function buildSdkEnv(options: ClaudeSpawnOptions): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
  };

  if (options.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = options.anthropicApiKey;
  }

  const existingPathEntries = (env.PATH ?? '')
    .split(delimiter)
    .filter((entry): entry is string => entry.length > 0);
  const prependedEntries = [
    process.execPath ? dirname(process.execPath) : undefined,
  ].filter((entry): entry is string => Boolean(entry));

  const mergedPathEntries = [...new Set([...prependedEntries, ...existingPathEntries])];
  if (mergedPathEntries.length > 0) {
    env.PATH = mergedPathEntries.join(delimiter);
  }

  return env;
}

/**
 * Builds SDK options from ClaudeSpawnOptions.
 *
 * Handles permission mode resolution, canUseTool callback creation,
 * and AskUserQuestion hook setup.
 */
export class SdkOptionsBuilder {
  private readonly options: ClaudeSpawnOptions;

  constructor(options: ClaudeSpawnOptions) {
    this.options = options;
  }

  build(): Options {
    const canUseTool = this.options.onPermissionRequest
      ? SdkOptionsBuilder.createCanUseToolCallback(this.options.onPermissionRequest)
      : undefined;

    const askHandler = this.options.onAskUserQuestion ?? createAskUserQuestionHandler();
    const hooks = SdkOptionsBuilder.createAskUserQuestionHooks(askHandler);

    const permissionMode = this.resolvePermissionMode();

    // Only include defined values — the SDK treats key-present-but-undefined
    // differently from key-absent for some options (e.g. model), causing hangs.
    const sdkOptions: Options = {
      cwd: this.options.cwd,
      permissionMode,
      settingSources: ['project'],
    };

    if (this.options.model) sdkOptions.model = this.options.model;
    if (this.options.effort) sdkOptions.effort = this.options.effort;
    if (this.options.maxTurns != null) sdkOptions.maxTurns = this.options.maxTurns;
    if (this.options.allowedTools) sdkOptions.allowedTools = this.options.allowedTools;
    if (this.options.agents) sdkOptions.agents = this.options.agents;
    if (this.options.mcpServers) sdkOptions.mcpServers = this.options.mcpServers;
    if (this.options.systemPrompt) sdkOptions.systemPrompt = this.options.systemPrompt;
    if (this.options.outputSchema) {
      sdkOptions.outputFormat = {
        type: 'json_schema',
        schema: this.options.outputSchema,
      };
    }
    if (canUseTool) sdkOptions.canUseTool = canUseTool;
    sdkOptions.hooks = hooks;

    sdkOptions.env = buildSdkEnv(this.options);

    // Always enable — QueryExecutor uses the async iterator (`for await`)
    // which only yields when this flag is true.
    sdkOptions.includePartialMessages = true;

    if (this.options.sessionId) {
      sdkOptions.resume = this.options.sessionId;
    } else {
      sdkOptions.continue = false;
    }

    if (this.options.onStderr) {
      sdkOptions.stderr = this.options.onStderr;
    }

    if (this.options.sandbox) {
      sdkOptions.sandbox = this.options.sandbox;
    }

    if (this.options.pathToClaudeCodeExecutable) {
      sdkOptions.pathToClaudeCodeExecutable = this.options.pathToClaudeCodeExecutable;
    }

    return sdkOptions;
  }

  static mapToSdkPermissionMode(mode: PermissionMode): SdkPermissionMode {
    return taktPermissionModeToClaudeExpression(mode) as SdkPermissionMode;
  }

  private resolvePermissionMode(): SdkPermissionMode {
    if (this.options.bypassPermissions) {
      return 'bypassPermissions';
    }
    if (this.options.permissionMode) {
      return SdkOptionsBuilder.mapToSdkPermissionMode(this.options.permissionMode);
    }
    if (this.options.onPermissionRequest) {
      return 'default';
    }
    return 'acceptEdits';
  }

  static createCanUseToolCallback(
    handler: PermissionHandler
  ): CanUseTool {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      callbackOptions: {
        signal: AbortSignal;
        suggestions?: PermissionUpdate[];
        blockedPath?: string;
        decisionReason?: string;
      }
    ): Promise<PermissionResult> => {
      return handler({
        toolName,
        input,
        suggestions: callbackOptions.suggestions,
        blockedPath: callbackOptions.blockedPath,
        decisionReason: callbackOptions.decisionReason,
      });
    };
  }

  static createAskUserQuestionHooks(
    askUserHandler: AskUserQuestionHandler
  ): Partial<Record<string, HookCallbackMatcher[]>> {
    const preToolUseHook = async (
      input: HookInput,
      _toolUseID: string | undefined,
      _options: { signal: AbortSignal }
    ): Promise<HookJSONOutput> => {
      const preToolInput = input as PreToolUseHookInput;
      if (preToolInput.tool_name === 'AskUserQuestion') {
        const toolInput = preToolInput.tool_input as AskUserQuestionInput;
        try {
          const answers = await askUserHandler(toolInput);
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: JSON.stringify(answers),
            },
          };
        } catch (err) {
          if (err instanceof AskUserQuestionDeniedError) {
            return { continue: true, decision: 'block', reason: err.message };
          }
          log.error('AskUserQuestion handler failed', { error: err });
          return { continue: true, decision: 'block', reason: 'Internal error in AskUserQuestion handler' };
        }
      }
      return { continue: true };
    };

    return {
      PreToolUse: [{
        matcher: 'AskUserQuestion',
        hooks: [preToolUseHook],
      }],
    };
  }
}

export function createCanUseToolCallback(
  handler: PermissionHandler
): CanUseTool {
  return SdkOptionsBuilder.createCanUseToolCallback(handler);
}

export function createAskUserQuestionHooks(
  askUserHandler: AskUserQuestionHandler
): Partial<Record<string, HookCallbackMatcher[]>> {
  return SdkOptionsBuilder.createAskUserQuestionHooks(askUserHandler);
}

export function buildSdkOptions(options: ClaudeSpawnOptions): Options {
  return new SdkOptionsBuilder(options).build();
}
