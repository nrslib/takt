import type { LoopMonitorConfig, LoopMonitorJudge } from '../../../core/models/index.js';
import type { FacetResolutionContext, WorkflowSections } from './resource-resolver.js';
import { resolvePersona, resolveRefToContent } from './resource-resolver.js';
import { normalizeProviderReference } from './workflowStepNormalizer.js';

function normalizeLoopMonitorJudge(
  raw: {
    persona?: string;
    provider?: unknown;
    model?: string;
    instruction?: string;
    rules: Array<{ condition: string; next: string }>;
  },
  workflowDir: string,
  sections: WorkflowSections,
  context?: FacetResolutionContext,
): LoopMonitorJudge {
  const { personaSpec, personaPath } = resolvePersona(raw.persona, sections, workflowDir, context);
  const normalizedProvider = normalizeProviderReference(
    raw.provider as Parameters<typeof normalizeProviderReference>[0],
    raw.model,
    undefined,
  );
  return {
    persona: personaSpec,
    personaPath,
    provider: normalizedProvider.provider,
    model: normalizedProvider.model,
    providerOptions: normalizedProvider.providerOptions,
    instruction: raw.instruction
      ? resolveRefToContent(
          raw.instruction,
          sections.resolvedInstructionsWithSource ?? sections.resolvedInstructions,
          workflowDir,
          'instructions',
          context,
        )
      : undefined,
    rules: raw.rules.map((rule) => ({ condition: rule.condition, next: rule.next })),
  };
}

export function normalizeLoopMonitors(
  raw: Array<{
    cycle: string[];
    threshold: number;
    judge: {
      persona?: string;
      provider?: unknown;
      model?: string;
      instruction?: string;
      rules: Array<{ condition: string; next: string }>;
    };
  }> | undefined,
  workflowDir: string,
  sections: WorkflowSections,
  context?: FacetResolutionContext,
): LoopMonitorConfig[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined;
  }

  return raw.map((monitor) => ({
    cycle: monitor.cycle,
    threshold: monitor.threshold,
    judge: normalizeLoopMonitorJudge(monitor.judge, workflowDir, sections, context),
  }));
}
