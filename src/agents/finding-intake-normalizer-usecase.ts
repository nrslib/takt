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
import { getProvider } from '../infra/providers/index.js';

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
    const provider = getProvider(options.provider);
    const callOptions = {
      cwd: isolatedCwd,
      abortSignal: options.abortSignal,
      model: options.model,
      permissionMode: 'readonly' as const,
      allowedTools: [] as string[],
      outputSchema: createRawFindingsOutputJsonSchema(),
      language: options.language,
      providerOptions: options.providerOptions,
    };
    const agent = provider.setupIsolatedStructured({
      name: 'finding-intake-normalizer',
      systemPrompt: '',
    });
    options.onPromptResolved?.({
      systemPrompt: '',
      userInstruction: instruction,
    });
    return await agent.call(instruction, callOptions);
  } finally {
    rmSync(isolatedCwd, { recursive: true, force: true });
  }
}
