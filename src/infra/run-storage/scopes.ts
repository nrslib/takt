import type { RunReadContext, RunWriteContext } from './context.js';
import { assertCodecContent } from './codec-contract.js';
import { sha256 } from './canonical-json.js';
import { bootstrapFindingAuthority } from './finding-ledger.js';

export type ScopeKind = 'root' | 'workflow_call' | 'parallel';
export type ScopeRuntimeStatus =
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ScopeRecord {
  readonly runId: string;
  readonly scopeId: string;
  readonly parentScopeId: string | null;
  readonly kind: ScopeKind;
  readonly workflowDefinitionId: string;
  readonly findingContractEnabled: boolean;
  readonly createdAt: number;
  readonly terminalAt: number | null;
  readonly currentStepId: string | null;
  readonly status: ScopeRuntimeStatus;
  readonly revision: number;
  readonly eventSequence: number;
  readonly responseSequence: number;
  readonly updatedAt: number;
}

type ScopeRow = Omit<ScopeRecord, 'findingContractEnabled'> & {
  readonly findingContractEnabled: number;
};

function scopeRecordFromRow(row: ScopeRow): ScopeRecord {
  if (
    row.findingContractEnabled !== 0
    && row.findingContractEnabled !== 1
  ) {
    throw new Error(
      `Scope "${row.runId}/${row.scopeId}" has invalid Finding Contract state`,
    );
  }
  return {
    ...row,
    findingContractEnabled: row.findingContractEnabled === 1,
  };
}

function scopeSelect(): string {
  return `
    SELECT
      scopes.run_id AS runId,
      scopes.scope_id AS scopeId,
      scopes.parent_scope_id AS parentScopeId,
      scopes.kind,
      scopes.workflow_definition_id AS workflowDefinitionId,
      scopes.finding_contract_enabled AS findingContractEnabled,
      scopes.created_at AS createdAt,
      scopes.terminal_at AS terminalAt,
      runtime.current_step_id AS currentStepId,
      runtime.status,
      runtime.revision,
      (
        SELECT count(*) FROM run_events
        WHERE run_id = scopes.run_id AND scope_id = scopes.scope_id
      ) AS eventSequence,
      (
        SELECT count(*) FROM response_snapshots
        WHERE run_id = scopes.run_id AND scope_id = scopes.scope_id
      ) AS responseSequence,
      runtime.updated_at AS updatedAt
    FROM scopes
    JOIN scope_runtime AS runtime USING (run_id, scope_id)
  `;
}

function definitionIdentity(input: {
  readonly name: string;
  readonly codecName: string;
  readonly definition: string;
}): { readonly definitionId: string; readonly digest: string } {
  assertCodecContent(input.codecName, input.definition);
  const digest = sha256(input.definition);
  return {
    definitionId: sha256([input.name, input.codecName, digest].join('\0')),
    digest,
  };
}

