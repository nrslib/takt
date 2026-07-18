import type { LoopMonitorConfig, LoopMonitorJudge } from '../../../core/models/index.js';
import { splitTagFindingsCondition } from './workflowRuleNormalizer.js';
import type { FacetResolutionContext, WorkflowSections } from './resource-resolver.js';
import { resolvePersona, resolveRefToContent } from './resource-resolver.js';
import { normalizeProviderReference } from './workflowStepNormalizer.js';

function normalizeLoopMonitorJudge(
  raw: {
    session_key?: string;
    persona?: string;
    provider?: unknown;
    model?: string | null;
    provider_options?: unknown;
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
    raw.provider_options as Parameters<typeof normalizeProviderReference>[2],
    workflowDir,
    context,
  );
  return {
    sessionKey: raw.session_key,
    persona: personaSpec,
    personaPath,
    provider: normalizedProvider.provider,
    model: normalizedProvider.model,
    modelSpecified: normalizedProvider.modelSpecified,
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
    rules: raw.rules.map((rule) => {
      // loop monitor judge のルールは normalizeRule を通らず、ガード評価の
      // 経路もない。タグ && findings の複合はここでは未対応として拒否する。
      if (splitTagFindingsCondition(rule.condition) !== undefined) {
        throw new Error(
          `Configuration error: loop_monitor judge rule "${rule.condition}" combines a status condition with findings guards, which is not supported here`,
        );
      }
      return { condition: rule.condition, next: rule.next };
    }),
  };
}

export function normalizeLoopMonitors(
  raw: Array<{
    cycle: string[];
    threshold: number;
    judge: {
      session_key?: string;
      persona?: string;
      provider?: unknown;
      model?: string | null;
      provider_options?: unknown;
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
