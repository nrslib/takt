import type { LoopMonitorConfig, LoopMonitorJudge } from '../../../core/models/index.js';
import type { FacetResolutionContext, WorkflowSections } from './resource-resolver.js';
import { resolvePersona, resolveRefToContent } from './resource-resolver.js';
import { parseWorkflowRuleCondition } from '../../../core/models/workflow-rule-condition.js';

function normalizeLoopMonitorJudge(
  raw: {
    persona?: string;
    instruction?: string;
    rules: Array<{ condition: string; next: string }>;
  },
  workflowDir: string,
  sections: WorkflowSections,
  context?: FacetResolutionContext,
): LoopMonitorJudge {
  const { personaSpec, personaPath } = resolvePersona(raw.persona, sections, workflowDir, context);
  return {
    persona: personaSpec,
    personaPath,
    ...(raw.persona !== undefined && raw.persona.length > 0 ? { personaRef: raw.persona } : {}),
    instruction: raw.instruction
      ? resolveRefToContent(
          raw.instruction,
          sections.resolvedInstructionsWithSource ?? sections.resolvedInstructions,
          workflowDir,
          'instructions',
          context,
        )
      : undefined,
    ...(raw.instruction === undefined ? {} : { instructionRef: raw.instruction }),
    rules: raw.rules.map((rule) => ({
      condition: parseWorkflowRuleCondition(rule.condition),
      next: rule.next,
    })),
  };
}

export function normalizeLoopMonitors(
  raw: Array<{
    cycle: string[];
    ignore_steps?: string[];
    threshold: number;
    judge: {
      persona?: string;
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
    ignoreSteps: monitor.ignore_steps,
    threshold: monitor.threshold,
    judge: normalizeLoopMonitorJudge(monitor.judge, workflowDir, sections, context),
  }));
}
