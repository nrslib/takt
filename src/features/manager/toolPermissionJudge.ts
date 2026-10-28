import { z } from 'zod/v4';
import { executeIsolatedStructuredInternalAgent, type ResolvedInternalAgentOptions } from '../../agents/agent-usecases.js';
import type { ToolPermissionDecisionRequest } from '../../core/workflow/types.js';
import { getLabel } from '../../shared/i18n/index.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { toStrictManagerOutputSchema } from './outputSchema.js';
import type { ManagerPermissionContext } from './toolPermissionInquiry.js';

export const MANAGER_PERMISSION_JUDGE_TIMEOUT_MS = 30_000;

const decisionSchema = z.object({
  decision: z.enum(['allow', 'deny', 'ask']),
  reason: z.string().nullable(),
}).strict();
const outputSchema = toStrictManagerOutputSchema(decisionSchema);

export interface ManagerPermissionJudgePlan {
  resolution: ResolvedInternalAgentOptions['resolution'];
  language: 'ja' | 'en';
  systemPrompt: string;
  managerPersona: string;
  managerPolicy: string;
}

export interface ManagerPermissionGoal {
  id: string;
  repositoryDirectory: string;
  constraints: readonly string[];
}

export type Judgment = { decision: 'allow' } | { decision: 'deny' | 'ask'; reason: string };

export async function judgeManagerToolPermission(
  plan: ManagerPermissionJudgePlan,
  request: ToolPermissionDecisionRequest,
  turn: { instruction: string; goal?: ManagerPermissionGoal; abortSignal: AbortSignal; context: ManagerPermissionContext },
): Promise<Judgment> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([turn.abortSignal, ...(request.abortSignal ? [request.abortSignal] : []), deadline.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const instruction = JSON.stringify({
      toolName: request.toolName,
      toolArguments: sanitizeSensitiveText(JSON.stringify(request.toolInput) ?? 'null'),
      cwd: request.cwd,
      managerPersona: plan.managerPersona,
      managerPolicy: plan.managerPolicy,
      humanInstruction: turn.instruction,
      scopedPermissions: turn.context.scopedPermissions,
      relatedInquiries: turn.context.relatedInquiries,
      readErrors: turn.context.readErrors.map((message) => ({ message })),
      ...(turn.goal === undefined ? {} : { goal: turn.goal }),
    });
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Permission judgment interrupted'));
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => deadline.abort(), MANAGER_PERMISSION_JUDGE_TIMEOUT_MS);
    });
    const response = await Promise.race([
      executeIsolatedStructuredInternalAgent(plan.systemPrompt, instruction, outputSchema, {
        agentName: 'manager-permission-judge', cwd: request.cwd, abortSignal: signal,
        language: plan.language, resolution: plan.resolution,
      }),
      interrupted,
    ]);
    signal.throwIfAborted();
    if (response.status !== 'done') return { decision: 'deny', reason: getLabel('manager.toolPermission.judgeFailed', plan.language) };
    const raw: unknown = response.structuredOutput === undefined ? JSON.parse(response.content) : response.structuredOutput;
    const parsed = decisionSchema.safeParse(raw);
    if (!parsed.success) return { decision: 'deny', reason: getLabel('manager.toolPermission.judgeInvalidOutput', plan.language) };
    if (parsed.data.decision === 'allow') return { decision: 'allow' };
    if (!parsed.data.reason?.trim()) return { decision: 'deny', reason: getLabel('manager.toolPermission.judgeMissingReason', plan.language) };
    return { decision: parsed.data.decision, reason: sanitizeSensitiveText(parsed.data.reason.trim()) };
  } catch {
    return { decision: deadline.signal.aborted ? 'ask' : 'deny', reason: getLabel(deadline.signal.aborted
      ? 'manager.toolPermission.judgeTimeout'
      : signal.aborted ? 'manager.toolPermission.judgeInterrupted'
        : 'manager.toolPermission.judgeValidationFailed', plan.language) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
