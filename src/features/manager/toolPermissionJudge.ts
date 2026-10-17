import { z } from 'zod/v4';
import { executeIsolatedStructuredInternalAgent, type ResolvedInternalAgentOptions } from '../../agents/agent-usecases.js';
import type { ToolPermissionDecisionRequest } from '../../core/workflow/types.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { toStrictManagerOutputSchema } from './outputSchema.js';

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

type Judgment = { decision: 'allow' } | { decision: 'deny' | 'ask'; reason: string };

export async function judgeManagerToolPermission(
  plan: ManagerPermissionJudgePlan,
  request: ToolPermissionDecisionRequest,
  turn: { instruction: string; goal?: ManagerPermissionGoal; abortSignal: AbortSignal },
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
    if (response.status !== 'done') return { decision: 'deny', reason: '道具の判断役の実行に失敗したため拒否しました。' };
    const raw: unknown = response.structuredOutput === undefined ? JSON.parse(response.content) : response.structuredOutput;
    const parsed = decisionSchema.safeParse(raw);
    if (!parsed.success) return { decision: 'deny', reason: '道具の判断役の出力が不正なため拒否しました。' };
    if (parsed.data.decision === 'allow') return { decision: 'allow' };
    if (!parsed.data.reason?.trim()) return { decision: 'deny', reason: '道具の判断役が理由を返さなかったため拒否しました。' };
    return { decision: parsed.data.decision, reason: sanitizeSensitiveText(parsed.data.reason.trim()) };
  } catch {
    return { decision: 'deny', reason: deadline.signal.aborted
      ? '道具の判断役が30秒の期限を超えたため拒否しました。'
      : signal.aborted ? '道具の判断が中断されたため拒否しました。'
        : '道具の判断役の実行または出力の検証に失敗したため拒否しました。' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
