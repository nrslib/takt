import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse, Language, StepProviderOptions } from '../core/models/types.js';
import { createRawFindingsOutputJsonSchema } from '../core/models/finding-schemas.js';
import type { ProviderType } from '../shared/types/provider.js';
import {
  buildFindingIntakeCorrectionPrompt,
  buildFindingIntakeExtractionPrompt,
} from '../shared/prompts/finding-intake-extraction.js';
import { runAgent } from './runner.js';

export interface NormalizeFindingIntakeOptions {
  provider: ProviderType;
  model?: string;
  providerOptions?: StepProviderOptions;
  language?: Language;
  abortSignal?: AbortSignal;
  onPromptResolved?: (promptParts: {
    systemPrompt: string;
    userInstruction: string;
  }) => void;
  mode?: 'initial' | 'correction';
  extractionFidelityCorrection?: boolean;
}

export async function normalizeFindingIntake(
  report: string,
  options: NormalizeFindingIntakeOptions,
): Promise<AgentResponse> {
  const isolatedCwd = mkdtempSync(join(tmpdir(), 'takt-finding-intake-'));
  try {
    const instruction = options.mode === 'correction'
      ? buildFindingIntakeCorrectionPrompt(
          report,
          options.language ?? 'en',
          options.extractionFidelityCorrection ?? false,
        )
      : buildFindingIntakeExtractionPrompt(report, options.language ?? 'en');
    return await runAgent(undefined, instruction, {
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
