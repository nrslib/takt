import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse, Language, StepProviderOptions } from '../core/models/types.js';
import { createRawFindingsOutputJsonSchema } from '../core/models/finding-schemas.js';
import type { ProviderType } from '../shared/types/provider.js';
import { buildFindingIntakeExtractionPrompt } from '../shared/prompts/finding-intake-extraction.js';
import { runAgent } from './runner.js';

export interface NormalizeFindingIntakeOptions {
  provider: ProviderType;
  model: string;
  providerOptions?: StepProviderOptions;
  language?: Language;
  abortSignal?: AbortSignal;
  onPromptResolved?: (promptParts: {
    systemPrompt: string;
    userInstruction: string;
  }) => void;
}

export async function normalizeFindingIntake(
  report: string,
  options: NormalizeFindingIntakeOptions,
): Promise<AgentResponse> {
  const isolatedCwd = mkdtempSync(join(tmpdir(), 'takt-finding-intake-'));
  try {
    return await runAgent(undefined, buildFindingIntakeExtractionPrompt(report), {
      cwd: isolatedCwd,
      executionProfile: 'isolated-structured',
      resolvedProvider: options.provider,
      resolvedModel: options.model,
      resolvedProviderOptions: options.providerOptions ?? null,
      permissionMode: 'readonly',
      allowedTools: [],
      outputSchema: createRawFindingsOutputJsonSchema(),
      language: options.language,
      abortSignal: options.abortSignal,
      onPromptResolved: options.onPromptResolved,
    });
  } finally {
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
}