function isTerminal(status: ScopeRuntimeStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export class ScopeRepository {
  registerWorkflowDefinition(context: RunWriteContext, input: {
    readonly name: string;
    readonly codecName: string;
    readonly definition: string;
  }): string {
    const identity = definitionIdentity(input);
    const existing = context.get<{ readonly digest: string }>(`
      SELECT digest FROM workflow_definitions WHERE definition_id = ?
    `, identity.definitionId);
    if (existing !== undefined) {
      if (existing.digest !== identity.digest) {
        throw new Error(`Workflow definition "${identity.definitionId}" collision`);
      }
      return identity.definitionId;
    }
    context.run(`
      INSERT INTO workflow_definitions (
        definition_id, name, codec_name, definition, digest
      ) VALUES (?, ?, ?, ?, ?)
    `,
    identity.definitionId,
    input.name,
    input.codecName,
    input.definition,
    identity.digest);
    return identity.definitionId;
  }

  get(context: RunReadContext, runId: string, scopeId: string): ScopeRecord {
    const scope = this.find(context, runId, scopeId);
    if (scope === undefined) {
      throw new Error(`Scope "${runId}/${scopeId}" does not exist`);
    }
    return scope;
  }

  find(
    context: RunReadContext,
    runId: string,
    scopeId: string,
  ): ScopeRecord | undefined {
    const row = context.get<ScopeRow>(`
      ${scopeSelect()}
      WHERE scopes.run_id = ? AND scopes.scope_id = ?
    `, runId, scopeId);
    return row === undefined ? undefined : scopeRecordFromRow(row);
  }

  list(context: RunReadContext, runId: string): ScopeRecord[] {
    return context.all<ScopeRow>(`
      ${scopeSelect()}
      WHERE scopes.run_id = ?
      ORDER BY scopes.created_at, scopes.scope_id
    `, runId).map(scopeRecordFromRow);
  }

  terminalizeActiveDescendants(
    context: RunWriteContext,
    input: {
      readonly runId: string;
      readonly status: Extract<
        ScopeRuntimeStatus,
        'completed' | 'failed' | 'cancelled'
      >;
      readonly terminalAt: number;
    },
  ): void {
    const descendants = context.all<ScopeRecord & { readonly depth: number }>(`
      WITH RECURSIVE scope_tree(scope_id, depth) AS (
        SELECT scope_id, 0
        FROM scopes
        WHERE run_id = ? AND kind = 'root'
        UNION ALL
        SELECT child.scope_id, parent.depth + 1
        FROM scopes AS child
        JOIN scope_tree AS parent
          ON child.parent_scope_id = parent.scope_id
        WHERE child.run_id = ?
      )
      SELECT scope_records.*, scope_tree.depth
      FROM scope_tree
      JOIN (${scopeSelect()}) AS scope_records
        ON scope_records.scopeId = scope_tree.scope_id
      WHERE
        scope_records.runId = ?
        AND scope_tree.depth > 0
        AND scope_records.status IN ('ready', 'running')
      ORDER BY scope_tree.depth DESC, scope_records.scopeId
    `, input.runId, input.runId, input.runId);
    for (const descendant of descendants) {
      this.terminalize(context, {
        runId: input.runId,
        scopeId: descendant.scopeId,
        expectedRevision: descendant.revision,
        expectedStatus: descendant.status as Extract<
          ScopeRuntimeStatus,
          'ready' | 'running'
        >,
        status: input.status,
        terminalAt: input.terminalAt,
      });
    }
  }

  createChild(context: RunWriteContext, input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly parentScopeId: string;
    readonly kind: Exclude<ScopeKind, 'root'>;
    readonly workflowDefinitionId: string;
    readonly findingContractEnabled?: boolean;
    readonly createdAt: number;
  }): void {
    const parent = this.get(context, input.runId, input.parentScopeId);
    if (parent.terminalAt !== null || isTerminal(parent.status)) {
      throw new Error(`Terminal parent scope "${parent.scopeId}" cannot create children`);
    }
    if (
      input.kind === 'parallel'
      && input.workflowDefinitionId !== parent.workflowDefinitionId
    ) {
      throw new Error(`Parallel scope "${input.scopeId}" must use parent workflow definition`);
    }
    const ownsFindingAuthority = input.kind === 'parallel'
      ? parent.findingContractEnabled
      : input.findingContractEnabled === true;
    if (ownsFindingAuthority) {
      context.run(`
        UPDATE runs
        SET finding_contract_enabled = 1
        WHERE run_id = ? AND finding_contract_enabled = 0
      `, input.runId);
    }
    context.run(`
      INSERT INTO scopes (
        run_id,
        scope_id,
        parent_scope_id,
        kind,
        workflow_definition_id,
        finding_contract_enabled,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    input.runId,
    input.scopeId,
    input.parentScopeId,
    input.kind,
    input.workflowDefinitionId,
    ownsFindingAuthority ? 1 : 0,
    input.createdAt);
    context.run(`
      INSERT INTO scope_runtime (
        run_id, scope_id, status, updated_at
      ) VALUES (?, ?, 'ready', ?)
    `, input.runId, input.scopeId, input.createdAt);
    const finding = context.get<{
      readonly workflowName: string;
    }>(`
      SELECT
        definitions.name AS workflowName
      FROM workflow_definitions AS definitions
      WHERE definitions.definition_id = ?
    `, input.workflowDefinitionId);
    if (finding !== undefined && ownsFindingAuthority) {
      bootstrapFindingAuthority(context, {
        runId: input.runId,
        scopeId: input.scopeId,
        workflowName: finding.workflowName,
        createdAt: input.createdAt,
      });
    }
  }

  transitionRuntime(context: RunWriteContext, input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly expectedRevision: number;
    readonly expectedStatus: ScopeRuntimeStatus;
    readonly status: ScopeRuntimeStatus;
    readonly currentStepId: string | null;
    readonly updatedAt: number;
  }): number {
    const current = this.get(context, input.runId, input.scopeId);
    if (isTerminal(current.status)) {
      throw new Error(`Terminal scope "${input.scopeId}" cannot transition`);
    }
    const result = context.run(`
      UPDATE scope_runtime
      SET
        current_step_id = ?,
        status = ?,
        revision = revision + 1,
        updated_at = ?
      WHERE
        run_id = ?
        AND scope_id = ?
        AND revision = ?
        AND status = ?
    `,
    input.currentStepId,
    input.status,
    input.updatedAt,
    input.runId,
    input.scopeId,
    input.expectedRevision,
    input.expectedStatus);
    if (Number(result.changes) !== 1) {
      throw new Error(`Scope runtime CAS mismatch for "${input.runId}/${input.scopeId}"`);
    }
    return input.expectedRevision + 1;
  }

  terminalize(context: RunWriteContext, input: {
    readonly runId: string;
    readonly scopeId: string;
    readonly expectedRevision: number;
    readonly expectedStatus: Extract<ScopeRuntimeStatus, 'ready' | 'running'>;
    readonly status: Extract<ScopeRuntimeStatus, 'completed' | 'failed' | 'cancelled'>;
    readonly terminalAt: number;
  }): void {
    const current = this.get(context, input.runId, input.scopeId);
    if (current.kind === 'root') {
      throw new Error('Root scope terminal state is owned by run terminalization');
    }
    if (isTerminal(current.status) || current.terminalAt !== null) {
      throw new Error(`Scope terminal CAS mismatch for "${input.runId}/${input.scopeId}"`);
    }
    const result = context.run(`
      UPDATE scope_runtime
      SET
        status = ?,
        revision = revision + 1,
        updated_at = ?
      WHERE
        run_id = ?
        AND scope_id = ?
        AND revision = ?
        AND status = ?
    `,
    input.status,
    input.terminalAt,
    input.runId,
    input.scopeId,
    input.expectedRevision,
    input.expectedStatus);
    if (Number(result.changes) !== 1) {
      throw new Error(`Scope terminal CAS mismatch for "${input.runId}/${input.scopeId}"`);
    }
  }
}
