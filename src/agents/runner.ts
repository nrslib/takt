import {
  loadCustomAgents,
  loadAgentPrompt,
  loadGlobalConfig,
  loadPersonaPromptFromPath,
  loadProjectConfig,
} from '../infra/config/index.js';
import {
  resolveConfigValue,
  resolveProviderOptionsWithTrace,
} from '../infra/config/resolveConfigValue.js';
import {
  resolveEffectiveProviderOptions,
  resolvePersonaProviderOptions,
} from '../infra/config/providerOptions.js';
import {
  getProvider,
  type ProviderType,
  type ProviderAgent,
  type ProviderCallOptions,
} from '../infra/providers/index.js';
import {
  providerSupportsPermissionControls,
  providerSupportsStrictMcpConfig,
} from '../infra/providers/provider-capabilities.js';
import type { AgentResponse, CustomAgentConfig } from '../core/models/index.js';
import type { ProviderUsageSnapshot } from '../core/models/response.js';
import { USAGE_MISSING_REASONS } from '../core/logging/contracts.js';
import { resolveAgentProviderModel } from '../core/workflow/provider-resolution.js';
import { composeRecoveryInstruction } from '../core/workflow/progress-notes.js';
import { mergeGlobalPermissionProfiles, resolveStepPermissionMode } from '../core/workflow/permission-profile-resolution.js';
import { createLogger, getErrorMessage } from '../shared/utils/index.js';
import type { RunAgentOptions } from './types.js';
import { withToolActivityCall } from '../shared/tool-activity/stream.js';
import { buildWrappedSystemPrompt } from './runner-prompt.js';
import { extractPersonaName } from './persona-spec.js';
import {
  createMcpAdapter,
  type PreparedProviderMcp,
  type ProviderMcpContext,
} from '../infra/providers/mcp/index.js';
import { type ResolvedMcpServers } from '../infra/config/runtime-provider/mcp-assignment.js';
import { redactMcpServerForLog, buildMcpServerSetIdentity } from '../infra/config/runtime-provider/mcp-schema.js';
import { startProgressNotes } from '../infra/progress-notes/session.js';
import type { StreamEvent } from '../shared/types/provider.js';

export type { RunAgentOptions, StreamCallback } from './types.js';

const log = createLogger('runner');
const MAX_COMPACTION_RECOVERIES = 3;

function withCompactionUsage(response: AgentResponse, usages: readonly (ProviderUsageSnapshot | undefined)[]): AgentResponse {
  if (usages.length === 1) return response;
  const known = usages.filter((usage): usage is ProviderUsageSnapshot => usage !== undefined);
  if (known.length === 0) return response;
  const complete = known.length === usages.length && known.every((usage) =>
    !usage.usageMissing
    && Number.isFinite(usage.inputTokens)
    && Number.isFinite(usage.outputTokens)
    && Number.isFinite(usage.totalTokens));
  if (!complete) {
    const reason = known.find((usage) => usage.usageMissing)?.reason ?? USAGE_MISSING_REASONS.NOT_AVAILABLE;
    return { ...response, providerUsage: { usageMissing: true, reason } };
  }
  const sum = (field: 'inputTokens' | 'outputTokens' | 'totalTokens'): number =>
    known.reduce((total, usage) => total + (usage[field] ?? 0), 0);
  const sumOptional = (field: 'cachedInputTokens' | 'cacheCreationInputTokens' | 'cacheReadInputTokens'): number | undefined =>
    known.every((usage) => Number.isFinite(usage[field]))
      ? known.reduce((total, usage) => total + usage[field]!, 0)
      : undefined;
  const cachedInputTokens = sumOptional('cachedInputTokens');
  const cacheCreationInputTokens = sumOptional('cacheCreationInputTokens');
  const cacheReadInputTokens = sumOptional('cacheReadInputTokens');
  return {
    ...response,
    providerUsage: {
      usageMissing: false,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      totalTokens: sum('totalTokens'),
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
      ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    },
  };
}
type RunnerHandoffOptions = RunAgentOptions;
type AgentExecutionResolution = {
  readonly provider: ProviderType;
  readonly model: string | undefined;
  readonly providerOptions: ProviderCallOptions['providerOptions'];
  readonly permissionMode: RunAgentOptions['permissionMode'];
};

