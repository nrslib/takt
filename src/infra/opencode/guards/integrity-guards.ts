import type {
  OpenCodePart,
  OpenCodeStreamEvent,
  OpenCodeToolPart,
} from '../OpenCodeStreamHandler.js';
import {
  computeEditConflictSignature,
  type ToolGuardRecoverableFailure,
} from '../tool-guard.js';
import {
  InvalidToolArgumentLoopDetector,
  UnavailableToolLoopDetector,
} from '../unavailable-tool-loop.js';
import type { ResolvedOpenCodeGuardPolicy } from './policy.js';
import { extractOpenCodeToolRejection } from './tool-events.js';
import type {
  OpenCodeGuard,
  OpenCodeGuardLifecycleScope,
  OpenCodeGuardVerdict,
  ToolOutcomeTuple,
} from './types.js';

function extractEditConflictInput(input: unknown): { filePath: string; oldString: string } | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  return typeof record.filePath === 'string'
    && record.filePath.length > 0
    && typeof record.oldString === 'string'
    ? { filePath: record.filePath, oldString: record.oldString }
    : undefined;
}

export class ExactLoopGuard implements OpenCodeGuard {
  readonly id = 'exact-loop';
  readonly layer = 'integrity' as const;
  private readonly unavailableDetector = new UnavailableToolLoopDetector();
  private readonly invalidArgumentDetector = new InvalidToolArgumentLoopDetector();
  private readonly editConflictCounts = new Map<string, number>();
  private readonly observedErrors = new Set<string>();
  private recoveryFailure: ToolGuardRecoverableFailure | undefined;

  constructor(private readonly policy: ResolvedOpenCodeGuardPolicy) {}

  start(scope: OpenCodeGuardLifecycleScope): void {
    if (scope !== 'attempt') return;
    this.unavailableDetector.reset();
    this.invalidArgumentDetector.reset();
    this.editConflictCounts.clear();
  }

  onEvent(event: OpenCodeStreamEvent): OpenCodeGuardVerdict | undefined {
    if (event.type !== 'message.part.updated') return undefined;
    const part = event.properties.part as OpenCodePart;
    if (part.type === 'text' || part.type === 'reasoning') {
      this.unavailableDetector.reset();
      return undefined;
    }
    if (part.type !== 'tool') return undefined;
    const toolPart = part as OpenCodeToolPart;
    const rejection = extractOpenCodeToolRejection(toolPart);
    if (rejection === undefined) return undefined;
    const callId = `${toolPart.sessionID}\0${toolPart.callID || toolPart.id}`;
    if (this.observedErrors.has(callId)) return undefined;
    this.observedErrors.add(callId);
    return this.observeRejection(callId, rejection.tool, rejection.error, toolPart.state.input);
  }

  onToolOutcome(outcome: ToolOutcomeTuple): OpenCodeGuardVerdict | undefined {
    if (outcome.outcome !== 'success') return undefined;
    this.unavailableDetector.reset();
    this.invalidArgumentDetector.reset();
    this.editConflictCounts.clear();
    return undefined;
  }

  takeRecoveryFailure(): ToolGuardRecoverableFailure | undefined {
    const failure = this.recoveryFailure;
    this.recoveryFailure = undefined;
    return failure;
  }

  private observeRejection(
    callId: string,
    tool: string,
    message: string,
    input: unknown,
  ): OpenCodeGuardVerdict | undefined {
    const unavailable = this.unavailableDetector.observe(callId, tool, message);
    const invalidArgument = this.invalidArgumentDetector.observe(callId, tool, message);
    if (unavailable !== undefined) {
      return this.fail({
        kind: 'unavailable_tool_loop',
        tool: unavailable.tool,
        fingerprint: `unavailable:${unavailable.tool.toLowerCase()}`,
        message: unavailable.message,
      });
    }
    if (invalidArgument !== undefined) {
      return this.fail({
        kind: 'invalid_argument_loop',
        tool,
        fingerprint: `invalid:${tool.toLowerCase()}`,
        message: invalidArgument,
      });
    }
    return this.observeEditConflict(tool, input);
  }

  private observeEditConflict(tool: string, input: unknown): OpenCodeGuardVerdict | undefined {
    const editInput = tool.toLowerCase() === 'edit' ? extractEditConflictInput(input) : undefined;
    if (editInput === undefined) return undefined;
    const signature = computeEditConflictSignature(editInput.filePath, editInput.oldString);
    const count = (this.editConflictCounts.get(signature) ?? 0) + 1;
    this.editConflictCounts.set(signature, count);
    if (count < this.policy.toolGuard.editConflictRepeats) return undefined;
    return this.fail({
      kind: 'edit_conflict_loop',
      tool: 'edit',
      signature,
      filePath: editInput.filePath,
      message: `OpenCode edit conflict loop detected: the same edit (signature ${signature.slice(0, 12)}, file "${editInput.filePath}") failed ${count} times with an oldString that does not match the file content`,
    });
  }

  private fail(failure: ToolGuardRecoverableFailure): OpenCodeGuardVerdict {
    this.recoveryFailure = failure;
    return { action: 'fail', reason: failure.message };
  }
}

export class ExactRepeatStreakGuard implements OpenCodeGuard {
  readonly id = 'exact-repeat-streak';
  readonly layer = 'heuristic' as const;
  private lastKey: string | undefined;
  private streak = 0;

  constructor(private readonly limit: number) {}

  onToolOutcome(outcome: ToolOutcomeTuple): OpenCodeGuardVerdict | undefined {
    this.streak = outcome.key === this.lastKey ? this.streak + 1 : 1;
    this.lastKey = outcome.key;
    if (this.streak < this.limit) return undefined;
    return {
      action: 'fail',
      reason: `OpenCode exact tool outcome repeated ${this.streak} consecutive times for tool "${outcome.tool}"`,
    };
  }
}
