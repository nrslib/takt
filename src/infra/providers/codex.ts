/**
 * Codex provider implementation
 */

import {
  callCodex,
  callCodexCustom,
  type CodexCallOptions,
} from '../codex/index.js';
import { emitResult } from '../codex/CodexStreamHandler.js';
import { resolveOpenaiApiKey, resolveCodexCliPath } from '../config/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import { assertCodexConfigProfilePermissionControl } from '../../core/models/workflow-provider-options.js';
import { buildCodexSessionConfig } from '../codex/session-config.js';
import { readCodexModelContextWindow } from '../codex/model-context-window.js';
import { prepareCodexMcpIsolation } from '../codex/mcp-isolation.js';
import { createCodexMcpAdapter } from './mcp/codex.js';
import { buildMcpServerSetIdentity } from '../config/runtime-provider/mcp-schema.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { prepareCodexCallPacket } from '../codex/call-packet.js';
import { UnsafePrivateArtifactPathError } from '../../shared/utils/private-path-identity.js';
import {
  assertOutputSchema,
  type AgentSetup,
  type Provider,
  type ProviderAgent,
  type ProviderCallOptions,
} from './types.js';

function toCodexOptions(options: ProviderCallOptions): CodexCallOptions {
  const providerCodexOptions = options.providerOptions?.codex;
  assertCodexConfigProfilePermissionControl(providerCodexOptions);
  return {
    cwd: options.cwd,
    callerManagedSession: options.callerManagedSession,
    executionPhase: options.executionPhase,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    contextWindow: options.contextWindow,
    reasoningEffort: options.effort ?? providerCodexOptions?.reasoningEffort,
    fastMode: providerCodexOptions?.fastMode,
    permissionMode: options.permissionMode,
    aiReviewPermissions: options.aiReviewPermissions,
    edit: options.edit,
    permissionControl: providerCodexOptions?.permissionControl,
    configProfile: providerCodexOptions?.configProfile,
    networkAccess: providerCodexOptions?.networkAccess,
    onStream: options.onStream,
    onActivity: options.onActivity,
    openaiApiKey: options.openaiApiKey ?? resolveOpenaiApiKey(),
    baseUrl: providerCodexOptions?.baseUrl,
    skills: options.internalAgentIsolation === 'strict-readonly'
      ? { repo: false, user: false }
      : {
          repo: providerCodexOptions?.skills?.repo ?? false,
          user: providerCodexOptions?.skills?.user ?? false,
        },
    codexPathOverride: resolveCodexCliPath(),
    outputSchema: options.outputSchema,
    imageAttachments: options.imageAttachments,
    failureDir: options.failureDir,
    childProcessEnv: options.childProcessEnv,
    preparedMcp: options.preparedMcp,
    mcpOnlySideEffects: options.mcpOnlySideEffects !== undefined,
    internalAgentIsolation: options.internalAgentIsolation,
  };
}

/** Codex provider — delegates to OpenAI Codex SDK */
export class CodexProvider implements Provider {
  readonly supportsMcpOnlySideEffects = true;
  readonly supportsStructuredOutput = true;
  readonly supportsIsolatedStructuredExecution = true;
  readonly supportsNativeImageInput = true;
  readonly supportedMcpTransports: ReadonlySet<'stdio' | 'sse' | 'http'> = new Set(['stdio', 'http']);

  getContextWindowLimits(options: ProviderCallOptions) {
    return readCodexModelContextWindow(
      options.model, options.childProcessEnv, options.cwd, options.providerOptions?.codex?.configProfile,
    );
  }

  getRuntimeInstructions(_allowedTools?: string[]): string | null {
    return null;
  }

  keepsAllowedToolWithoutEdit(_tool: string): boolean {
    return true;
  }