function hasExplicitPermissionConstraint(
  provider: ProviderType,
  resolution: NonNullable<RunAgentOptions['permissionResolution']>,
  localConfig: ReturnType<typeof loadProjectConfig>,
  globalConfig: ReturnType<typeof loadGlobalConfig>,
): boolean {
  if (resolution.requiredPermissionMode !== undefined) {
    return true;
  }
  return [
    resolution.providerProfiles?.[provider],
    localConfig.providerProfiles?.[provider],
    globalConfig.providerProfiles?.[provider],
  ].some((profile) => profile?.defaultPermissionMode !== undefined
    || profile?.stepPermissionOverrides?.[resolution.stepName] !== undefined);
}

export class AgentRunner {
  private static resolvePersonaProviders(cwd: string) {
    return resolveConfigValue(cwd, 'personaProviders');
  }

  private static resolveProviderAndModel(
    cwd: string,
    personaDisplayName: string | undefined,
    options?: RunAgentOptions,
  ): {
    provider: ProviderType;
    model: string | undefined;
    localConfig: ReturnType<typeof loadProjectConfig>;
    globalConfig: ReturnType<typeof loadGlobalConfig>;
    personaProviders: ReturnType<typeof AgentRunner.resolvePersonaProviders>;
  } {
    const localConfig = loadProjectConfig(cwd);
    const globalConfig = loadGlobalConfig();
    const personaProviders = AgentRunner.resolvePersonaProviders(cwd);
    if (options?.resolvedProvider) {
      return {
        provider: options.resolvedProvider,
        model: options.resolvedModel,
        localConfig,
        globalConfig,
        personaProviders,
      };
    }
    const resolved = resolveAgentProviderModel({
      cliProvider: options?.provider,
      cliModel: options?.model,
      personaProviders,
      personaDisplayName,
      localProvider: localConfig.provider,
      localModel: localConfig.model,
      globalProvider: globalConfig.provider,
      globalModel: globalConfig.model,
    });
    const resolvedProvider = resolved.provider;
    if (!resolvedProvider) {
      throw new Error('No provider configured. Set "provider" in ~/.takt/config.yaml');
    }
    return {
      provider: resolvedProvider,
      model: resolved.model,
      localConfig,
      globalConfig,
      personaProviders,
    };
  }

  /** Use pre-resolved handoff options when supplied; otherwise resolve config and persona precedence. */
  private static resolveProviderOptions(
    cwd: string,
    personaDisplayName: string | undefined,
    options: RunnerHandoffOptions,
    personaProviders: ReturnType<typeof AgentRunner.resolvePersonaProviders>,
    resolvedProvider: ProviderType,
  ): ProviderCallOptions['providerOptions'] {
    if (options.resolvedProviderOptions !== undefined) {
      return options.resolvedProviderOptions ?? undefined;
    }

    const personaProviderOptions = resolvePersonaProviderOptions(
      personaProviders,
      personaDisplayName,
    );
    const {
      value: resolvedConfigProviderOptions,
      source: providerOptionsSource,
      originResolver: providerOptionsOriginResolver,
    } = resolveProviderOptionsWithTrace(cwd);

    const resolvedProviderOptions = resolveEffectiveProviderOptions(
      providerOptionsSource,
      providerOptionsOriginResolver,
      resolvedConfigProviderOptions,
      options.providerOptions,
      personaProviderOptions,
      resolvedProvider,
    );
    return resolvedProviderOptions;
  }

  private static assertResolvedExecutionIsNotMixed(options: RunAgentOptions): void {
    const mixedFields = [
      options.provider,
      options.model,
      options.resolvedProvider,
      options.resolvedModel,
      options.providerOptions,
      options.resolvedProviderOptions,
      options.permissionResolution,
      options.permissionMode,
    ];
    if (mixedFields.some((value) => value !== undefined)) {
      throw new Error('resolvedExecution cannot be mixed with unresolved agent resolution inputs');
    }
  }

