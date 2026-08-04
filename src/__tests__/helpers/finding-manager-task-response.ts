import type { AgentResponse } from '../../core/models/types.js';
import type { FindingManagerDecisions } from '../../core/workflow/findings/types.js';

export interface ManagerTaskManifest {
  taskId: string;
  candidateIntents?: Array<{
    intentId: string;
    kind: 'dispute' | 'conflict' | 'invalidate' | 'dismiss';
    entityId: string;
  }>;
  rawFindings?: Array<{ rawFindingId: string; componentId: string }>;
}

export function findingManagerTaskManifest(instruction: string): ManagerTaskManifest {
  const heading = '## Task manifest\n';
  const start = instruction.indexOf(heading);
  const match = start < 0
    ? null
    : /^(`{3,})json\n([\s\S]*?)\n\1/m.exec(
      instruction.slice(start + heading.length),
    );
  if (match?.[2] === undefined) {
    throw new Error('Manager task manifest not found');
  }
  return JSON.parse(match[2]) as ManagerTaskManifest;
}

export function findingManagerTaskResponse(
  instruction: string,
  decisions: FindingManagerDecisions,
): AgentResponse {
  const manifest = findingManagerTaskManifest(instruction);
  if (manifest.rawFindings !== undefined) {
    const byRawId = new Map(
      decisions.rawDecisions.map((decision) => [decision.rawFindingId, decision]),
    );
    return {
      status: 'done',
      content: '',
      structuredOutput: {
        taskId: manifest.taskId,
        decisions: manifest.rawFindings.flatMap((raw) => {
          const decision = byRawId.get(raw.rawFindingId);
          return decision === undefined ? [] : [{
            ...decision,
            componentId: raw.componentId,
            findingId: decision.findingId ?? '',
          }];
        }),
      },
    } as unknown as AgentResponse;
  }

  const resultForIntent = (
    intent: NonNullable<ManagerTaskManifest['candidateIntents']>[number],
  ) => {
    switch (intent.kind) {
      case 'dispute': {
        const decision = decisions.disputeDecisions.find(
          (item) => item.findingId === intent.entityId,
        );
        return decision === undefined
          ? { kind: 'no_action', reason: 'No action selected' }
          : {
              kind: decision.decision,
              findingId: decision.findingId,
              reason: decision.reason,
              evidence: decision.evidence,
            };
      }
      case 'conflict': {
        const decision = decisions.conflictDecisions.find(
          (item) => item.conflictId === intent.entityId,
        );
        return decision === undefined
          ? { kind: 'no_action', reason: 'No action selected' }
          : {
              kind: decision.decision,
              conflictId: decision.conflictId,
              evidence: decision.evidence,
            };
      }
      case 'invalidate': {
        const decision = decisions.invalidateDecisions.find(
          (item) => item.findingId === intent.entityId,
        );
        return decision === undefined
          ? { kind: 'no_action', reason: 'No action selected' }
          : { kind: 'invalidate', ...decision };
      }
      case 'dismiss': {
        const decision = decisions.dismissDecisions.find(
          (item) => item.findingId === intent.entityId,
        );
        return decision === undefined
          ? { kind: 'no_action', reason: 'No action selected' }
          : { kind: 'dismiss', ...decision };
      }
      default:
        return { kind: 'no_action', reason: 'No action selected' };
    }
  };
  const candidates = (manifest.candidateIntents ?? []).map((intent) => ({
    intent,
    result: resultForIntent(intent),
  }));
  const selected = candidates.find((candidate) => candidate.result.kind !== 'no_action');
  return {
    status: 'done',
    content: '',
    structuredOutput: {
      taskId: manifest.taskId,
      evaluations: candidates.map(({ intent, result }) => ({
        intentId: intent.intentId,
        result: selected?.intent.intentId === intent.intentId
          ? result
          : { kind: 'no_action', reason: 'Another candidate intent was selected' },
      })),
      selectedIntentId: selected?.intent.intentId ?? null,
    },
  } as unknown as AgentResponse;
}
