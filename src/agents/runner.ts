/**
 * Agent execution runners
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { loadCustomAgents, loadAgentPrompt, resolveConfigValues } from '../infra/config/index.js';
import { getProvider, type ProviderType, type ProviderCallOptions } from '../infra/providers/index.js';
import type { AgentResponse, CustomAgentConfig } from '../core/models/index.js';
import { resolveProviderModelCandidates } from '../core/piece/provider-resolution.js';
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
    options?: RunAgentOptions,
    agentConfig?: CustomAgentConfig,
  ): { provider: ProviderType; model: string | undefined } {
    const config = resolveConfigValues(cwd, ['provider', 'model']);
    const resolvedProvider = resolveProviderModelCandidates([
      { provider: options?.provider },
      { provider: options?.stepProvider },
      { provider: config.provider },
      { provider: agentConfig?.provider },
    ]).provider;
    if (!resolvedProvider) {
      throw new Error('No provider configured. Set "provider" in ~/.takt/config.yaml');
    }

    const configModel = config.provider === resolvedProvider
      ? config.model
      : undefined;
    const resolvedModel = resolveProviderModelCandidates([
      { model: options?.model },
      { model: options?.stepModel },
      { model: agentConfig?.model },
      { model: configModel },
    ]).model;

    return {
      provider: resolvedProvider,
      model: resolvedModel,
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
      model: resolvedModel,
      permissionMode: options.permissionMode,
      providerOptions: options.providerOptions,
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
    const resolved = AgentRunner.resolveProviderAndModel(options.cwd, options, agentConfig);
    const providerType = resolved.provider;
    const provider = getProvider(providerType);

    const agent = provider.setup({
      name: agentConfig.name,
      systemPrompt: agentConfig.claudeAgent || agentConfig.claudeSkill
        ? undefined
        : loadAgentPrompt(agentConfig, options.cwd),
      claudeAgent: agentConfig.claudeAgent,
      claudeSkill: agentConfig.claudeSkill,
    });

    return agent.call(task, AgentRunner.buildCallOptions(resolved.model, options, agentConfig));
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

    const resolved = AgentRunner.resolveProviderAndModel(options.cwd, options);
    const providerType = resolved.provider;
    const provider = getProvider(providerType);
    const callOptions = AgentRunner.buildCallOptions(resolved.model, options);

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
