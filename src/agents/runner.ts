/**
 * Agent execution runners
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { loadCustomAgents, loadAgentPrompt, loadGlobalConfig, loadProjectConfig } from '../infra/config/index.js';
import { mergeProviderOptions } from '../infra/config/loaders/pieceParser.js';
import { getProvider, type ProviderType, type ProviderCallOptions } from '../infra/providers/index.js';
import type { AgentResponse, CustomAgentConfig, MovementProviderOptions } from '../core/models/index.js';
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
  /** Resolve provider type from options, agent config, project config, global config */
  private static resolveProvider(
    cwd: string,
    options?: RunAgentOptions,
    agentConfig?: CustomAgentConfig,
  ): ProviderType {
    if (options?.provider) return options.provider;
    if (agentConfig?.provider) return agentConfig.provider;
    const projectConfig = loadProjectConfig(cwd);
    if (projectConfig.provider) return projectConfig.provider;
    try {
      const globalConfig = loadGlobalConfig();
      if (globalConfig.provider) return globalConfig.provider;
    } catch {
      // Ignore missing global config; fallback below
    }
    return 'claude';
  }

  /**
   * Resolve model from options, agent config, global config.
   * Global config model is only used when its provider matches the resolved provider,
   * preventing cross-provider model mismatches (e.g., 'opus' sent to Codex).
   */
  private static resolveModel(
    resolvedProvider: ProviderType,
    options?: RunAgentOptions,
    agentConfig?: CustomAgentConfig,
  ): string | undefined {
    if (options?.model) return options.model;
    if (agentConfig?.model) return agentConfig.model;
    try {
      const globalConfig = loadGlobalConfig();
      if (globalConfig.model) {
        const globalProvider = globalConfig.provider ?? 'claude';
        if (globalProvider === resolvedProvider) return globalConfig.model;
      }
    } catch {
      // Ignore missing global config
    }
    return undefined;
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

  /**
   * Resolve provider options with 4-layer priority: Global < Local < Step (piece+movement merged).
   * Step already contains the piece+movement merge result from pieceParser.
   */
  private static resolveProviderOptions(
    cwd: string,
    stepOptions?: MovementProviderOptions,
  ): MovementProviderOptions | undefined {
    let globalOptions: MovementProviderOptions | undefined;
    try {
      globalOptions = loadGlobalConfig().providerOptions;
    } catch { /* ignore */ }

    const localOptions = loadProjectConfig(cwd).provider_options;

    return mergeProviderOptions(globalOptions, localOptions, stepOptions);
  }

  /** Build ProviderCallOptions from RunAgentOptions */
  private static buildCallOptions(
    resolvedProvider: ProviderType,
    options: RunAgentOptions,
    agentConfig?: CustomAgentConfig,
  ): ProviderCallOptions {
    return {
      cwd: options.cwd,
      abortSignal: options.abortSignal,
      sessionId: options.sessionId,
      allowedTools: options.allowedTools ?? agentConfig?.allowedTools,
      mcpServers: options.mcpServers,
      maxTurns: options.maxTurns,
      model: AgentRunner.resolveModel(resolvedProvider, options, agentConfig),
      permissionMode: options.permissionMode,
      providerOptions: AgentRunner.resolveProviderOptions(options.cwd, options.providerOptions),
      onStream: options.onStream,
      onPermissionRequest: options.onPermissionRequest,
      onAskUserQuestion: options.onAskUserQuestion,
      bypassPermissions: options.bypassPermissions,
      outputSchema: options.outputSchema,
    };
  }

  /** Run a custom agent */
  async runCustom(
    agentConfig: CustomAgentConfig,
    task: string,
    options: RunAgentOptions,
  ): Promise<AgentResponse> {
    const providerType = AgentRunner.resolveProvider(options.cwd, options, agentConfig);
    const provider = getProvider(providerType);

    const agent = provider.setup({
      name: agentConfig.name,
      systemPrompt: agentConfig.claudeAgent || agentConfig.claudeSkill
        ? undefined
        : loadAgentPrompt(agentConfig),
      claudeAgent: agentConfig.claudeAgent,
      claudeSkill: agentConfig.claudeSkill,
    });

    return agent.call(task, AgentRunner.buildCallOptions(providerType, options, agentConfig));
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
      hasPersonaPath: !!options.personaPath,
      hasSession: !!options.sessionId,
      permissionMode: options.permissionMode,
    });

    const providerType = AgentRunner.resolveProvider(options.cwd, options);
    const provider = getProvider(providerType);
    const callOptions = AgentRunner.buildCallOptions(providerType, options);

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

      const agent = provider.setup({ name: personaName, systemPrompt: personaSpec });
      return agent.call(task, callOptions);
    }

    // 3. No persona specified — run with instruction_template only (no system prompt)
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
