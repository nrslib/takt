import type { SQLInputValue } from 'node:sqlite';

export interface FindingAuthorityReader {
  get<Row>(
    sql: string,
    ...parameters: SQLInputValue[]
  ): Row | undefined;
}

export function assertFindingContractEnabled(
  context: FindingAuthorityReader,
  runId: string,
): void {
  const row = context.get<{ enabled: number }>(`
    SELECT finding_contract_enabled AS enabled
    FROM runs
    WHERE run_id = ?
  `, runId);
  if (row === undefined) {
    throw new Error(`Run "${runId}" does not exist`);
  }
  if (row.enabled !== 1) {
    throw new Error(`Finding Contract is disabled for run "${runId}"`);
  }
}
