import {
  createRunOperationCommands,
  OperationRepository,
  type RunOperationCommands,
} from './operations.js';
import type { OperationRecord } from './operation-record.js';
import {
  assertExactInput,
  type RuntimeBinding,
} from './runtime-binding.js';
import type {
  OperationHandle,
  PreparedOperation,
  RuntimeOperationSnapshot,
} from './runtime-handles.js';
import { sha256 } from './canonical-json.js';

class BoundOperationCommands {
  readonly #binding: RuntimeBinding;
  readonly #reader = new OperationRepository();

  constructor(binding: RuntimeBinding) {
    this.#binding = binding;
  }

  prepareOrLoad(input: {
    readonly idempotencyKey: string;
    readonly kind: string;
    readonly request: { readonly codecName: string; readonly content: string };
  }): PreparedOperation {
    assertExactInput(input, ['idempotencyKey', 'kind', 'request']);
    assertExactInput(input.request, ['codecName', 'content']);
    const operationId = sha256([
      this.#binding.runId,
      this.#binding.scopeId,
      input.idempotencyKey,
      input.kind,
    ].join('\0'));
    const operation = this.run((commands) => commands.prepareOrLoad({
      operationId,
      runId: this.#binding.runId,
      scopeId: this.#binding.scopeId,
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      request: {
        codecName: input.request.codecName,
        encoded: input.request.content,
      },
    }));
    return {
      handle: this.#binding.handles.issueOperation(
        this.#binding.scopeId,
        operation.operationId,
      ),
      state: operation.state,
    };
  }

  get(handle: OperationHandle): RuntimeOperationSnapshot {
    const operationId = this.operationId(handle);
    return this.#binding.executor.read((context) => this.project(
      this.assertBound(this.#reader.get(context, operationId)),
    ));
  }

  claimPrepared(handle: OperationHandle): void {
    const operationId = this.operationId(handle);
    this.runBound(operationId, (commands) => (
      commands.claimPrepared({ operationId })
    ));
  }

  recordResponse(input: {
    readonly operation: OperationHandle;
    readonly response: { readonly codecName: string; readonly content: string };
  }): void {
    assertExactInput(input, ['operation', 'response']);
    assertExactInput(input.response, ['codecName', 'content']);
    const operationId = this.operationId(input.operation);
    this.runBound(operationId, (commands) => commands.recordResponse({
      operationId,
      response: {
        codecName: input.response.codecName,
        encoded: input.response.content,
      },
    }));
  }

  markApplied(handle: OperationHandle): void {
    const operationId = this.operationId(handle);
    this.runBound(operationId, (commands) => commands.markApplied({ operationId }));
  }

  markFailed(input: {
    readonly operation: OperationHandle;
    readonly error: { readonly codecName: string; readonly content: string };
  }): void {
    assertExactInput(input, ['operation', 'error']);
    assertExactInput(input.error, ['codecName', 'content']);
    const operationId = this.operationId(input.operation);
    this.runBound(operationId, (commands) => commands.markFailed({
      operationId,
      error: {
        codecName: input.error.codecName,
        encoded: input.error.content,
      },
    }));
  }

  cancelPrepared(handle: OperationHandle): void {
    const operationId = this.operationId(handle);
    this.runBound(
      operationId,
      (commands) => commands.cancelPrepared({ operationId }),
    );
  }

  recoverAfterDispatchCrash(handle: OperationHandle): void {
    const operationId = this.operationId(handle);
    this.runBound(
      operationId,
      (commands) => commands.recoverAfterDispatchCrash({ operationId }),
    );
  }

  takeOverForRecovery(handle: OperationHandle): RuntimeOperationSnapshot {
    const operationId = this.operationId(handle);
    return this.project(this.runBound(
      operationId,
      (commands) => commands.takeOverForRecovery({ operationId }),
    ));
  }

  private runBound<Result>(
    operationId: string,
    command: (commands: RunOperationCommands) => Result,
  ): Result {
    return this.run((commands) => {
      this.assertBound(commands.get(operationId));
      return command(commands);
    });
  }

  private operationId(handle: OperationHandle): string {
    const operation = this.#binding.handles.resolveOperation(handle);
    if (operation.scopeId !== this.#binding.scopeId) {
      throw new Error('Operation handle cross-scope reference rejected');
    }
    return operation.operationId;
  }

  private assertBound(operation: OperationRecord): OperationRecord {
    if (
      operation.runId !== this.#binding.runId
      || operation.scopeId !== this.#binding.scopeId
    ) {
      throw new Error(
        `Operation "${operation.operationId}" cross-scope reference rejected`,
      );
    }
    return operation;
  }

  private project(operation: OperationRecord): RuntimeOperationSnapshot {
    return {
      idempotencyKey: operation.idempotencyKey,
      kind: operation.kind,
      state: operation.state,
      request: operation.request,
      ...(operation.response === undefined ? {} : { response: operation.response }),
      ...(operation.error === undefined ? {} : { error: operation.error }),
    };
  }

  private run<Result>(
    command: (commands: RunOperationCommands) => Result,
  ): Result {
    return this.#binding.executor.operation(
      this.#binding.owner,
      (context, now) => {
        const commands = createRunOperationCommands(
          context,
          this.#binding.owner,
          { now: () => now },
        );
        return command(commands);
      },
    );
  }
}

export type RuntimeOperationCommands = BoundOperationCommands;

export function createRuntimeOperationCommands(
  binding: RuntimeBinding,
): RuntimeOperationCommands {
  return new BoundOperationCommands(binding);
}
