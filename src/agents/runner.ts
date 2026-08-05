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
import { getProvider, type ProviderType, type ProviderCallOptions, type ProviderAgent, type AgentSetup } from '../infra/providers/index.js';
import type { AgentResponse, CustomAgentConfig } from '../core/models/index.js';
import { resolveAgentProviderModel } from '../core/workflow/provider-resolution.js';
import { mergeGlobalPermissionProfiles, resolveStepPermissionMode } from '../core/workflow/permission-profile-resolution.js';
import { createLogger } from '../shared/utils/index.js';
import type { RunAgentOptions } from './types.js';
import { buildWrappedSystemPrompt } from './runner-prompt.js';
import { extractPersonaName } from './persona-spec.js';

export type { RunAgentOptions, StreamCallback } from './types.js';

const log = createLogger('runner');
type RunnerHandoffOptions = RunAgentOptions;
type AgentExecutionResolution = {
  readonly provider: ProviderType;
  readonly model: string | undefined;
  readonly providerOptions: ProviderCallOptions['providerOptions'];
  readonly permissionMode: RunAgentOptions['permissionMode'];
};

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

  private static resolveProviderOptions(
    cwd: string,
    personaDisplayName: string | undefined,
    options: RunnerHandoffOptions,
    personaProviders: ReturnType<typeof AgentRunner.resolvePersonaProviders>,
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

    return resolveEffectiveProviderOptions(
      providerOptionsSource,
      providerOptionsOriginResolver,
      resolvedConfigProviderOptions,
      options.providerOptions,
      personaProviderOptions,
    );
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
  ): ProviderCallOptions {
    return {
      cwd: options.cwd,
      abortSignal: options.abortSignal,
      sessionId: options.sessionId,
      internalAgentIsolation: options.internalAgentIsolation,
      allowedTools: options.allowedTools,
      mcpServers: options.mcpServers,
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      model: resolution.model,
      permissionMode: resolution.permissionMode,
      providerOptions: resolution.providerOptions,
      onStream: options.onStream,
      onPermissionRequest: options.onPermissionRequest,
      onAskUserQuestion: options.onAskUserQuestion,
      bypassPermissions: options.bypassPermissions,
      outputSchema: options.outputSchema,
      language: options.language,
      childProcessEnv: options.childProcessEnv,
    };
  }

  private static resolvePermissionMode(
    resolvedProvider: ProviderType,
    options: RunAgentOptions,
    localConfig: ReturnType<typeof loadProjectConfig>,
    globalConfig: ReturnType<typeof loadGlobalConfig>,
  ): RunAgentOptions['permissionMode'] {
    if (options.permissionResolution) {
      return resolveStepPermissionMode({
        stepName: options.permissionResolution.stepName,
        requiredPermissionMode: options.permissionResolution.requiredPermissionMode,
        provider: resolvedProvider,
        projectProviderProfiles: options.permissionResolution.providerProfiles
          ?? localConfig.providerProfiles,
        globalProviderProfiles: mergeGlobalPermissionProfiles(globalConfig.providerProfiles),
      });
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
    const callOptions = AgentRunner.buildCallOptions(resolution, customOptions);
    const providerRuntimeInstructions = provider.getRuntimeInstructions(customOptions.allowedTools, callOptions.permissionMode, callOptions.providerOptions?.opencode?.networkAccess);
    const systemPrompt = buildWrappedSystemPrompt(resolvedSystemPrompt, {
      ...customOptions,
      providerRuntimeInstructions,
    });

    options.onPromptResolved?.({
      systemPrompt,
      userInstruction: task,
    });

    const agent = options.executionProfile === 'isolated-structured'
      ? provider.setupIsolatedStructured({
          name: agentConfig.name,
          systemPrompt,
        })
      : provider.setup({
          name: agentConfig.name,
          systemPrompt,
        });

    options.onDispatch?.(resolution.permissionMode);
    return agent.call(task, callOptions);
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
    const callOptions = AgentRunner.buildCallOptions(resolution, options);
    const useIsolatedStructured = options.executionProfile === 'isolated-structured';
    const setupAgent = (agentSetup: AgentSetup): ProviderAgent =>
      useIsolatedStructured
        ? provider.setupIsolatedStructured(agentSetup)
        : provider.setup(agentSetup);

    if (options.internalSystemPrompt !== undefined) {
      const systemPrompt = buildWrappedSystemPrompt(options.internalSystemPrompt, {
        ...options,
        providerRuntimeInstructions: provider.getRuntimeInstructions(options.allowedTools, callOptions.permissionMode, callOptions.providerOptions?.opencode?.networkAccess),
      });
      options.onPromptResolved?.({
        systemPrompt,
        userInstruction: task,
      });
      const agent = setupAgent({ name: 'takt-internal', systemPrompt });
      options.onDispatch?.(resolution.permissionMode);
      return agent.call(task, callOptions);
    }

    if (options.personaPath) {
      const agentDefinition = loadPersonaPromptFromPath(
        options.personaPath,
        options.projectCwd ?? options.cwd,
        options.workflowBundleResourceRoot,
      );
      const systemPrompt = buildWrappedSystemPrompt(agentDefinition, {
        ...options,
        providerRuntimeInstructions: provider.getRuntimeInstructions(options.allowedTools, callOptions.permissionMode, callOptions.providerOptions?.opencode?.networkAccess),
      });
      options.onPromptResolved?.({
        systemPrompt,
        userInstruction: task,
      });
      const agent = setupAgent({ name: personaName, systemPrompt });
      options.onDispatch?.(resolution.permissionMode);
      return agent.call(task, callOptions);
    }

    if (personaSpec) {
      const customAgents = loadCustomAgents();
      const agentConfig = customAgents.get(personaName);
      if (agentConfig) {
        return this.runCustom(agentConfig, task, options);
      }

      const systemPrompt = buildWrappedSystemPrompt(personaSpec, {
        ...options,
        providerRuntimeInstructions: provider.getRuntimeInstructions(options.allowedTools, callOptions.permissionMode, callOptions.providerOptions?.opencode?.networkAccess),
      });

      options.onPromptResolved?.({
        systemPrompt,
        userInstruction: task,
      });
      const agent = setupAgent({ name: personaName, systemPrompt });
      options.onDispatch?.(resolution.permissionMode);
      return agent.call(task, callOptions);
    }

    const systemPrompt = buildWrappedSystemPrompt('', {
      ...options,
      providerRuntimeInstructions: provider.getRuntimeInstructions(options.allowedTools, callOptions.permissionMode, callOptions.providerOptions?.opencode?.networkAccess),
    });
    options.onPromptResolved?.({
      systemPrompt,
      userInstruction: task,
    });
    const agentSetup = systemPrompt
      ? { name: personaName, systemPrompt }
      : { name: personaName };
    const agent = setupAgent(agentSetup);
    options.onDispatch?.(resolution.permissionMode);
    return agent.call(task, callOptions);
  }
}

const defaultRunner = new AgentRunner();

export async function runAgent(
  personaSpec: string | undefined,
  task: string,
  options: RunAgentOptions,
): Promise<AgentResponse> {
  return defaultRunner.run(personaSpec, task, options);
}
