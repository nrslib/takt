import { createHash } from 'node:crypto';

export interface ToolHealthStats {
  totalErrors: number;
  totalSuccesses: number;
  maxConsecutiveErrors: number;
  recentErrorRate: number;
  recentWindowSize: number;
  maxSameSignatureRepeats: number;
  toolEventsSinceLastProgress: number;
  recoveriesUsed: number;
}

export type ToolGuardFailure =
  | { kind: 'unavailable_tool_loop'; tool: string; fingerprint: string; message: string }
  | { kind: 'invalid_argument_loop'; tool: string; fingerprint: string; message: string }
  | { kind: 'edit_conflict_loop'; tool: 'edit'; signature: string; filePath: string; message: string }
  | { kind: 'tool_error_burst'; fingerprint: string; stats: ToolHealthStats; message: string }
  | { kind: 'exact_repeat_loop'; tool: string; fingerprint: string; message: string };

export function computeEditConflictSignature(filePath: string, oldString: string): string {
  return createHash('sha256').update(`${filePath}\0${oldString}`).digest('hex');
}

export interface ToolGuardRecoveryState {
  readonly correctionLimit: number;
  readonly correctionsUsed: number;
  readonly correctedFingerprints: readonly string[];
  readonly pendingCorrection?: {
    readonly sessionId: string;
    readonly fingerprint: string;
    readonly prompt: string;
  };
  readonly freshSessionUsed: boolean;
  readonly freshReason?: ToolGuardRecoverableKind;
}

export type ToolGuardRecoverableKind = ToolGuardFailure['kind'];
export type ToolGuardRecoverableFailure = ToolGuardFailure;

export function createToolGuardRecoveryState(correctionLimit: number): ToolGuardRecoveryState {
  return {
    correctionLimit,
    correctionsUsed: 0,
    correctedFingerprints: [],
    freshSessionUsed: false,
  };
}

export function shouldIssueToolGuardCorrection(
  state: ToolGuardRecoveryState,
  fingerprint: string,
): boolean {
  return !state.correctedFingerprints.includes(fingerprint)
    && state.correctionsUsed < state.correctionLimit;
}

export function markToolGuardCorrectionPending(
  state: ToolGuardRecoveryState,
  sessionId: string,
  fingerprint: string,
  prompt: string,
): ToolGuardRecoveryState {
  return {
    ...state,
    correctionsUsed: state.correctionsUsed + 1,
    correctedFingerprints: [...state.correctedFingerprints, fingerprint],
    pendingCorrection: { sessionId, fingerprint, prompt },
  };
}

export function clearToolGuardPendingCorrection(state: ToolGuardRecoveryState): ToolGuardRecoveryState {
  const cleared = { ...state };
  delete (cleared as { pendingCorrection?: unknown }).pendingCorrection;
  return cleared;
}

export function markToolGuardFreshSessionUsed(
  state: ToolGuardRecoveryState,
  reason: ToolGuardRecoverableKind,
): ToolGuardRecoveryState {
  return { ...clearToolGuardPendingCorrection(state), freshSessionUsed: true, freshReason: reason };
}

export function buildEditConflictCorrectionPrompt(filePath: string): string {
  return [
    `Your recent edit attempts on ${JSON.stringify(filePath)} keep failing because the oldString you provide does not exist in the file's current content.`,
    'Stop repeating the same oldString. Do the following instead:',
    `1. Re-read ${JSON.stringify(filePath)} to see its CURRENT content.`,
    '2. Base your next edit on what the file actually contains, narrowing oldString to a smaller, exactly-matching span.',
    '3. If a matching span still cannot be constructed, rewrite the affected region with the write tool after confirming the current content.',
    'Then continue the task you were working on.',
  ].join('\n');
}

export function buildToolGuardCorrectionPrompt(
  failure: ToolGuardRecoverableFailure,
  serverAvailableTools: readonly string[] | undefined,
): string {
  if (failure.kind === 'edit_conflict_loop') {
    return buildEditConflictCorrectionPrompt(failure.filePath);
  }
  if (failure.kind === 'unavailable_tool_loop') {
    const available = serverAvailableTools === undefined
      ? 'Use only tools currently available in this session.'
      : `Use only these available tools: ${serverAvailableTools.map((tool) => JSON.stringify(tool)).join(', ')}.`;
    return [
      `Your recent attempts repeatedly called unavailable tool ${JSON.stringify(failure.tool)}. Stop calling it.`,
      available,
      'Re-read the current task context and continue using valid tools only. Do not repeat the original prompt.',
    ].join('\n');
  }
  if (failure.kind === 'invalid_argument_loop') {
    return [
      `Your recent calls to ${JSON.stringify(failure.tool)} repeatedly used invalid arguments.`,
      'Stop repeating the same call. Re-read the tool requirements and current file state, then use a complete, correctly typed argument object.',
      'Continue the current task without repeating the original prompt.',
    ].join('\n');
  }
  if (failure.kind === 'exact_repeat_loop') {
    return [
      `Your recent calls to ${JSON.stringify(failure.tool)} repeated the same input and received the same result consecutively.`,
      'Stop calling that tool again. The work it was performing is already done.',
      'Output your final response as text now, summarizing what you have completed, and end the turn without making any further tool calls.',
    ].join('\n');
  }
  return [
    'Your recent tool calls are failing repeatedly without progress.',
    'Pause, re-read the current task and relevant workspace state, then make one deliberate valid tool call instead of repeating the failing pattern.',
    'Continue the current task without repeating the original prompt.',
  ].join('\n');
}

export function buildToolGuardRetryPrompt(
  prompt: string,
  reason: ToolGuardRecoverableKind,
): string {
  return [
    'A previous session already worked on this task in the same workspace.',
    buildFreshRecoveryReason(reason),
    'IMPORTANT: the workspace already contains partially completed work from that session. Do NOT overwrite or discard it.',
    'Re-read any file you intend to modify FIRST, and base every edit on the file\'s current content (never on remembered content).',
    'If an edit\'s oldString does not match, re-read the file and narrow the span instead of retrying the same string.',
    '',
    prompt,
  ].join('\n');
}

function buildFreshRecoveryReason(reason: ToolGuardRecoverableKind): string {
  switch (reason) {
    case 'edit_conflict_loop':
      return 'Your previous session kept failing the same edit because its oldString did not match the file content.';
    case 'unavailable_tool_loop':
      return 'Your previous session repeatedly called an unavailable tool.';
    case 'invalid_argument_loop':
      return 'Your previous session repeatedly called a tool with invalid arguments.';
    case 'exact_repeat_loop':
      return 'Your previous session kept repeating the same tool call with identical input and result instead of producing a final response.';
    case 'tool_error_burst':
      return 'Your previous session degraded into a burst of failing tool calls without making progress.';
  }
}
