import type { OpenCodeStreamEvent, OpenCodeToolPart } from '../OpenCodeStreamHandler.js';
import {
  computeToolInputHash,
  computeToolResultHash,
  createToolTerminalTupleFromHashes,
} from '../tool-call-tuple.js';
import type { ToolHealthStats } from '../tool-guard.js';
import {
  extractOpenCodeToolRejection,
  isCompletedToolFailure,
  isOpenCodeToolTerminal,
  openCodeToolCallKey,
  readOpenCodeToolPart,
  toolTerminalResult,
} from './tool-events.js';
import type { ToolOutcomeTuple } from './types.js';

interface ToolCallRecord {
  inputHash?: string;
  terminal?: ToolOutcomeTuple;
}

export interface ToolOutcomeLedgerResult {
  outcome?: ToolOutcomeTuple;
  anomalyReason?: string;
  duplicate: boolean;
}

export class ToolOutcomeLedger {
  private readonly toolCalls = new Map<string, ToolCallRecord>();

  observe(event: OpenCodeStreamEvent): ToolOutcomeLedgerResult {
    const toolPart = readOpenCodeToolPart(event);
    return toolPart === undefined ? { duplicate: false } : this.observeToolPart(toolPart);
  }

  private observeToolPart(toolPart: OpenCodeToolPart): ToolOutcomeLedgerResult {
    const namespace = openCodeToolCallKey(toolPart);
    const record = this.toolCalls.get(namespace) ?? {};
    const inputHash = computeToolInputHash(toolPart.state.input);
    if (inputHash !== undefined) record.inputHash = inputHash;
    if (!isOpenCodeToolTerminal(toolPart)) {
      this.toolCalls.set(namespace, record);
      return { duplicate: false };
    }
    const resultHash = computeToolResultHash(toolTerminalResult(toolPart));
    if (record.inputHash === undefined || resultHash === undefined) return { duplicate: false };
    const outcome = extractOpenCodeToolRejection(toolPart) !== undefined || isCompletedToolFailure(toolPart)
      ? 'failure'
      : 'success';
    const tuple = createToolTerminalTupleFromHashes(toolPart.tool, outcome, record.inputHash, resultHash);
    const resolved: ToolOutcomeTuple = {
      ...tuple,
      sessionId: toolPart.sessionID,
      callId: toolPart.callID || toolPart.id,
    };
    if (record.terminal !== undefined) {
      return record.terminal.identityKey === resolved.identityKey
        ? { duplicate: true }
        : {
            duplicate: true,
            anomalyReason: `OpenCode contradictory terminal tool update for call "${resolved.callId}"`,
          };
    }
    record.terminal = resolved;
    this.toolCalls.set(namespace, record);
    return { outcome: resolved, duplicate: false };
  }
}

export class ToolHealthTracker {
  private totalErrors = 0;
  private totalSuccesses = 0;
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 0;
  private toolEventsSinceLastProgress = 0;
  private lastTupleKey: string | undefined;
  private currentTupleRepeats = 0;
  private maxTupleRepeats = 0;
  private recoveriesUsed = 0;

  observe(outcome: ToolOutcomeTuple): void {
    if (outcome.outcome === 'success') {
      this.totalSuccesses += 1;
      this.consecutiveErrors = 0;
      this.toolEventsSinceLastProgress = 0;
    } else {
      this.totalErrors += 1;
      this.consecutiveErrors += 1;
      this.maxConsecutiveErrors = Math.max(this.maxConsecutiveErrors, this.consecutiveErrors);
      this.toolEventsSinceLastProgress += 1;
    }
    this.currentTupleRepeats = outcome.key === this.lastTupleKey ? this.currentTupleRepeats + 1 : 1;
    this.lastTupleKey = outcome.key;
    this.maxTupleRepeats = Math.max(this.maxTupleRepeats, this.currentTupleRepeats);
  }

  noteRecovery(): void {
    this.recoveriesUsed += 1;
  }

  stats(): ToolHealthStats {
    return {
      totalErrors: this.totalErrors,
      totalSuccesses: this.totalSuccesses,
      maxConsecutiveErrors: this.maxConsecutiveErrors,
      recentErrorRate: 0,
      recentWindowSize: 0,
      maxSameSignatureRepeats: this.maxTupleRepeats,
      toolEventsSinceLastProgress: this.toolEventsSinceLastProgress,
      recoveriesUsed: this.recoveriesUsed,
    };
  }
}
