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
import { getProvider, type ProviderType, type ProviderCallOptions } from '../infra/providers/index.js';
import type { AgentResponse, CustomAgentConfig } from '../core/models/index.js';
import { resolveAgentProviderModel } from '../core/workflow/provider-resolution.js';
import { DEFAULT_PROVIDER_PERMISSION_PROFILES, resolveStepPermissionMode } from '../core/workflow/permission-profile-resolution.js';
import { createLogger } from '../shared/utils/index.js';
import type { RunAgentOptions } from './types.js';
import { buildWrappedSystemPrompt } from './runner-prompt.js';
import { extractPersonaName } from './persona-spec.js';

export type { RunAgentOptions, StreamCallback } from './types.js';

const log = createLogger('runner');
type ResolvedProviderOptionsHandoff = {
  resolvedProviderOptions?: ProviderCallOptions['providerOptions'];
};

type RunnerHandoffOptions = RunAgentOptions & ResolvedProviderOptionsHandoff;

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
      return options.resolvedProviderOptions;
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

  private static buildCallOptions(
    resolvedModel: string | undefined,
    resolvedProvider: ProviderType,
    resolvedProviderOptions: ProviderCallOptions['providerOptions'],
    options: RunAgentOptions,
    localConfig: ReturnType<typeof loadProjectConfig>,
    globalConfig: ReturnType<typeof loadGlobalConfig>,
  ): ProviderCallOptions {
    const permissionMode = AgentRunner.resolvePermissionMode(
      resolvedProvider,
      options,
      localConfig,
      globalConfig,
    );

    return {
      cwd: options.cwd,
      abortSignal: options.abortSignal,
      sessionId: options.sessionId,
      allowedTools: options.allowedTools,
      mcpServers: options.mcpServers,
      maxTurns: options.maxTurns,
      model: resolvedModel,
      permissionMode,
      providerOptions: resolvedProviderOptions,
      onStream: options.onStream,
      onPermissionRequest: options.onPermissionRequest,
      onAskUserQuestion: options.onAskUserQuestion,
      bypassPermissions: options.bypassPermissions,
      outputSchema: options.outputSchema,
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
        globalProviderProfiles: globalConfig.providerProfiles
          ?? DEFAULT_PROVIDER_PERMISSION_PROFILES,
      });
    }
    return options.permissionMode;
  }

  async runCustom(
    agentConfig: CustomAgentConfig,
    task: string,
    options: RunAgentOptions,
  ): Promise<AgentResponse> {
    const resolved = AgentRunner.resolveProviderAndModel(options.cwd, agentConfig.name, options);
    const providerType = resolved.provider;
    const provider = getProvider(providerType);
    const resolvedSystemPrompt = loadAgentPrompt(agentConfig, options.cwd);
    const systemPrompt = buildWrappedSystemPrompt(resolvedSystemPrompt, options);
    const customOptions: RunnerHandoffOptions = {
      ...options,
      allowedTools: options.allowedTools ?? agentConfig.allowedTools,
    };
    const resolvedProviderOptions = AgentRunner.resolveProviderOptions(
      options.cwd,
      agentConfig.name,
      customOptions,
      resolved.personaProviders,
    );

    options.onPromptResolved?.({
      systemPrompt,
      userInstruction: task,
    });

    const agent = provider.setup({
      name: agentConfig.name,
      systemPrompt,
    });

    return agent.call(task, AgentRunner.buildCallOptions(
      resolved.model,
      providerType,
      resolvedProviderOptions,
      customOptions,
      resolved.localConfig,
      resolved.globalConfig,
    ));
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

    const resolved = AgentRunner.resolveProviderAndModel(options.cwd, personaName, options);
    const providerType = resolved.provider;
    const provider = getProvider(providerType);
    const resolvedProviderOptions = AgentRunner.resolveProviderOptions(
      options.cwd,
      personaName,
      options as RunnerHandoffOptions,
      resolved.personaProviders,
    );
    const callOptions = AgentRunner.buildCallOptions(
      resolved.model,
      providerType,
      resolvedProviderOptions,
      options,
      resolved.localConfig,
      resolved.globalConfig,
    );

    if (options.personaPath) {
      const agentDefinition = loadPersonaPromptFromPath(
        options.personaPath,
        options.projectCwd ?? options.cwd,
      );
      const systemPrompt = buildWrappedSystemPrompt(agentDefinition, options);
      options.onPromptResolved?.({
        systemPrompt,
        userInstruction: task,
      });
      const agent = provider.setup({ name: personaName, systemPrompt });
      return agent.call(task, callOptions);
    }

    if (personaSpec) {
      const customAgents = loadCustomAgents();
      const agentConfig = customAgents.get(personaName);
      if (agentConfig) {
        return this.runCustom(agentConfig, task, options);
      }

      const systemPrompt = buildWrappedSystemPrompt(personaSpec, options);

      options.onPromptResolved?.({
        systemPrompt,
        userInstruction: task,
      });
      const agent = provider.setup({ name: personaName, systemPrompt });
      return agent.call(task, callOptions);
    }

    options.onPromptResolved?.({
      systemPrompt: '',
      userInstruction: task,
    });
    const agent = provider.setup({ name: personaName });
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
