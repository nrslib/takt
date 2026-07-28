import type { FindingLedgerStore } from '../../core/workflow/findings/store.js';
import type { RunReadContext } from './context.js';
import { createRunFindingManagerStore } from './finding-manager-adapter.js';
import { readTrustedFindingResumeSource } from './finding-resume-source.js';
import {
  assertExactInput,
  type RuntimeBinding,
} from './runtime-binding.js';
import type { ExecutionHandle } from './runtime-handles.js';

export interface RuntimeFindingCommands {
  findingManager(input: {
    readonly workflowName: string;
    readonly producer: ExecutionHandle;
  }): FindingLedgerStore;
}

export function createRuntimeFindingCommands(
  binding: RuntimeBinding,
): RuntimeFindingCommands {
  return {
    findingManager(input): FindingLedgerStore {
      assertExactInput(input, ['workflowName', 'producer']);
      assertFindingEnabled(binding);
      const producer = binding.handles.resolveExecution(input.producer);
      if (producer.scopeId !== binding.scopeId) {
        throw new Error(
          'Finding producer execution handle is missing or cross-scope',
        );
      }
      assertProducerExecution(binding, producer);
      const { ledger, trustedResumeSource } = binding.executor.read((context) => {
        const resolvedLedger = readFindingAuthority(context, binding);
        return {
          ledger: resolvedLedger,
          trustedResumeSource: readTrustedFindingResumeSource(
            context,
            binding.runId,
            resolvedLedger.scopeId,
          ),
        };
      });
      if (ledger.workflowName !== input.workflowName) {
        throw new Error(
          `Finding authority workflow mismatch: expected "${input.workflowName}", got "${ledger.workflowName}"`,
        );
      }
      return createRunFindingManagerStore({
        executor: binding.executor,
        owner: binding.owner,
        runId: binding.runId,
        scopeId: ledger.scopeId,
        workflowName: input.workflowName,
        producerScopeId: producer.scopeId,
        producerExecutionId: producer.executionId,
        ...(trustedResumeSource !== undefined
          ? { trustedResumeSource }
          : {}),
      });
    },
  };
}

function assertFindingEnabled(binding: RuntimeBinding): void {
  const findingEnabled = binding.executor.read((context) => {
    const run = context.get<{ readonly enabled: number }>(`
      SELECT finding_contract_enabled AS enabled
      FROM runs
      WHERE run_id = ?
    `, binding.runId);
    if (run === undefined) {
      throw new Error(`Run "${binding.runId}" does not exist`);
    }
    return run.enabled === 1;
  });
  if (!findingEnabled) {
    throw new Error('Finding Contract is disabled');
  }
}

function assertProducerExecution(
  binding: RuntimeBinding,
  producer: {
    readonly scopeId: string;
    readonly executionId: string;
  },
): void {
  binding.executor.read((context) => {
    const producerRow = context.get<{ readonly found: number }>(`
      SELECT 1 AS found
      FROM step_executions
      WHERE run_id = ? AND scope_id = ? AND execution_id = ?
    `, binding.runId, producer.scopeId, producer.executionId);
    if (producerRow === undefined) {
      throw new Error(
        'Finding producer execution handle is missing or cross-scope',
      );
    }
  });
}

function readFindingAuthority(
  context: RunReadContext,
  binding: RuntimeBinding,
): { readonly scopeId: string; readonly workflowName: string } {
  const row = context.get<{
    readonly scopeId: string;
    readonly workflowName: string;
  }>(`
    WITH RECURSIVE authority_scope(
      scope_id,
      parent_scope_id,
      kind,
      authority_kind,
      distance
    ) AS (
      SELECT scope_id, parent_scope_id, kind, kind, 0
      FROM scopes
      WHERE run_id = ? AND scope_id = ?
      UNION ALL
      SELECT
        parent.scope_id,
        parent.parent_scope_id,
        parent.kind,
        child.authority_kind,
        child.distance + 1
      FROM scopes AS parent
      JOIN authority_scope AS child
        ON child.parent_scope_id = parent.scope_id
      WHERE parent.run_id = ?
    )
    SELECT
      heads.scope_id AS scopeId,
      heads.workflow_name AS workflowName
    FROM authority_scope
    JOIN finding_ledger_heads AS heads
      ON heads.run_id = ?
      AND heads.scope_id = authority_scope.scope_id
    WHERE
      authority_scope.distance = 0
      OR (
        authority_scope.authority_kind = 'workflow_call'
        AND authority_scope.distance > 0
      )
    ORDER BY authority_scope.distance
    LIMIT 1
  `, binding.runId, binding.scopeId, binding.runId, binding.runId);
  if (row === undefined) {
    throw new Error(
      `Finding ledger authority for "${binding.runId}/${binding.scopeId}" does not exist`,
    );
  }
  return row;
}
