/**
 * Persona configuration loader
 *
 * Loads persona prompts with user → builtin fallback:
 * 1. User personas: ~/.takt/personas/*.md
 * 2. Builtin personas: builtins/{lang}/facets/personas/*.md
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { CustomAgentConfig } from '../../../core/models/index.js';
import {
  getGlobalConfigDir,
  getProjectConfigDir,
  getGlobalPersonasDir,
  getBuiltinPersonasDir,
  getGlobalFacetDir,
  getProjectFacetDir,
  getRepertoireDir,
  isPathSafe,
} from '../paths.js';
import { getProjectConfigDirIfEnabled, isProjectConfigEnabled } from '../project/projectConfigGuards.js';
import { resolveConfigValue } from '../resolveConfigValue.js';

/** Get all allowed base directories for persona prompt files */
function getAllowedPromptBases(cwd: string): string[] {
  const lang = resolveConfigValue(cwd, 'language') ?? 'en';
  const enabledProjectConfigDir = getProjectConfigDirIfEnabled(cwd);
  const globalConfigDir = getGlobalConfigDir();
  const bases: string[] = [
    join(cwd, 'personas'),
    join(cwd, 'agents'),
    join(cwd, 'workflows'),
  ];
  if (enabledProjectConfigDir) {
    bases.push(
      join(enabledProjectConfigDir, 'personas'),
      join(enabledProjectConfigDir, 'agents'),
      join(enabledProjectConfigDir, 'workflows'),
      getProjectFacetDir(cwd, 'personas'),
      join(enabledProjectConfigDir, 'repertoire'),
    );
  }
  bases.push(
    join(globalConfigDir, 'personas'),
    join(globalConfigDir, 'agents'),
    join(globalConfigDir, 'workflows'),
    getRepertoireDir(),
    getGlobalPersonasDir(),
    getBuiltinPersonasDir(lang),
    getGlobalFacetDir('personas'),
  );
  return bases;
}

export function validatePersonaPromptPath(personaPath: string, cwd: string): void {
  // When the project config dir is disabled due to collision with the global
  // config dir, reject paths that literally (without following symlinks) start
  // with the project config dir path, so access via the colliding symlinked path
  // is blocked even though it resolves to the same physical location as the global dir.
  if (!isProjectConfigEnabled(cwd)) {
    const projectConfigDir = resolve(getProjectConfigDir(cwd));
    const normalizedPersonaPath = resolve(personaPath);
    if (normalizedPersonaPath === projectConfigDir
      || normalizedPersonaPath.startsWith(projectConfigDir + '/')) {
      throw new Error(`Persona prompt file path is not allowed: ${personaPath}`);
    }
  }

  const isValid = getAllowedPromptBases(cwd).some((base) => isPathSafe(base, personaPath));
  if (!isValid) {
    throw new Error(`Persona prompt file path is not allowed: ${personaPath}`);
  }

  if (!existsSync(personaPath)) {
    throw new Error(`Persona prompt file not found: ${personaPath}`);
  }
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

/** Load all custom agents from ~/.takt/personas/ */
export function loadCustomAgents(): Map<string, CustomAgentConfig> {
  const agents = new Map<string, CustomAgentConfig>();
  for (const agent of loadAgentsFromDir(getGlobalPersonasDir())) {
    agents.set(agent.name, agent);
  }
  return agents;
}

/** List available custom agents */
export function listCustomAgents(): string[] {
  return Array.from(loadCustomAgents().keys()).sort();
}

/** Load agent prompt content. */
export function loadAgentPrompt(agent: CustomAgentConfig, cwd: string): string {
  if (agent.prompt) {
    return agent.prompt;
  }

  if (agent.promptFile) {
    const promptFile = agent.promptFile;
    validatePersonaPromptPath(promptFile, cwd);

    if (!existsSync(agent.promptFile)) {
      throw new Error(`Agent prompt file not found: ${agent.promptFile}`);
    }

    return readFileSync(agent.promptFile, 'utf-8');
  }

  throw new Error(`Agent ${agent.name} has no prompt defined`);
}

/** Load persona prompt from a resolved path. */
export function loadPersonaPromptFromPath(personaPath: string, cwd: string): string {
  validatePersonaPromptPath(personaPath, cwd);
  return readFileSync(personaPath, 'utf-8');
}
