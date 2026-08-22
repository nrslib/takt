import type { WorkflowWideRule } from '../../models/types.js';

export function mergeWorkflowWideRules(
  inheritedRules: readonly WorkflowWideRule[] | undefined,
  ownRules: readonly WorkflowWideRule[] | undefined,
): readonly WorkflowWideRule[] {
  const inherited = inheritedRules ?? [];
  const own = ownRules ?? [];

  return [
    ...inherited,
    ...own.filter((rule) => !inherited.some((existing) =>
      existing.ref === rule.ref
      && existing.position === rule.position
      && existing.content === rule.content
    )),
  ];
}
