/**
 * SDK options builder for Claude queries
 *
 * Builds the options object for Claude Agent SDK queries,
 * including permission handlers and hooks.
 */

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
import type { PermissionMode } from '../../core/models/index.js';
import { createLogger } from '../../shared/utils/index.js';
import type {
  PermissionHandler,
  AskUserQuestionInput,
  AskUserQuestionHandler,
  ClaudeSpawnOptions,
} from './types.js';

const log = createLogger('claude-sdk');

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

  /** Build the full SDK Options object */
  build(): Options {
    const canUseTool = this.options.onPermissionRequest
      ? SdkOptionsBuilder.createCanUseToolCallback(this.options.onPermissionRequest)
      : undefined;

    const hooks = this.options.onAskUserQuestion
      ? SdkOptionsBuilder.createAskUserQuestionHooks(this.options.onAskUserQuestion)
      : undefined;

    const permissionMode = this.resolvePermissionMode();

    // Only include defined values — the SDK treats key-present-but-undefined
    // differently from key-absent for some options (e.g. model), causing hangs.
    const sdkOptions: Options = {
      cwd: this.options.cwd,
      permissionMode,
    };

    if (this.options.model) sdkOptions.model = this.options.model;
    if (this.options.maxTurns != null) sdkOptions.maxTurns = this.options.maxTurns;
    if (this.options.allowedTools) sdkOptions.allowedTools = this.options.allowedTools;
    if (this.options.agents) sdkOptions.agents = this.options.agents;
    if (this.options.mcpServers) sdkOptions.mcpServers = this.options.mcpServers;
    if (this.options.systemPrompt) sdkOptions.systemPrompt = this.options.systemPrompt;
    if (this.options.outputSchema) {
      (sdkOptions as Record<string, unknown>).outputFormat = {
        type: 'json_schema',
        schema: this.options.outputSchema,
      };
    }
    if (canUseTool) sdkOptions.canUseTool = canUseTool;
    if (hooks) sdkOptions.hooks = hooks;

    if (this.options.anthropicApiKey) {
      sdkOptions.env = {
        ...process.env as Record<string, string>,
        ANTHROPIC_API_KEY: this.options.anthropicApiKey,
      };
    }

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

    return sdkOptions;
  }

  /** Map TAKT PermissionMode to Claude SDK PermissionMode */
  static mapToSdkPermissionMode(mode: PermissionMode): SdkPermissionMode {
    const mapping: Record<PermissionMode, SdkPermissionMode> = {
      readonly: 'default',
      edit: 'acceptEdits',
      full: 'bypassPermissions',
    };
    return mapping[mode];
  }

  /** Resolve permission mode with priority: bypassPermissions > explicit > callback-based > default */
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

  /**
   * Create canUseTool callback from permission handler.
   */
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

  /**
   * Create hooks for AskUserQuestion handling.
   */
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
          log.error('AskUserQuestion handler failed', { error: err });
          return { continue: true };
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

// ---- Module-level functions ----

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
