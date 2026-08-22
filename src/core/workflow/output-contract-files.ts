import type { OutputContractEntry } from '../models/types.js';

export function getReportFiles(outputContracts: OutputContractEntry[] | undefined): string[] {
  if (!outputContracts || outputContracts.length === 0) return [];
  return outputContracts.map((entry) => entry.name);
}

export function getJudgmentReportFiles(outputContracts: OutputContractEntry[] | undefined): string[] {
  if (!outputContracts || outputContracts.length === 0) return [];
  return outputContracts
    .filter((entry) => entry.useJudge !== false)
    .map((entry) => entry.name);
}