  private static resolveExecution(
    cwd: string,
    personaDisplayName: string | undefined,
    options: RunnerHandoffOptions,
  ): AgentExecutionResolution {
    if (options.resolvedExecution !== undefined) {
      AgentRunner.assertResolvedExecutionIsNotMixed(options);
      return {
        provider: options.resolvedExecution.provider,
        model: options.resolvedExecution.model,
        providerOptions: options.resolvedExecution.providerOptions,
        permissionMode: options.resolvedExecution.permissionMode,
      };
    }
    const resolved = AgentRunner.resolveProviderAndModel(cwd, personaDisplayName, options);
    return {
      provider: resolved.provider,
      model: resolved.model,
      providerOptions: AgentRunner.resolveProviderOptions(
        cwd,
        personaDisplayName,
        options,
        resolved.personaProviders,
        resolved.provider,
      ),
      permissionMode: AgentRunner.resolvePermissionMode(
        resolved.provider,
        options,
        resolved.localConfig,
        resolved.globalConfig,
      ),
    };
  }

  private static buildCallOptions(
    resolution: AgentExecutionResolution,
    options: RunAgentOptions,
    preparedMcp: PreparedProviderMcp | undefined,
  ): ProviderCallOptions {
    return {
      cwd: options.cwd,
      ...(resolution.provider !== 'opencode' || options.openCodeExternalDirectories === undefined
        ? {}
        : { openCodeExternalDirectories: options.openCodeExternalDirectories }),
      abortSignal: options.abortSignal,
      sessionId: options.sessionId,
      internalAgentIsolation: options.internalAgentIsolation,
      executionPhase: options.executionPhase,
      ...(options.workflowMeta?.context === undefined ? {} : {
        compactionAssignment: options.workflowMeta.context.assignment.stepName,
      }),
      allowedTools: options.allowedTools,
      mcpServers: options.mcpServers,
      ...(preparedMcp !== undefined ? { preparedMcp } : {}),
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      model: resolution.model,
      ...(options.allowDefaultModel === true ? { allowDefaultModel: true } : {}),
      permissionMode: resolution.permissionMode,
      edit: options.edit,
      providerOptions: resolution.providerOptions,
      onStream: withToolActivityCall(options.onStream),
      onActivity: options.onActivity,
      onPermissionRequest: options.onPermissionRequest,
      onSkillPermissionRequest: options.onSkillPermissionRequest,
      onAskUserQuestion: options.onAskUserQuestion,
      bypassPermissions: options.bypassPermissions,
      outputSchema: options.outputSchema,
      language: options.language,
      failureDir: options.failureDir,
      childProcessEnv: options.childProcessEnv,
    };
  }