  async preflight(options: ProviderCallOptions): Promise<void> {
    if (options.mcpOnlySideEffects === undefined) return;
    const servers = options.mcpServers ?? {};
    const resolved = {
      enabled: true, servers, serverNames: Object.keys(servers).sort(),
      identity: buildMcpServerSetIdentity(servers),
    };
    const adapter = createCodexMcpAdapter();
    adapter.validate(resolved);
    const prepared = await adapter.prepare(resolved, options);
    try {
      const codexOptions = toCodexOptions({ ...options, preparedMcp: prepared });
      const { config, env } = buildCodexSessionConfig(codexOptions);
      await prepareCodexMcpIsolation(codexOptions, config, env);
    } finally {
      await prepared.dispose();
    }
  }

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    const call = async (
      prompt: string,
      options: ProviderCallOptions,
    ): Promise<AgentResponse> => {
      const codexOptions = toCodexOptions(options);
      let packet: ReturnType<typeof prepareCodexCallPacket>;
      try {
        packet = prepareCodexCallPacket(systemPrompt, prompt, options);
      } catch (error) {
        if (!(error instanceof UnsafePrivateArtifactPathError)) throw error;
        emitResult(options.onStream, false, error.message, options.sessionId, 'provider_error');
        return {
          persona: name,
          status: 'error',
          content: error.message,
          error: error.message,
          failureCategory: 'provider_error',
          timestamp: new Date(),
        };
      }
      const { input, developerInstructions } = packet;
      return callCodexCustom(name, input, developerInstructions, codexOptions);
    };
    const recoverFromCompaction: NonNullable<ProviderAgent['recoverFromCompaction']> = async (
      prompt,
      options,
    ) => {
      if (options.sessionId === undefined) {
        const error = 'Codex cannot recover from compaction without a session ID';
        emitResult(options.onStream, false, error, undefined, 'provider_error');
        return {
          persona: name,
          status: 'error',
          content: error,
          error,
          failureCategory: 'provider_error',
          timestamp: new Date(),
        };
      }
      return call(loadTemplate('codex_compaction_recovery', options.language ?? 'en', {
        instruction: prompt,
        assignment: options.compactionAssignment ?? name,
        permissionMode: options.permissionMode ?? 'unspecified',
        edit: options.edit === undefined ? 'unspecified' : String(options.edit),
      }), options);
    };
    const assessCompactedResponse: NonNullable<ProviderAgent['assessCompactedResponse']> = async (
      instruction,
      response,
      options,
    ) => {
      const assessor = this.setupIsolatedStructured({
        name: 'compaction-completion-assessor',
        systemPrompt: loadTemplate('codex_compaction_assessment', options.language ?? 'en'),
      });
      const assessment = await assessor.call(JSON.stringify({
        currentAssignment: options.compactionAssignment ?? name,
        currentInstructions: systemPrompt ?? null,
        currentRequest: instruction,
        permissionMode: options.permissionMode ?? null,
        edit: options.edit ?? null,
        candidateResponse: response.content,
      }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026'), {
        ...options,
        callerManagedSession: true,
        onStream: () => options.onActivity?.(),
        onActivity: options.onActivity,
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['decision'],
          properties: { decision: { type: 'string', enum: ['complete', 'needs_recovery'] } },
        },
      });
      if (assessment.status !== 'done') {
        return {
          decision: 'error',
          error: assessment.error ?? 'Compaction completion assessment failed',
          failureCategory: assessment.failureCategory ?? 'provider_error',
          usage: assessment.providerUsage,
        };
      }
      const decision = assessment.structuredOutput?.decision;
      if (decision !== 'complete' && decision !== 'needs_recovery') {
        return { decision: 'error', error: 'Compaction completion assessment returned an invalid decision', usage: assessment.providerUsage };
      }
      return { decision, usage: assessment.providerUsage };
    };
    return { call, recoverFromCompaction, assessCompactedResponse };
  }

  setupIsolatedStructured(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    const call = async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
      // Isolated structured execution is intentionally strict-readonly and
      // disables MCP. Clear MCP inputs and policy so a prepared runtime MCP
      // configuration is never silently inherited by this provider path.
      const isolatedOptions: ProviderCallOptions = {
        ...options,
        sessionId: undefined,
        internalAgentIsolation: 'strict-readonly',
        permissionMode: 'readonly',
        allowedTools: [],
        mcpServers: undefined,
        preparedMcp: undefined,
        mcpOnlySideEffects: undefined,
        imageAttachments: undefined,
        outputSchema: assertOutputSchema(options.outputSchema, 'codex'),
      };
      const codexOptions = toCodexOptions(isolatedOptions);
      return systemPrompt
        ? callCodexCustom(name, prompt, `${systemPrompt}\n\n`, codexOptions)
        : callCodex(name, prompt, codexOptions);
    };
    return { call };
  }
}
