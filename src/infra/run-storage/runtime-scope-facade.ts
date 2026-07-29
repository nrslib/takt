import { sha256 } from './canonical-json.js';
import {
  assertExactInput,
  type RuntimeBinding,
} from './runtime-binding.js';
import type { ScopeHandle } from './runtime-handles.js';
import {
  ScopeRepository,
  type ScopeRecord,
  type ScopeRuntimeStatus,
} from './scopes.js';

class BoundScopeCommands {
  readonly #binding: RuntimeBinding;
  readonly #repository = new ScopeRepository();

  constructor(binding: RuntimeBinding) {
    this.#binding = binding;
  }

  get(): ScopeRecord {
    return this.#binding.executor.read((context) => (
      this.#repository.get(context, this.#binding.runId, this.#binding.scopeId)
    ));
  }

  list(): ScopeRecord[] {
    return this.#binding.executor.read((context) => (
      this.#repository.list(context, this.#binding.runId)
    ));
  }

  createParallelChild(input: { readonly scopeKey: string }): ScopeHandle {
    assertExactInput(input, ['scopeKey']);
    const scopeId = this.deriveChildScopeId('parallel', input.scopeKey);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => {
        this.#repository.createChild(context, {
          runId: this.#binding.runId,
          scopeId,
          parentScopeId: this.#binding.scopeId,
          kind: 'parallel',
          createdAt: now,
        });
      },
    );
    return this.#binding.handles.issueScope(scopeId);
  }

  resolveParallelChild(input: { readonly scopeKey: string }): ScopeHandle {
    assertExactInput(input, ['scopeKey']);
    const scopeId = this.deriveChildScopeId('parallel', input.scopeKey);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => {
        const existing = this.#repository.find(
          context,
          this.#binding.runId,
          scopeId,
        );
        if (existing !== undefined) {
          const parent = this.#repository.get(
            context,
            this.#binding.runId,
            this.#binding.scopeId,
          );
          if (
            existing.parentScopeId !== this.#binding.scopeId
            || existing.kind !== 'parallel'
          ) {
            throw new Error(`Parallel scope identity "${scopeId}" does not match`);
          }
          if (
            parent.findingContractEnabled
            && !existing.findingContractEnabled
          ) {
            this.#repository.promoteFindingContract(
              context,
              this.#binding.runId,
              scopeId,
            );
          }
          return;
        }
        this.#repository.createChild(context, {
          runId: this.#binding.runId,
          scopeId,
          parentScopeId: this.#binding.scopeId,
          kind: 'parallel',
          createdAt: now,
        });
      },
    );
    return this.#binding.handles.issueScope(scopeId);
  }

  createWorkflowCallChild(input: {
    readonly scopeKey: string;
    readonly findingContractEnabled?: boolean;
  }): ScopeHandle {
    assertExactInput(input, [
      'scopeKey',
      'findingContractEnabled',
    ]);
    const scopeId = this.deriveChildScopeId('workflow_call', input.scopeKey);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => {
        this.#repository.createChild(context, {
          runId: this.#binding.runId,
          scopeId,
          parentScopeId: this.#binding.scopeId,
          kind: 'workflow_call',
          findingContractEnabled: input.findingContractEnabled === true,
          createdAt: now,
        });
      },
    );
    return this.#binding.handles.issueScope(scopeId);
  }

  resolveWorkflowCallChild(input: {
    readonly scopeKey: string;
    readonly findingContractEnabled?: boolean;
  }): ScopeHandle {
    assertExactInput(input, [
      'scopeKey',
      'findingContractEnabled',
    ]);
    const scopeId = this.deriveChildScopeId('workflow_call', input.scopeKey);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => {
        const existing = this.#repository.find(
          context,
          this.#binding.runId,
          scopeId,
        );
        if (existing !== undefined) {
          if (
            existing.parentScopeId !== this.#binding.scopeId
            || existing.kind !== 'workflow_call'
          ) {
            throw new Error(`Workflow-call scope identity "${scopeId}" does not match`);
          }
          if (
            input.findingContractEnabled === true
            && !existing.findingContractEnabled
          ) {
            this.#repository.promoteFindingContract(
              context,
              this.#binding.runId,
              scopeId,
            );
          }
          return;
        }
        this.#repository.createChild(context, {
          runId: this.#binding.runId,
          scopeId,
          parentScopeId: this.#binding.scopeId,
          kind: 'workflow_call',
          findingContractEnabled: input.findingContractEnabled === true,
          createdAt: now,
        });
      },
    );
    return this.#binding.handles.issueScope(scopeId);
  }

  transition(input: {
    readonly expectedRevision: number;
    readonly expectedStatus: Extract<ScopeRuntimeStatus, 'ready' | 'running'>;
    readonly status: 'running';
    readonly currentStepId: string | null;
  }): number {
    assertExactInput(input, [
      'expectedRevision',
      'expectedStatus',
      'status',
      'currentStepId',
    ]);
    return this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.transitionRuntime(context, {
        ...input,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        updatedAt: now,
      }),
    );
  }

  terminalize(input: {
    readonly expectedRevision: number;
    readonly expectedStatus: Extract<ScopeRuntimeStatus, 'ready' | 'running'>;
    readonly status: 'completed' | 'failed' | 'cancelled';
  }): void {
    assertExactInput(input, ['expectedRevision', 'expectedStatus', 'status']);
    this.#binding.executor.write(
      this.#binding.owner,
      (context, now) => this.#repository.terminalize(context, {
        ...input,
        runId: this.#binding.runId,
        scopeId: this.#binding.scopeId,
        terminalAt: now,
      }),
    );
  }

  private deriveChildScopeId(kind: string, scopeKey: string): string {
    return sha256([
      this.#binding.scopeId,
      kind,
      scopeKey,
    ].join('\0'));
  }
}

export type RuntimeScopeCommands = BoundScopeCommands;

export function createRuntimeScopeCommands(
  binding: RuntimeBinding,
): RuntimeScopeCommands {
  return new BoundScopeCommands(binding);
}
