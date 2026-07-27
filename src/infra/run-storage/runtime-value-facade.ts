import { sha256 } from './canonical-json.js';
import {
  assertExactInput,
  type RuntimeBinding,
} from './runtime-binding.js';
import type {
  PersonaSessionHandle,
  RecoveryHandle,
} from './runtime-handles.js';
import { RuntimeValueRepository } from './runtime-values.js';

class BoundRuntimeValueCommands {
  readonly #binding: RuntimeBinding;
  readonly #repository = new RuntimeValueRepository();

  constructor(binding: RuntimeBinding) {
    this.#binding = binding;
  }

  recordSystemContext(input: {
    readonly contextKey: string;
    readonly codecName: string;
    readonly content: string;
  }): string {
    assertExactInput(input, ['contextKey', 'codecName', 'content']);
    const contextId = this.deriveId('system-context', input.contextKey);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.recordSystemContext(context, {
        ...input,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        contextId,
        createdAt: now,
      }),
    );
    return contextId;
  }

  recordEffectResult(input: {
    readonly effectKey: string;
    readonly effectType: string;
    readonly codecName: string;
    readonly result: string;
  }): string {
    assertExactInput(input, ['effectKey', 'effectType', 'codecName', 'result']);
    const effectId = this.deriveId('effect', input.effectKey);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.recordEffectResult(context, {
        ...input,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        effectId,
        recordedAt: now,
      }),
    );
    return effectId;
  }

  recordUserInput(input: {
    readonly inputKey: string;
    readonly codecName: string;
    readonly content: string;
  }): string {
    assertExactInput(input, ['inputKey', 'codecName', 'content']);
    const inputId = this.deriveId('user-input', input.inputKey);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.recordUserInput(context, {
        ...input,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        inputId,
        receivedAt: now,
      }),
    );
    return inputId;
  }

  startPersonaSession(input: {
    readonly sessionKey: string;
    readonly personaName: string;
  }): PersonaSessionHandle {
    assertExactInput(input, ['sessionKey', 'personaName']);
    const sessionId = this.deriveId('persona-session', input.sessionKey);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.startPersonaSession(context, {
        ...input,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        personaSessionId: sessionId,
        startedAt: now,
      }),
    );
    return this.#binding.handles.issuePersonaSession(
      this.#binding.scopeId,
      sessionId,
    );
  }

  appendPersonaSessionRevision(input: {
    readonly personaSession: PersonaSessionHandle;
    readonly expectedRevision: number;
    readonly codecName: string;
    readonly content: string;
  }): number {
    assertExactInput(input, [
      'personaSession',
      'expectedRevision',
      'codecName',
      'content',
    ]);
    const session = this.resolvePersonaSession(input.personaSession);
    return this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.appendPersonaSessionRevision(context, {
        personaSessionId: session.sessionId,
        expectedRevision: input.expectedRevision,
        codecName: input.codecName,
        content: input.content,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        recordedAt: now,
      }),
    );
  }

  endPersonaSession(personaSession: PersonaSessionHandle): void {
    const session = this.resolvePersonaSession(personaSession);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.endPersonaSession(context, {
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        personaSessionId: session.sessionId,
        endedAt: now,
      }),
    );
  }

  recordFallbackAttempt(input: {
    readonly attemptKey: string;
    readonly source: string;
    readonly target: string;
    readonly reason: string;
  }): string {
    assertExactInput(input, ['attemptKey', 'source', 'target', 'reason']);
    const attemptId = this.deriveId('fallback-attempt', input.attemptKey);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.recordFallbackAttempt(context, {
        ...input,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        attemptId,
        attemptedAt: now,
      }),
    );
    return attemptId;
  }

  createRecoveryItem(input: {
    readonly recoveryKey: string;
    readonly itemType: string;
    readonly codecName: string;
    readonly content: string;
  }): RecoveryHandle {
    assertExactInput(input, ['recoveryKey', 'itemType', 'codecName', 'content']);
    const recoveryId = sha256([
      this.#binding.runId,
      this.#binding.scopeId,
      input.recoveryKey,
    ].join('\0'));
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.createRecoveryItem(context, {
        ...input,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        recoveryItemId: recoveryId,
        createdAt: now,
      }),
    );
    return this.#binding.handles.issueRecovery(
      this.#binding.scopeId,
      recoveryId,
    );
  }

  resolveRecoveryItem(input: {
    readonly recovery: RecoveryHandle;
    readonly status: 'applied' | 'rejected';
  }): void {
    assertExactInput(input, ['recovery', 'status']);
    const recovery = this.#binding.handles.resolveRecovery(input.recovery);
    this.assertScope(recovery.scopeId);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.resolveRecoveryItem(context, {
        recoveryItemId: recovery.recoveryId,
        status: input.status,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        terminalAt: now,
      }),
    );
  }

  private deriveId(kind: string, key: string): string {
    return sha256([
      this.#binding.runId,
      this.#binding.scopeId,
      kind,
      key,
    ].join('\0'));
  }

  private resolvePersonaSession(handle: PersonaSessionHandle): {
    readonly scopeId: string;
    readonly sessionId: string;
  } {
    const session = this.#binding.handles.resolvePersonaSession(handle);
    this.assertScope(session.scopeId);
    return session;
  }

  private assertScope(scopeId: string): void {
    if (scopeId !== this.#binding.scopeId) {
      throw new Error('Runtime value handle cross-scope reference rejected');
    }
  }
}

export type RuntimeValueCommands = BoundRuntimeValueCommands;

export function createRuntimeValueCommands(
  binding: RuntimeBinding,
): RuntimeValueCommands {
  return new BoundRuntimeValueCommands(binding);
}
