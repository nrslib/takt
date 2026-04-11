import type { z } from 'zod';
import type {
  WorkflowEffect,
  WorkflowEffectScalarReference,
  WorkflowStep,
  WorkflowStepRawSchema,
  WorkflowTemplateReference,
} from '../../../core/models/index.js';

type RawStep = z.output<typeof WorkflowStepRawSchema>;
type RawWorkflowEffect = NonNullable<RawStep['effects']>[number];

const TEMPLATE_REFERENCE_PATTERN = /^\{(?:context|structured|effect):[^}]+\}$/;

function normalizeTemplateReference(value: string, field: string): WorkflowTemplateReference {
  if (!TEMPLATE_REFERENCE_PATTERN.test(value)) {
    throw new Error(`Invalid ${field} "${value}": expected full template reference`);
  }
  return value as WorkflowTemplateReference;
}

function normalizeEffectScalarReference(
  value: number | string | undefined,
  field: string,
): WorkflowEffectScalarReference | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'number') {
    return value;
  }
  return normalizeTemplateReference(value, field);
}

function requireEffectScalarReference(
  value: number | string,
  field: string,
): WorkflowEffectScalarReference {
  const normalized = normalizeEffectScalarReference(value, field);
  if (normalized === undefined) {
    throw new Error(`Missing required ${field}`);
  }
  return normalized;
}

function normalizeWorkflowEffect(effect: RawWorkflowEffect): WorkflowEffect {
  switch (effect.type) {
  case 'enqueue_task':
    return {
      type: 'enqueue_task',
      mode: effect.mode,
      workflow: effect.workflow,
      task: effect.task,
      ...(effect.base_branch !== undefined ? { base_branch: effect.base_branch } : {}),
      ...(effect.worktree !== undefined ? { worktree: effect.worktree } : {}),
      ...(effect.pr !== undefined ? { pr: normalizeEffectScalarReference(effect.pr, 'effects.pr') } : {}),
      ...(typeof effect.issue === 'string'
        ? { issue: normalizeTemplateReference(effect.issue, 'effects.issue') }
        : effect.issue !== undefined
          ? { issue: effect.issue }
          : {}),
    };
  case 'comment_pr':
    return {
      type: 'comment_pr',
      pr: requireEffectScalarReference(effect.pr, 'effects.pr'),
      body: effect.body,
    };
  case 'sync_with_root':
    return {
      type: 'sync_with_root',
      pr: requireEffectScalarReference(effect.pr, 'effects.pr'),
    };
  case 'resolve_conflicts_with_ai':
    return {
      type: 'resolve_conflicts_with_ai',
      pr: requireEffectScalarReference(effect.pr, 'effects.pr'),
    };
  case 'merge_pr':
    return {
      type: 'merge_pr',
      pr: requireEffectScalarReference(effect.pr, 'effects.pr'),
    };
  }
}

export function normalizeWorkflowEffects(effects: RawStep['effects']): WorkflowStep['effects'] {
  return effects?.map((effect) => normalizeWorkflowEffect(effect));
}
