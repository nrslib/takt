import { dirname } from 'node:path';
import { parseScopeRef } from 'faceted-prompting';
import type { WorkflowConfig } from '../../core/models/types.js';
import { validateWorkflowReportReferences } from '../../core/workflow/instruction/report-reference-validation.js';
import type { WorkflowDoctorReport, WorkflowDoctorTarget } from '../../infra/config/loaders/workflowDoctor.js';
import { loadWorkflowForRuntimeValidation } from '../../infra/config/loaders/workflowDoctor.js';
import { collectValidatedWorkflowEntries, iterateWorkflowDir, listRepertoireWorkflowEntries, type WorkflowDirEntry } from '../../infra/config/loaders/workflowDiscovery.js';
import { findWorkflowInLookupDirs, getNamedWorkflowLookupDirs, resolveWorkflowFile } from '../../infra/config/loaders/workflowLookupDirectories.js';
import { resolveWorkflowCallTarget } from '../../infra/config/loaders/workflowCallResolver.js';

function discoverCandidates(target: WorkflowDoctorTarget, projectDir: string): WorkflowConfig[] {
  const lookupCwd = target.lookupCwd ?? projectDir;
  const lookupDirs = getNamedWorkflowLookupDirs(lookupCwd);
  const names = new Set(lookupDirs.flatMap(({ dir, source, disabled }) =>
    [...iterateWorkflowDir(dir, source, disabled)].map((entry) => entry.name),
  ));
  const entries: WorkflowDirEntry[] = [];
  for (const name of names) {
    const match = findWorkflowInLookupDirs(name, lookupDirs);
    if (match !== null) entries.push({ name, path: match.filePath, source: match.source });
  }
  for (const entry of listRepertoireWorkflowEntries()) {
    if (names.has(entry.name)) continue;
    names.add(entry.name);
    const filePath = resolveWorkflowFile(dirname(entry.path), parseScopeRef(entry.name).name);
    if (filePath !== null) entries.push({ ...entry, path: filePath });
  }
  return collectValidatedWorkflowEntries(
    entries,
    projectDir,
    undefined,
    (entry) => loadWorkflowForRuntimeValidation({ filePath: entry.path, source: entry.source, lookupCwd }, projectDir),
    true,
  ).map(({ config }) => config);
}

export function warnOnUnproducibleReportReferences(
  report: WorkflowDoctorReport,
  workflow: WorkflowConfig,
  target: WorkflowDoctorTarget,
  projectDir: string,
): void {
  const lookupCwd = target.lookupCwd ?? projectDir;
  report.diagnostics.push(...validateWorkflowReportReferences(
    workflow,
    ({ parentWorkflow, step, projectCwd, lookupCwd }) =>
      resolveWorkflowCallTarget(parentWorkflow, step, projectCwd, lookupCwd),
    {
      projectCwd: projectDir,
      lookupCwd,
      ...(workflow.subworkflow?.callable === true
        ? { callerCandidates: discoverCandidates(target, projectDir) }
        : {}),
    },
  ));
}
