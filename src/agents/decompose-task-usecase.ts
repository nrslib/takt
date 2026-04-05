import type { Language, PartDefinition } from '../core/models/types.js';
import type { ProviderType } from '../core/piece/types.js';
import { runAgent, type StreamCallback } from './runner.js';
import { parseParts } from '../core/piece/engine/task-decomposer.js';
import { loadDecompositionSchema, loadMorePartsSchema } from '../infra/resources/schema-loader.js';
import {
  buildDecomposePrompt,
  buildMorePartsPrompt,
  toMorePartsResponse,
  toPartDefinitions,
} from './team-leader-structured-output.js';

export interface DecomposeTaskOptions {
  cwd: string;
  persona?: string;
  personaPath?: string;
  language?: Language;
  model?: string;
  provider?: ProviderType;
  onStream?: StreamCallback;
  onPromptResolved?: (promptParts: {
    systemPrompt: string;
    userInstruction: string;
  }) => void;
}

export interface MorePartsResponse {
  done: boolean;
  reasoning: string;
  parts: PartDefinition[];
}

export const TEAM_LEADER_MAX_TURNS = 5;

export async function decomposeTask(
  instruction: string,
  maxParts: number,
  options: DecomposeTaskOptions,
): Promise<PartDefinition[]> {
  const response = await runAgent(options.persona, buildDecomposePrompt(instruction, maxParts, options.language), {
    cwd: options.cwd,
    personaPath: options.personaPath,
    language: options.language,
    model: options.model,
    provider: options.provider,
    allowedTools: [],
    permissionMode: 'readonly',
    maxTurns: TEAM_LEADER_MAX_TURNS,
    outputSchema: loadDecompositionSchema(maxParts),
    onStream: options.onStream,
    onPromptResolved: options.onPromptResolved,
  });

  if (response.status !== 'done') {
    const detail = response.error || response.content || response.status;
    throw new Error(`Team leader failed: ${detail}`);
  }

  const parts = response.structuredOutput?.parts;
  if (parts != null) {
    return toPartDefinitions(parts, maxParts);
  }

  return parseParts(response.content, maxParts);
}

export async function requestMoreParts(
  originalInstruction: string,
  allResults: Array<{ id: string; title: string; status: string; content: string }>,
  existingIds: string[],
  maxAdditionalParts: number,
  options: DecomposeTaskOptions,
): Promise<MorePartsResponse> {
  const prompt = buildMorePartsPrompt(
    originalInstruction,
    allResults,
    existingIds,
    maxAdditionalParts,
    options.language,
  );

  const response = await runAgent(options.persona, prompt, {
    cwd: options.cwd,
    personaPath: options.personaPath,
    language: options.language,
    model: options.model,
    provider: options.provider,
    allowedTools: [],
    permissionMode: 'readonly',
    maxTurns: TEAM_LEADER_MAX_TURNS,
    outputSchema: loadMorePartsSchema(maxAdditionalParts),
    onStream: options.onStream,
  });

  if (response.status !== 'done') {
    const detail = response.error || response.content || response.status;
    throw new Error(`Team leader feedback failed: ${detail}`);
  }

  return toMorePartsResponse(response.structuredOutput, maxAdditionalParts);
}
