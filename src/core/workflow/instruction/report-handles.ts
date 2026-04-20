import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowStep } from '../../models/types.js';
import { getReportFiles } from '../evaluation/rule-utils.js';

const REPORT_HISTORY_PATTERN = /^(?<base>.+)\.(?<timestamp>\d{8}T\d{6}Z)(?:\.(?<sequence>\d+))?$/;

interface ReportHistoryEntry {
  readonly path: string;
  readonly timestamp: string;
  readonly sequence: number;
}

interface ResolvedReportHandles {
  readonly currentReport: string;
  readonly previousReport: string;
  readonly reportHistory: string;
  readonly peerReports: string;
}

interface ReportHandleResolverContext {
  readonly step: WorkflowStep;
  readonly reportDir: string;
  readonly workflowSteps: ReadonlyArray<WorkflowStep>;
}

export function resolveReportHandles(context: ReportHandleResolverContext): ResolvedReportHandles {
  const currentReportPaths = resolveCurrentReportPaths(context.reportDir, context.step);
  const stepReportFiles = getReportFiles(context.step.outputContracts);
  const historyByFile = stepReportFiles.map((fileName) => resolveReportHistory(context.reportDir, fileName));
  const peerReportPaths = resolvePeerSteps(context.step, context.workflowSteps)
    .flatMap((peerStep) => resolveCurrentReportPaths(context.reportDir, peerStep));

  return {
    currentReport: currentReportPaths.join('\n'),
    previousReport: historyByFile
      .map((entries) => entries[0]?.path)
      .filter((path): path is string => path !== undefined)
      .join('\n'),
    reportHistory: historyByFile
      .flatMap((entries) => entries.map((entry) => entry.path))
      .join('\n'),
    peerReports: peerReportPaths.join('\n'),
  };
}

function resolveCurrentReportPaths(reportDir: string, step: WorkflowStep): string[] {
  return getReportFiles(step.outputContracts)
    .map((fileName) => join(reportDir, fileName))
    .filter((filePath) => existsSync(filePath));
}

function resolvePeerSteps(step: WorkflowStep, workflowSteps: ReadonlyArray<WorkflowStep>): WorkflowStep[] {
  const parallelParent = findParallelParentStep(step.name, workflowSteps);
  if (parallelParent?.parallel) {
    return parallelParent.parallel.filter((peerStep) => peerStep.name !== step.name);
  }

  const currentIndex = workflowSteps.findIndex((candidate) => candidate.name === step.name);
  if (currentIndex === -1) {
    return [];
  }

  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = workflowSteps[index]!;
    const peerSteps = candidate.parallel?.filter(hasReportOutputs);
    if (peerSteps && peerSteps.length > 0) {
      return peerSteps;
    }
  }

  return [];
}

function findParallelParentStep(
  stepName: string,
  workflowSteps: ReadonlyArray<WorkflowStep>,
): WorkflowStep | undefined {
  return workflowSteps.find((candidate) =>
    candidate.parallel?.some((parallelStep) => parallelStep.name === stepName),
  );
}

function hasReportOutputs(step: WorkflowStep): boolean {
  return getReportFiles(step.outputContracts).length > 0;
}

function resolveReportHistory(reportDir: string, fileName: string): ReportHistoryEntry[] {
  if (!existsSync(reportDir)) {
    return [];
  }

  return readdirSync(reportDir)
    .map((entryName) => parseHistoryEntry(reportDir, fileName, entryName))
    .filter((entry): entry is ReportHistoryEntry => entry !== undefined)
    .sort(compareHistoryEntries);
}

function parseHistoryEntry(
  reportDir: string,
  fileName: string,
  entryName: string,
): ReportHistoryEntry | undefined {
  const match = REPORT_HISTORY_PATTERN.exec(entryName);
  if (!match?.groups || match.groups.base !== fileName || !match.groups.timestamp) {
    return undefined;
  }

  return {
    path: join(reportDir, entryName),
    timestamp: match.groups.timestamp,
    sequence: Number.parseInt(match.groups.sequence ?? '0', 10),
  };
}

function compareHistoryEntries(left: ReportHistoryEntry, right: ReportHistoryEntry): number {
  if (left.timestamp !== right.timestamp) {
    return right.timestamp.localeCompare(left.timestamp);
  }
  return right.sequence - left.sequence;
}
