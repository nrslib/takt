import type { FindingLedgerStore } from '../../core/workflow/findings/store.js';
import type {
  RunStorageExecutor,
  RuntimeBinding,
  RuntimeHandleAuthority,
} from './runtime-binding.js';
import {
  createRuntimeExecutionCommands,
  type RuntimeExecutionCommands,
} from './runtime-execution-facade.js';
import { createRuntimeFindingCommands } from './runtime-finding-facade.js';
import {
  createRuntimeOperationCommands,
  type RuntimeOperationCommands,
} from './runtime-operation-facade.js';
import {
  createRuntimeReportCommands,
  type RuntimeReportCommands,
} from './runtime-report-facade.js';
import {
  createRuntimeScopeCommands,
  type RuntimeScopeCommands,
} from './runtime-scope-facade.js';
import {
  createRuntimeSequenceCommands,
  type RuntimeSequenceCommands,
} from './runtime-sequence-facade.js';
import {
  createRuntimeSessionCommands,
  type RuntimeSessionCommands,
} from './runtime-session-facade.js';
import {
  createRuntimeValueCommands,
  type RuntimeValueCommands,
} from './runtime-value-facade.js';
import type { LeaseOwner } from './lease.js';
import type { ExecutionHandle } from './runtime-handles.js';
import { ScopeRepository } from './scopes.js';

export type {
  RunStorageExecutor,
  RuntimeHandleAuthority,
} from './runtime-binding.js';

export interface RunStorageRuntime {
  readonly scopes: RuntimeScopeCommands;
  readonly execution: RuntimeExecutionCommands;
  readonly runtimeValues: RuntimeValueCommands;
  readonly sequences: RuntimeSequenceCommands;
  readonly reports: RuntimeReportCommands;
  readonly sessions: RuntimeSessionCommands;
  readonly operations: RuntimeOperationCommands;
  findingManager(input: {
    readonly workflowName: string;
    readonly producer: ExecutionHandle;
  }): FindingLedgerStore;
}

export function createBoundRunStorageRuntime(input: {
  readonly executor: RunStorageExecutor;
  readonly handles: RuntimeHandleAuthority;
  readonly owner: LeaseOwner;
  readonly runId: string;
  readonly scopeId: string;
}): RunStorageRuntime {
  const binding: RuntimeBinding = {
    executor: input.executor,
    handles: input.handles,
    owner: input.owner,
    runId: input.runId,
    scopeId: input.scopeId,
  };
  assertScopeExists(binding);
  const finding = createRuntimeFindingCommands(binding);
  return {
    scopes: createRuntimeScopeCommands(binding),
    execution: createRuntimeExecutionCommands(binding),
    runtimeValues: createRuntimeValueCommands(binding),
    sequences: createRuntimeSequenceCommands(binding),
    reports: createRuntimeReportCommands(binding),
    sessions: createRuntimeSessionCommands(binding),
    operations: createRuntimeOperationCommands(binding),
    findingManager: (findingInput) => finding.findingManager(findingInput),
  };
}

function assertScopeExists(binding: RuntimeBinding): void {
  const repository = new ScopeRepository();
  binding.executor.read((context) => {
    repository.get(context, binding.runId, binding.scopeId);
  });
}