  private static async callAgent(
    agent: ProviderAgent,
    task: string,
    options: ProviderCallOptions,
    recorder: RunAgentOptions['progressNotesRecorder'],
  ): Promise<AgentResponse> {
    const recoverFromCompaction = agent.recoverFromCompaction;
    if (options.executionPhase !== 1 || recoverFromCompaction === undefined || recorder === undefined) {
      const observedOptions = recorder === undefined ? options : {
        ...options,
        onStream: (event: Parameters<NonNullable<ProviderCallOptions['onStream']>>[0]) => {
          recorder.observe(event);
          options.onStream?.(event);
        },
      };
      const response = await agent.call(task, observedOptions);
      recorder?.finish(response);
      return response;
    }

    let recovering = false;
    let recoveryCount = 0;
    let currentOptions = options;
    const usages: (ProviderUsageSnapshot | undefined)[] = [];
    while (true) {
      let compactionDetected = false;
      let compactionSessionId: string | undefined;
      let resultEvent: StreamEvent | undefined;
      const callOptions = {
        ...currentOptions,
        onStream: (event: Parameters<NonNullable<ProviderCallOptions['onStream']>>[0]) => {
          recorder.observe(event);
          if (event.type === 'context_compacted') {
            compactionDetected = true;
            compactionSessionId = event.data.sessionId;
          }
          if (event.type === 'result') {
            resultEvent = event;
            return;
          }
          currentOptions.onStream?.(event);
        },
      };
      const instruction = recovering ? recorder.recoveryInstruction() : task;
      const response = recovering
        ? await recoverFromCompaction.call(agent, instruction, callOptions)
        : await agent.call(instruction, callOptions);
      recorder.finish(response);
      usages.push(response.providerUsage);
      const responseSessionId = response.sessionId ?? currentOptions.sessionId;
      const compactionMatchesResponse = compactionSessionId === undefined
        || compactionSessionId === responseSessionId;
      if (response.status !== 'done' || !compactionDetected || !compactionMatchesResponse) {
        if (resultEvent !== undefined) currentOptions.onStream?.(resultEvent);
        return withCompactionUsage(response, usages);
      }

      let needsRecovery: boolean = true;
      if (agent.assessCompactedResponse !== undefined && responseSessionId !== undefined) {
        let assessment: Awaited<ReturnType<NonNullable<ProviderAgent['assessCompactedResponse']>>>;
        try {
          assessment = await agent.assessCompactedResponse(instruction, response, callOptions);
        } catch (cause) {
          assessment = {
            decision: 'error',
            error: getErrorMessage(cause),
            failureCategory: currentOptions.abortSignal?.aborted ? 'external_abort' : 'provider_error',
          };
        }
        usages.push(assessment.usage);
        if (assessment.decision === 'error') {
          const error = assessment.error ?? 'Compaction completion assessment failed';
          const failureCategory = assessment.failureCategory ?? 'provider_error';
          currentOptions.onStream?.({
            type: 'result',
            data: { result: error, sessionId: responseSessionId ?? 'unknown', success: false, error, failureCategory },
          });
          return withCompactionUsage({ ...response, status: 'error', content: error, error, failureCategory }, usages);
        }
        needsRecovery = assessment.decision === 'needs_recovery';
      }
      if (!needsRecovery) {
        if (resultEvent !== undefined) currentOptions.onStream?.(resultEvent);
        return withCompactionUsage(response, usages);
      }
      if (recoveryCount === MAX_COMPACTION_RECOVERIES) {
        const error = 'Provider compaction recovery limit reached';
        currentOptions.onStream?.({
          type: 'result',
          data: {
            result: error,
            sessionId: responseSessionId ?? 'unknown',
            success: false,
            error,
            failureCategory: 'provider_error',
          },
        });
        return withCompactionUsage({ ...response, status: 'error', content: error, error, failureCategory: 'provider_error' }, usages);
      }
      recoveryCount += 1;
      currentOptions = { ...currentOptions, sessionId: responseSessionId };
      recovering = true;
    }
  }

