/**
 * Agent and persona configuration loader
 *
 * Loads persona prompts with user → builtin fallback:
 * 1. User personas: ~/.takt/personas/*.md (preferred)
 * 2. User agents (legacy): ~/.takt/agents/*.md (backward compat)
 * 3. Builtin personas: resources/global/{lang}/personas/*.md
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { CustomAgentConfig } from '../../../core/models/index.js';
import {
  getGlobalPersonasDir,
  getGlobalAgentsDir,
  getGlobalPiecesDir,
  getBuiltinPersonasDir,
  getBuiltinPiecesDir,
  isPathSafe,
} from '../paths.js';
import { getLanguage } from '../global/globalConfig.js';

/** Get all allowed base directories for persona/agent prompt files */
function getAllowedPromptBases(): string[] {
  const lang = getLanguage();
  return [
    getGlobalPersonasDir(),
    getGlobalAgentsDir(),
    getGlobalPiecesDir(),
    getBuiltinPersonasDir(lang),
    getBuiltinPiecesDir(lang),
  ];
}

/** Load agents from markdown files in a directory */
export function loadAgentsFromDir(dirPath: string): CustomAgentConfig[] {
  if (!existsSync(dirPath)) {
    return [];
  }
  const agents: CustomAgentConfig[] = [];
  for (const file of readdirSync(dirPath)) {
    if (file.endsWith('.md')) {
      const name = basename(file, '.md');
      const promptFile = join(dirPath, file);
      agents.push({
        name,
        promptFile,
      });
    }
  }
  return agents;
}

/** Load all custom agents from global directories (~/.takt/personas/, ~/.takt/agents/) */
export function loadCustomAgents(): Map<string, CustomAgentConfig> {
  const agents = new Map<string, CustomAgentConfig>();

  // Legacy: ~/.takt/agents/*.md (loaded first, overwritten by personas/)
  for (const agent of loadAgentsFromDir(getGlobalAgentsDir())) {
    agents.set(agent.name, agent);
  }

  // Preferred: ~/.takt/personas/*.md (takes priority)
  for (const agent of loadAgentsFromDir(getGlobalPersonasDir())) {
    agents.set(agent.name, agent);
  }

  return agents;
}

/** List available custom agents */
export function listCustomAgents(): string[] {
  return Array.from(loadCustomAgents().keys()).sort();
}

/**
 * Load agent prompt content.
 * Prompts can be loaded from:
 * - ~/.takt/personas/*.md (preferred)
 * - ~/.takt/agents/*.md (legacy)
 * - ~/.takt/pieces/{piece}/*.md (piece-specific)
 */
export function loadAgentPrompt(agent: CustomAgentConfig): string {
  if (agent.prompt) {
    return agent.prompt;
  }

  if (agent.promptFile) {
    const promptFile = agent.promptFile;
    const isValid = getAllowedPromptBases().some((base) => isPathSafe(base, promptFile));
    if (!isValid) {
      throw new Error(`Agent prompt file path is not allowed: ${agent.promptFile}`);
    }

    if (!existsSync(agent.promptFile)) {
      throw new Error(`Agent prompt file not found: ${agent.promptFile}`);
    }

    return readFileSync(agent.promptFile, 'utf-8');
  }

  throw new Error(`Agent ${agent.name} has no prompt defined`);
}

/**
 * Load persona prompt from a resolved path.
 * Used by piece engine when personaPath is already resolved.
 */
export function loadPersonaPromptFromPath(personaPath: string): string {
  const isValid = getAllowedPromptBases().some((base) => isPathSafe(base, personaPath));
  if (!isValid) {
    throw new Error(`Persona prompt file path is not allowed: ${personaPath}`);
  }

  if (!existsSync(personaPath)) {
    throw new Error(`Persona prompt file not found: ${personaPath}`);
  }

  return readFileSync(personaPath, 'utf-8');
}
