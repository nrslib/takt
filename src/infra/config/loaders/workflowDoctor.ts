import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import { resolveWorkflowConfigValue } from '../resolveWorkflowConfigValue.js';
import { getRepertoireDir } from '../paths.js';
import { loadWorkflowFromFile, loadWorkflowFromFileForDiscovery } from './workflowFileLoader.js';
import { validateDoctorGraph } from './workflowDoctorGraph.js';
import { validateWorkflowReferences } from './workflowDoctorRefValidator.js';
import type { WorkflowDiagnostic, WorkflowDoctorReport } from './workflowDoctorTypes.js';
import { formatWorkflowLoadWarning } from './workflowLoadWarning.js';
import { isMissingWorkflowCallArgError } from './workflowCallableArgResolver.js';
import { validateWorkflowCallContracts } from './workflowResolver.js';
import {
  type FacetResolutionContext,
  type WorkflowSections,
  resolveSectionMap,
} from './resource-resolver.js';

export type { WorkflowDiagnostic, WorkflowDoctorReport } from './workflowDoctorTypes.js';

type RawWorkflow = ReturnType<typeof WorkflowConfigRawSchema.parse>;

function buildContext(projectDir: string, filePath: string): FacetResolutionContext {
  return {
    lang: resolveWorkflowConfigValue(projectDir, 'language'),
    workflowDir: dirname(filePath),
    projectDir,
    repertoireDir: getRepertoireDir(),
  };
}

function buildSections(raw: RawWorkflow, workflowDir: string): WorkflowSections {
  return {
    personas: raw.personas,
    resolvedInstructions: resolveSectionMap(raw.instructions, workflowDir),
    resolvedKnowledge: resolveSectionMap(raw.knowledge, workflowDir),
    resolvedPolicies: resolveSectionMap(raw.policies, workflowDir),
    resolvedReportFormats: resolveSectionMap(raw.report_formats, workflowDir),
  };
}

function shouldIgnoreDoctorLoadError(raw: RawWorkflow, error: unknown): boolean {
  return raw.subworkflow?.callable === true && isMissingWorkflowCallArgError(error);
}

function loadWorkflowForDoctorValidation(
  filePath: string,
  projectDir: string,
  raw: RawWorkflow,
) {
  try {
    return loadWorkflowFromFile(filePath, projectDir);
  } catch (error) {
    if (!shouldIgnoreDoctorLoadError(raw, error)) {
      throw error;
    }
    return loadWorkflowFromFileForDiscovery(filePath, projectDir);
  }
}

export function inspectWorkflowFile(filePath: string, projectDir: string): WorkflowDoctorReport {
  try {
    const raw = WorkflowConfigRawSchema.parse(parseYaml(readFileSync(filePath, 'utf-8')));
    try {
      const workflow = loadWorkflowForDoctorValidation(filePath, projectDir, raw);
      validateWorkflowCallContracts(workflow, projectDir, projectDir, { allowPathBasedCalls: false });
    } catch (error) {
      return {
        diagnostics: [{ level: 'error', message: formatWorkflowLoadWarning(basename(filePath), error) }],
        filePath,
      };
    }

    const context = buildContext(projectDir, filePath);
    const sections = buildSections(raw, context.workflowDir!);
    const diagnostics: WorkflowDiagnostic[] = [];
    validateWorkflowReferences(raw, sections, context, diagnostics);
    validateDoctorGraph(raw, diagnostics);

    return {
      diagnostics,
      filePath,
    };
  } catch (error) {
    return {
      diagnostics: [{ level: 'error', message: formatWorkflowLoadWarning(basename(filePath), error) }],
      filePath,
    };
  }
}
