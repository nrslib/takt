/**
 * Workflow state transition logic
 *
 * Handles determining the next step based on rules-based routing.
 */

import type {
  WorkflowStep,
} from '../../models/types.js';

export interface WorkflowRuleTransition {
  nextStep?: string;
  returnValue?: string;
  requiresUserInput?: boolean;
}

export function determineRuleTransition(
  step: WorkflowStep,
  ruleIndex: number,
): WorkflowRuleTransition | null {
  const rule = step.rules?.[ruleIndex];
  if (!rule) {
    return null;
  }

  return {
    ...(rule.next !== undefined ? { nextStep: rule.next } : {}),
    ...(rule.returnValue !== undefined ? { returnValue: rule.returnValue } : {}),
    ...(rule.requiresUserInput === true ? { requiresUserInput: true } : {}),
  };
}

/**
 * Determine next step using rules-based detection.
 * Returns the next step name from the matched rule, or null if no rule matched.
 */
export function determineNextStepByRules(
  step: WorkflowStep,
  ruleIndex: number,
): string | null {
  const transition = determineRuleTransition(step, ruleIndex);
  if (!transition) {
    return null;
  }
  return transition.nextStep ?? null;
}

/**
 * Extract user-facing prompt from blocked response.
 * Looks for common patterns like "必要な情報:", "質問:", etc.
 */
export function extractBlockedPrompt(content: string): string {
  // Try to extract specific question/info needed
  const patterns = [
    /必要な情報[:：]\s*(.+?)(?:\n|$)/i,
    /質問[:：]\s*(.+?)(?:\n|$)/i,
    /理由[:：]\s*(.+?)(?:\n|$)/i,
    /確認[:：]\s*(.+?)(?:\n|$)/i,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  // Return the full content if no specific pattern found
  return content;
}