  private static buildMcpPrepareContext(
    options: RunAgentOptions,
    permissionMode: RunAgentOptions['permissionMode'],
  ): ProviderMcpContext {
    return {
      cwd: options.cwd,
      ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      ...(options.projectCwd !== undefined ? { sourcePath: options.projectCwd } : {}),
      ...(options.childProcessEnv !== undefined ? { childProcessEnv: options.childProcessEnv } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
    };
  }

  /** The runner owns PreparedProviderMcp disposal; provider clients only consume it. */
  private static async disposePreparedMcp(
    preparedMcp: PreparedProviderMcp | undefined,
  ): Promise<void> {
    if (preparedMcp === undefined) {
      return;
    }
    try {
      await preparedMcp.dispose();
    } catch (error) {
      // Cleanup failures must not replace the provider result or original failure.
      log.debug('Failed to clean up prepared MCP configuration', {
        error: getErrorMessage(error),
      });
    }
  }

  private static resolvePermissionMode(
    resolvedProvider: ProviderType,
    options: RunAgentOptions,
    localConfig: ReturnType<typeof loadProjectConfig>,
    globalConfig: ReturnType<typeof loadGlobalConfig>,
  ): RunAgentOptions['permissionMode'] {
    if (options.permissionResolution !== undefined && options.permissionMode !== undefined) {
      throw new Error('permissionMode cannot be combined with permissionResolution');
    }
    if (options.permissionResolution) {
      const permissionMode = resolveStepPermissionMode({
        stepName: options.permissionResolution.stepName,
        requiredPermissionMode: options.permissionResolution.requiredPermissionMode,
        provider: resolvedProvider,
        projectProviderProfiles: options.permissionResolution.providerProfiles
          ?? localConfig.providerProfiles,
        globalProviderProfiles: mergeGlobalPermissionProfiles(globalConfig.providerProfiles),
      });
      if (
        permissionMode !== undefined
        && !hasExplicitPermissionConstraint(
          resolvedProvider,
          options.permissionResolution,
          localConfig,
          globalConfig,
        )
        && providerSupportsPermissionControls(resolvedProvider) === false
      ) {
        return undefined;
      }
      return permissionMode;
    }
    return options.permissionMode;
  }

  async runCustom(
    agentConfig: CustomAgentConfig,
    task: string,
    options: RunAgentOptions,
  ): Promise<AgentResponse> {
    const customOptions: RunnerHandoffOptions = {
      ...options,
      allowedTools: options.allowedTools ?? agentConfig.allowedTools,
    };
    const resolution = AgentRunner.resolveExecution(
      options.cwd,
      agentConfig.name,
      customOptions,
    );
    const provider = getProvider(resolution.provider);
    const resolvedSystemPrompt = loadAgentPrompt(agentConfig, options.cwd);
    const preparedMcp = await AgentRunner.prepareMcpAdapter(resolution.provider, customOptions, resolution.permissionMode);
    try {
      const callOptions = AgentRunner.buildCallOptions(resolution, customOptions, preparedMcp);
      const providerRuntimeInstructions = provider.getRuntimeInstructions(customOptions.allowedTools, callOptions.permissionMode, callOptions.providerOptions?.opencode?.networkAccess, callOptions);
      const systemPrompt = buildWrappedSystemPrompt(resolvedSystemPrompt, {
        ...customOptions,
        providerRuntimeInstructions,
      });

      options.onPromptResolved?.({
        systemPrompt,
        userInstruction: task,
      });

      const agent = provider.setup({
        name: agentConfig.name,
        systemPrompt,
      });

      options.onDispatch?.(resolution.permissionMode);
      return await AgentRunner.callAgent(agent, task, callOptions, options.progressNotesRecorder);
    } finally {
      await AgentRunner.disposePreparedMcp(preparedMcp);
    }
  }

  async run(
    personaSpec: string | undefined,
    task: string,
    options: RunAgentOptions,
  ): Promise<AgentResponse> {
    const personaName = personaSpec ? extractPersonaName(personaSpec) : 'default';
    log.debug('Running agent', {
      personaSpec: personaSpec ?? '(none)',
      personaName,
      provider: options.provider,
      model: options.model,
      resolvedProvider: options.resolvedProvider,
      resolvedModel: options.resolvedModel,
      hasPersonaPath: !!options.personaPath,
      hasSession: !!options.sessionId,
      permissionMode: options.permissionMode,
    });

    const resolution = AgentRunner.resolveExecution(options.cwd, personaName, options);
    const provider = getProvider(resolution.provider);
    let preparedMcp = await AgentRunner.prepareMcpAdapter(resolution.provider, options, resolution.permissionMode);
    try {
      const callOptions = AgentRunner.buildCallOptions(resolution, options, preparedMcp);
      const setupAgent = (agentSetup: { name: string; systemPrompt?: string }) => {
        if (options.executionProfile !== 'isolated-structured') {
          return provider.setup(agentSetup);
        }
        const isolatedAgent = provider.setupIsolatedStructured?.(agentSetup);
        if (isolatedAgent === undefined) {
          throw new Error(`Provider "${resolution.provider}" does not support isolated structured execution`);
        }
        return isolatedAgent;
      };

      if (options.internalSystemPrompt !== undefined) {
        const personaDefinition = options.personaPath === undefined
          ? personaSpec
          : loadPersonaPromptFromPath(
            options.personaPath,
            options.projectCwd ?? options.cwd,
            options.workflowBundleResourceRoot,
          );
        const internalAgentDefinition = personaDefinition === undefined
          ? options.internalSystemPrompt
          : `${personaDefinition}\n\n${options.internalSystemPrompt}`;
        const systemPrompt = buildWrappedSystemPrompt(internalAgentDefinition, {
          ...options,
          providerRuntimeInstructions: provider.getRuntimeInstructions(options.allowedTools, callOptions.permissionMode, callOptions.providerOptions?.opencode?.networkAccess, callOptions),
        });
        options.onPromptResolved?.({
          systemPrompt,
          userInstruction: task,
        });
        const agent = setupAgent({ name: options.internalAgentName ?? 'takt-internal', systemPrompt });
        options.onDispatch?.(resolution.permissionMode);
        return await AgentRunner.callAgent(agent, task, callOptions, options.progressNotesRecorder);
      }

      if (options.personaPath) {
        const agentDefinition = loadPersonaPromptFromPath(
          options.personaPath,
          options.projectCwd ?? options.cwd,
          options.workflowBundleResourceRoot,
        );
        const systemPrompt = buildWrappedSystemPrompt(agentDefinition, {
          ...options,
          providerRuntimeInstructions: provider.getRuntimeInstructions(options.allowedTools, callOptions.permissionMode, callOptions.providerOptions?.opencode?.networkAccess, callOptions),
        });
        options.onPromptResolved?.({
          systemPrompt,
          userInstruction: task,
        });
        const agent = setupAgent({ name: personaName, systemPrompt });
        options.onDispatch?.(resolution.permissionMode);
        return await AgentRunner.callAgent(agent, task, callOptions, options.progressNotesRecorder);
      }

      if (personaSpec) {
        const customAgents = loadCustomAgents();
        const agentConfig = customAgents.get(personaName);
        if (agentConfig) {
          const preparedForCurrentRun = preparedMcp;
          preparedMcp = undefined;
          await AgentRunner.disposePreparedMcp(preparedForCurrentRun);
          return await this.runCustom(agentConfig, task, options);
        }

        const systemPrompt = buildWrappedSystemPrompt(personaSpec, {
          ...options,
          providerRuntimeInstructions: provider.getRuntimeInstructions(options.allowedTools, callOptions.permissionMode, callOptions.providerOptions?.opencode?.networkAccess, callOptions),
        });

        options.onPromptResolved?.({
          systemPrompt,
          userInstruction: task,
        });
        const agent = setupAgent({ name: personaName, systemPrompt });
        options.onDispatch?.(resolution.permissionMode);
        return await AgentRunner.callAgent(agent, task, callOptions, options.progressNotesRecorder);
      }

      const systemPrompt = buildWrappedSystemPrompt('', {
        ...options,
        providerRuntimeInstructions: provider.getRuntimeInstructions(options.allowedTools, callOptions.permissionMode, callOptions.providerOptions?.opencode?.networkAccess, callOptions),
      });
      options.onPromptResolved?.({
        systemPrompt,
        userInstruction: task,
      });
      const agent = setupAgent({ name: personaName, systemPrompt });
      options.onDispatch?.(resolution.permissionMode);
      return await AgentRunner.callAgent(agent, task, callOptions, options.progressNotesRecorder);
    } finally {
      await AgentRunner.disposePreparedMcp(preparedMcp);
    }
  }

  /**
   * Prepare the provider MCP adapter when the resolved MCP server set is
   * non-empty, or when runtime MCP mode is active with an empty set for
   * Claude系 providers so `strictMcpConfig`/`--strict-mcp-config` suppresses
   * ambient MCP config (order.md:152,160,166,172). Runs `validate`
   * (fail-fast on unsupported transports) then `prepare` (materialize
   * provider-specific config / temp files). Returns `undefined` when MCP is
   * disabled (legacy mode empty server set) so the runner skips adapter work
   * and cleanup (order.md:152,153).
   */
  private static async prepareMcpAdapter(
    provider: ProviderType,
    options: RunAgentOptions,
    permissionMode: RunAgentOptions['permissionMode'],
  ): Promise<PreparedProviderMcp | undefined> {
    const mcpServers = options.mcpServers;
    const isEmpty = mcpServers === undefined || Object.keys(mcpServers).length === 0;
    const runtimeMcpMode = options.mcpAssignment !== undefined;
    if (isEmpty) {
      // Legacy mode (no runtime MCP assignment) with an empty set: MCP is
      // disabled, skip adapter preparation (order.md:152).
      if (!runtimeMcpMode) {
        return undefined;
      }
      // Runtime MCP mode active with an empty set: providers declaring the
      // strict-MCP capability suppress ambient project/user/plugin MCP config
      // (order.md:160,166,172). Other providers have no such contract, so an
      // empty set remains a no-op for them.
      if (providerSupportsStrictMcpConfig(provider) !== true) {
        return undefined;
      }
      const adapter = createMcpAdapter(provider);
      const identity = options.mcpServerIdentity ?? buildMcpServerSetIdentity(mcpServers ?? {});
      const resolved: ResolvedMcpServers = {
        enabled: false,
        servers: {},
        serverNames: [],
        identity,
      };
      const prepared = await adapter.prepare(resolved, {
        ...AgentRunner.buildMcpPrepareContext(options, permissionMode),
      });
      log.debug('Prepared MCP adapter (empty set, runtime mode)', {
        provider,
        hasArgs: prepared.args !== undefined,
        hasSdkOptions: prepared.sdkOptions !== undefined,
      });
      return prepared;
    }
    const adapter = createMcpAdapter(provider);
    const identity = options.mcpServerIdentity ?? buildMcpServerSetIdentity(mcpServers);
    const resolved: ResolvedMcpServers = {
      enabled: true,
      servers: mcpServers,
      serverNames: Object.keys(mcpServers).sort(),
      identity,
    };
    adapter.validate(resolved, { sourcePath: options.projectCwd });
    const prepared = await adapter.prepare(
      resolved,
      AgentRunner.buildMcpPrepareContext(options, permissionMode),
    );
    // Log the resolved MCP server configuration through the secret-redaction
    // helper so env/header secret values are never written to logs
    // (order.md:110, ARCH-NEW-6). Only server names and transports are
    // surfaced by the adapter summary fields above; this record adds the
    // redacted server definitions for debugging.
    const redactedServers = Object.fromEntries(
      Object.entries(mcpServers).map(([name, server]) => [name, redactMcpServerForLog(server)]),
    );
    log.debug('Prepared MCP adapter', {
      provider,
      serverNames: resolved.serverNames,
      servers: redactedServers,
      hasArgs: prepared.args !== undefined,
      hasSdkOptions: prepared.sdkOptions !== undefined,
      hasConfig: prepared.config !== undefined,
      hasServerConfig: prepared.serverConfig !== undefined,
      hasConfigRoot: prepared.configRoot !== undefined,
    });
    return prepared;
  }

}

const defaultRunner = new AgentRunner();

export async function runAgent(
  personaSpec: string | undefined,
  task: string,
  options: RunAgentOptions,
): Promise<AgentResponse> {
  // Provider dispatch is an attempt boundary even when the provider emits no stream events.
  options.onActivity?.();
  if (options.executionPhase !== 1 || options.progressNotes === undefined) {
    return defaultRunner.run(personaSpec, task, options);
  }
  const originalInstruction = options.progressNotesInstruction ?? task;
  const recoveryInstruction = options.progressNotesRecoveryInstruction
    ?? composeRecoveryInstruction(originalInstruction, task);
  const requestInstruction = options.sessionId === undefined ? recoveryInstruction : task;
  // Storage availability must not change the step's compaction recovery eligibility: without notes,
  // recovery resends the original instruction and the agent checks the current state.
  // The same language as the system prompt's progress notes guidance (buildWrappedSystemPrompt).
  const notes = await startProgressNotes(options.cwd, options.progressNotes, originalInstruction, options.language ?? 'en');
  try {
    return await defaultRunner.run(personaSpec, notes.instruction(requestInstruction), {
      ...options,
      progressNotesRecorder: {
        observe: notes.observe,
        finish: notes.finish,
        recoveryInstruction: () => notes.instruction(recoveryInstruction),
      },
    });
  } finally {
    notes.flush();
  }
}
