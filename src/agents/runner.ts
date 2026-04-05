/**
 * Agent execution runners
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  loadCustomAgents,
  loadAgentPrompt,
  loadGlobalConfig,
  loadProjectConfig,
  resolveConfigValue,
} from '../infra/config/index.js';
import { getProvider, type ProviderType, type ProviderCallOptions } from '../infra/providers/index.js';
import type { AgentResponse, CustomAgentConfig } from '../core/models/index.js';
import { resolveAgentProviderModel } from '../core/piece/provider-resolution.js';
import { DEFAULT_PROVIDER_PERMISSION_PROFILES, resolveMovementPermissionMode } from '../core/piece/permission-profile-resolution.js';
import { createLogger } from '../shared/utils/index.js';
import { loadTemplate } from '../shared/prompts/index.js';
import type { RunAgentOptions } from './types.js';

export type { RunAgentOptions, StreamCallback } from './types.js';

const log = createLogger('runner');

/**
 * Agent execution runner.
 *
 * Resolves agent configuration (provider, model, prompt) and
 * delegates execution to the appropriate provider.
 */
export class AgentRunner {
  private static resolveProviderAndModel(
    cwd: string,
    personaDisplayName: string | undefined,
    options?: RunAgentOptions,
  ): {
    provider: ProviderType;
    model: string | undefined;
    localConfig: ReturnType<typeof loadProjectConfig>;
    globalConfig: ReturnType<typeof loadGlobalConfig>;
  } {
    const localConfig = loadProjectConfig(cwd);
    const globalConfig = loadGlobalConfig();
    if (options?.resolvedProvider) {
      return {
        provider: options.resolvedProvider,
        model: options.resolvedModel,
        localConfig,
        globalConfig,
      };
    }
    const personaProviders = resolveConfigValue(cwd, 'personaProviders');
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
    };
  }

  /** Load persona prompt from file path */
  private static loadPersonaPromptFromPath(personaPath: string): string {
    if (!existsSync(personaPath)) {
      throw new Error(`Persona file not found: ${personaPath}`);
    }
    return readFileSync(personaPath, 'utf-8');
  }

  /**
   * Get persona name from path or spec.
   * For personas in subdirectories, includes parent dir for pattern matching.
   */
  private static extractPersonaName(personaSpec: string): string {
    if (!personaSpec.endsWith('.md')) {
      return personaSpec;
    }

    const name = basename(personaSpec, '.md');
    const dir = basename(dirname(personaSpec));

    if (dir === 'personas' || dir === '.') {
      return name;
    }

    return `${dir}/${name}`;
  }

  /** Build ProviderCallOptions from RunAgentOptions */
  private static buildCallOptions(
    resolvedModel: string | undefined,
    resolvedProvider: ProviderType,
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
      providerOptions: options.providerOptions,
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
      return resolveMovementPermissionMode({
        movementName: options.permissionResolution.movementName,
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

  /** Run a custom agent */
  async runCustom(
    agentConfig: CustomAgentConfig,
    task: string,
    options: RunAgentOptions,
  ): Promise<AgentResponse> {
    const resolved = AgentRunner.resolveProviderAndModel(options.cwd, agentConfig.name, options);
    const providerType = resolved.provider;
    const provider = getProvider(providerType);

    const resolvedSystemPrompt = agentConfig.claudeAgent || agentConfig.claudeSkill
      ? undefined
      : loadAgentPrompt(agentConfig, options.cwd);

    options.onPromptResolved?.({
      systemPrompt: resolvedSystemPrompt ?? '',
      userInstruction: task,
    });

    const agent = provider.setup({
      name: agentConfig.name,
      systemPrompt: resolvedSystemPrompt,
      claudeAgent: agentConfig.claudeAgent,
      claudeSkill: agentConfig.claudeSkill,
    });

    const customOptions: RunAgentOptions = {
      ...options,
      allowedTools: options.allowedTools ?? agentConfig.allowedTools,
    };

    return agent.call(task, AgentRunner.buildCallOptions(
      resolved.model,
      providerType,
      customOptions,
      resolved.localConfig,
      resolved.globalConfig,
    ));
  }

  /** Run an agent by name, path, inline prompt string, or no agent at all */
  async run(
    personaSpec: string | undefined,
    task: string,
    options: RunAgentOptions,
  ): Promise<AgentResponse> {
    const personaName = personaSpec ? AgentRunner.extractPersonaName(personaSpec) : 'default';
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
    const callOptions = AgentRunner.buildCallOptions(
      resolved.model,
      providerType,
      options,
      resolved.localConfig,
      resolved.globalConfig,
    );

    // 1. If personaPath is provided (resolved file exists), load prompt from file
    //    and wrap it through the perform_agent_system_prompt template
    if (options.personaPath) {
      const agentDefinition = AgentRunner.loadPersonaPromptFromPath(options.personaPath);
      const language = options.language ?? 'en';
      const templateVars: Record<string, string> = { agentDefinition };

      if (options.pieceMeta) {
        templateVars.pieceName = options.pieceMeta.pieceName;
        templateVars.pieceDescription = options.pieceMeta.pieceDescription ?? '';
        templateVars.currentMovement = options.pieceMeta.currentMovement;
        templateVars.movementsList = options.pieceMeta.movementsList
          .map((m, i) => `${i + 1}. ${m.name}${m.description ? ` - ${m.description}` : ''}`)
          .join('\n');
        templateVars.currentPosition = options.pieceMeta.currentPosition;
      }

      const systemPrompt = loadTemplate('perform_agent_system_prompt', language, templateVars);
      options.onPromptResolved?.({
        systemPrompt,
        userInstruction: task,
      });
      const agent = provider.setup({ name: personaName, systemPrompt });
      return agent.call(task, callOptions);
    }

    // 2. If personaSpec is provided but no personaPath (file not found), try custom agent first,
    //    then use the string as inline system prompt
    if (personaSpec) {
      const customAgents = loadCustomAgents();
      const agentConfig = customAgents.get(personaName);
      if (agentConfig) {
        return this.runCustom(agentConfig, task, options);
      }

      options.onPromptResolved?.({
        systemPrompt: personaSpec,
        userInstruction: task,
      });
      const agent = provider.setup({ name: personaName, systemPrompt: personaSpec });
      return agent.call(task, callOptions);
    }

    // 3. No persona specified — run with instruction_template only (no system prompt)
    options.onPromptResolved?.({
      systemPrompt: '',
      userInstruction: task,
    });
    const agent = provider.setup({ name: personaName });
    return agent.call(task, callOptions);
  }
}

// ---- Module-level function facade ----

const defaultRunner = new AgentRunner();

export async function runAgent(
  personaSpec: string | undefined,
  task: string,
  options: RunAgentOptions,
): Promise<AgentResponse> {
  return defaultRunner.run(personaSpec, task, options);
}
