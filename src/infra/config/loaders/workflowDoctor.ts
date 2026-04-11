import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import type { WorkflowConfig } from '../../../core/models/index.js';
import { resolveWorkflowConfigValue } from '../resolveWorkflowConfigValue.js';
import { getRepertoireDir } from '../paths.js';
import { loadWorkflowFromFile } from './workflowFileLoader.js';
import { formatWorkflowLoadWarning } from './workflowLoadWarning.js';
import {
  type FacetResolutionContext,
  type WorkflowSections,
  isResourcePath,
  resolveFacetPath,
  resolvePersona,
  resolveSectionMap,
} from './resource-resolver.js';
import type { FacetType } from '../paths.js';

export type WorkflowDiagnostic = {
  level: 'error' | 'warning';
  message: string;
};

export type WorkflowDoctorReport = {
  diagnostics: WorkflowDiagnostic[];
  filePath: string;
};

type RawWorkflow = ReturnType<typeof WorkflowConfigRawSchema.parse>;
type RawStep = RawWorkflow['steps'][number];

const SPECIAL_NEXT = new Set(['COMPLETE', 'ABORT']);

function isNamedRef(ref: string): boolean {
  return !isResourcePath(ref) && !/\s/.test(ref);
}

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

function appendMissingRef(
  diagnostics: WorkflowDiagnostic[],
  label: string,
  ref: string | undefined,
  resolver: () => boolean,
): void {
  if (!ref) {
    return;
  }
  if (resolver()) {
    return;
  }
  diagnostics.push({
    level: 'error',
    message: `${label} references missing resource "${ref}"`,
  });
}

function canResolveNamedFacetRef(
  ref: string,
  localMap: Record<string, string> | undefined,
  facetType: FacetType,
  context: FacetResolutionContext,
): boolean {
  if (localMap?.[ref] !== undefined) {
    return true;
  }
  return resolveFacetPath(ref, facetType, context) !== undefined;
}

function validateScalarRefs(
  diagnostics: WorkflowDiagnostic[],
  label: string,
  refs: string | string[] | undefined,
  resolver: (ref: string) => boolean,
): void {
  if (refs === undefined) {
    return;
  }
  const list = Array.isArray(refs) ? refs : [refs];
  for (const ref of list) {
    if (resolver(ref)) {
      continue;
    }
    diagnostics.push({
      level: 'error',
      message: `${label} references missing resource "${ref}"`,
    });
  }
}

function collectStepEdges(config: WorkflowConfig): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const step of config.steps) {
    const nextSteps = new Set<string>();
    for (const rule of step.rules ?? []) {
      if (rule.next && !SPECIAL_NEXT.has(rule.next)) {
        nextSteps.add(rule.next);
      }
    }
    edges.set(step.name, nextSteps);
  }

  for (const monitor of config.loopMonitors ?? []) {
    const monitorTargets = monitor.judge.rules
      .map((rule) => rule.next)
      .filter((next): next is string => !SPECIAL_NEXT.has(next));

    for (const stepName of monitor.cycle) {
      const nextSteps = edges.get(stepName);
      if (!nextSteps) {
        continue;
      }
      for (const next of monitorTargets) {
        nextSteps.add(next);
      }
    }
  }

  return edges;
}

function collectReachableSteps(config: WorkflowConfig): Set<string> {
  const edges = collectStepEdges(config);
  const visited = new Set<string>();
  const queue = [config.initialStep];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current) || SPECIAL_NEXT.has(current)) {
      continue;
    }
    visited.add(current);
    for (const next of edges.get(current) ?? []) {
      if (!visited.has(next)) {
        queue.push(next);
      }
    }
  }

  return visited;
}

function collectUsedLocalKeys(raw: RawWorkflow): Record<'personas' | 'policies' | 'knowledge' | 'instructions' | 'report_formats', Set<string>> {
  const used = {
    instructions: new Set<string>(),
    knowledge: new Set<string>(),
    personas: new Set<string>(),
    policies: new Set<string>(),
    report_formats: new Set<string>(),
  };

  const collectStep = (step: RawStep): void => {
    if (step.persona && isNamedRef(step.persona)) {
      used.personas.add(step.persona);
    }
    if (step.team_leader?.persona && isNamedRef(step.team_leader.persona)) {
      used.personas.add(step.team_leader.persona);
    }
    if (step.team_leader?.part_persona && isNamedRef(step.team_leader.part_persona)) {
      used.personas.add(step.team_leader.part_persona);
    }

    if (step.instruction && isNamedRef(step.instruction)) {
      used.instructions.add(step.instruction);
    }

    const policyRefs = Array.isArray(step.policy) ? step.policy : step.policy ? [step.policy] : [];
    for (const ref of policyRefs) {
      if (isNamedRef(ref)) {
        used.policies.add(ref);
      }
    }

    const knowledgeRefs = Array.isArray(step.knowledge) ? step.knowledge : step.knowledge ? [step.knowledge] : [];
    for (const ref of knowledgeRefs) {
      if (isNamedRef(ref)) {
        used.knowledge.add(ref);
      }
    }

    for (const report of step.output_contracts?.report ?? []) {
      if (isNamedRef(report.format)) {
        used.report_formats.add(report.format);
      }
    }

    for (const sub of step.parallel ?? []) {
      collectStep(sub as RawStep);
    }
  };

  for (const step of raw.steps) {
    collectStep(step);
  }

  for (const monitor of raw.loop_monitors ?? []) {
    if (monitor.judge.persona && isNamedRef(monitor.judge.persona)) {
      used.personas.add(monitor.judge.persona);
    }
    if (monitor.judge.instruction && isNamedRef(monitor.judge.instruction)) {
      used.instructions.add(monitor.judge.instruction);
    }
  }

  return used;
}

function collectUnusedSectionWarnings(raw: RawWorkflow, diagnostics: WorkflowDiagnostic[]): void {
  const used = collectUsedLocalKeys(raw);
  const sections = [
    ['personas', raw.personas],
    ['policies', raw.policies],
    ['knowledge', raw.knowledge],
    ['instructions', raw.instructions],
    ['report_formats', raw.report_formats],
  ] as const;

  for (const [sectionName, sectionMap] of sections) {
    for (const key of Object.keys(sectionMap ?? {})) {
      if (used[sectionName].has(key)) {
        continue;
      }
      diagnostics.push({
        level: 'warning',
        message: `Unused ${sectionName} entry "${key}"`,
      });
    }
  }
}

function validateStepRefs(
  step: RawStep,
  sections: WorkflowSections,
  context: FacetResolutionContext,
  diagnostics: WorkflowDiagnostic[],
  label: string,
): void {
  const workflowDir = context.workflowDir!;
  if (step.persona && isNamedRef(step.persona)) {
    appendMissingRef(
      diagnostics,
      `${label} persona`,
      step.persona,
      () => sections.personas?.[step.persona!] !== undefined
        || resolvePersona(step.persona, sections, workflowDir, context).personaPath !== undefined,
    );
  }
  if (step.team_leader?.persona && isNamedRef(step.team_leader.persona)) {
    appendMissingRef(
      diagnostics,
      `${label} team_leader persona`,
      step.team_leader.persona,
      () => sections.personas?.[step.team_leader!.persona!] !== undefined
        || resolvePersona(step.team_leader!.persona, sections, workflowDir, context).personaPath !== undefined,
    );
  }
  if (step.team_leader?.part_persona && isNamedRef(step.team_leader.part_persona)) {
    appendMissingRef(
      diagnostics,
      `${label} team_leader part_persona`,
      step.team_leader.part_persona,
      () => sections.personas?.[step.team_leader!.part_persona!] !== undefined
        || resolvePersona(step.team_leader!.part_persona, sections, workflowDir, context).personaPath !== undefined,
    );
  }
  validateScalarRefs(
    diagnostics,
    `${label} policy`,
    Array.isArray(step.policy)
      ? step.policy.filter(isNamedRef)
      : step.policy && isNamedRef(step.policy) ? step.policy : undefined,
    (ref) => canResolveNamedFacetRef(ref, sections.resolvedPolicies, 'policies', context),
  );
  validateScalarRefs(
    diagnostics,
    `${label} knowledge`,
    Array.isArray(step.knowledge)
      ? step.knowledge.filter(isNamedRef)
      : step.knowledge && isNamedRef(step.knowledge) ? step.knowledge : undefined,
    (ref) => canResolveNamedFacetRef(ref, sections.resolvedKnowledge, 'knowledge', context),
  );
  if (step.instruction && isNamedRef(step.instruction)) {
    appendMissingRef(
      diagnostics,
      `${label} instruction`,
      step.instruction,
      () => canResolveNamedFacetRef(
        step.instruction!,
        sections.resolvedInstructions,
        'instructions',
        context,
      ),
    );
  }

  for (const report of step.output_contracts?.report ?? []) {
    if (isNamedRef(report.format)) {
      appendMissingRef(
        diagnostics,
        `${label} output_contract format`,
        report.format,
        () => canResolveNamedFacetRef(
          report.format,
          sections.resolvedReportFormats,
          'output-contracts',
          context,
        ),
      );
    }
  }

  for (const sub of step.parallel ?? []) {
    validateStepRefs(sub as RawStep, sections, context, diagnostics, `${label}/${sub.name}`);
  }
}

function validateLoopMonitorRefs(
  raw: RawWorkflow,
  sections: WorkflowSections,
  context: FacetResolutionContext,
  diagnostics: WorkflowDiagnostic[],
): void {
  const workflowDir = context.workflowDir!;
  for (const monitor of raw.loop_monitors ?? []) {
    const label = `loop monitor (${monitor.cycle.join(' -> ')})`;
    if (monitor.judge.persona && isNamedRef(monitor.judge.persona)) {
      appendMissingRef(
        diagnostics,
        `${label} persona`,
        monitor.judge.persona,
        () => sections.personas?.[monitor.judge.persona!] !== undefined
          || resolvePersona(monitor.judge.persona, sections, workflowDir, context).personaPath !== undefined,
      );
    }
    if (monitor.judge.instruction && isNamedRef(monitor.judge.instruction)) {
      appendMissingRef(
        diagnostics,
        `${label} instruction`,
        monitor.judge.instruction,
        () => canResolveNamedFacetRef(
          monitor.judge.instruction!,
          sections.resolvedInstructions,
          'instructions',
          context,
        ),
      );
    }
  }
}

function validateNextTargets(config: WorkflowConfig, raw: RawWorkflow, diagnostics: WorkflowDiagnostic[]): void {
  const stepNames = new Set(config.steps.map((step) => step.name));
  if (!stepNames.has(config.initialStep)) {
    diagnostics.push({
      level: 'error',
      message: `initial_step references missing step "${config.initialStep}"`,
    });
  }

  for (const step of config.steps) {
    for (const rule of step.rules ?? []) {
      if (!rule.next || SPECIAL_NEXT.has(rule.next) || stepNames.has(rule.next)) {
        continue;
      }
      diagnostics.push({
        level: 'error',
        message: `Step "${step.name}" routes to unknown next step "${rule.next}"`,
      });
    }

    for (const sub of step.parallel ?? []) {
      for (const rule of sub.rules ?? []) {
        if (!rule.next || SPECIAL_NEXT.has(rule.next) || stepNames.has(rule.next)) {
          continue;
        }
        diagnostics.push({
          level: 'error',
          message: `Step "${step.name}/${sub.name}" routes to unknown next step "${rule.next}"`,
        });
      }
    }
  }

  for (const monitor of raw.loop_monitors ?? []) {
    const label = monitor.cycle.join(' -> ');
    for (const rule of monitor.judge.rules) {
      if (!rule.next || SPECIAL_NEXT.has(rule.next) || stepNames.has(rule.next)) {
        continue;
      }
      diagnostics.push({
        level: 'error',
        message: `Loop monitor "${label}" routes to unknown next step "${rule.next}"`,
      });
    }
  }
}

function validateReachability(config: WorkflowConfig, diagnostics: WorkflowDiagnostic[]): void {
  const reachable = collectReachableSteps(config);
  const unreachable = config.steps
    .map((step) => step.name)
    .filter((name) => !reachable.has(name));

  if (unreachable.length === 0) {
    return;
  }

  diagnostics.push({
    level: 'error',
    message: `Unreachable steps: ${unreachable.join(', ')}`,
  });
}

export function inspectWorkflowFile(filePath: string, projectDir: string): WorkflowDoctorReport {
  let config: WorkflowConfig;
  try {
    config = loadWorkflowFromFile(filePath, projectDir);
  } catch (error) {
    return {
      diagnostics: [{ level: 'error', message: formatWorkflowLoadWarning(basename(filePath), error) }],
      filePath,
    };
  }

  const raw = WorkflowConfigRawSchema.parse(parseYaml(readFileSync(filePath, 'utf-8')));
  const context = buildContext(projectDir, filePath);
  const sections = buildSections(raw, context.workflowDir!);
  const diagnostics: WorkflowDiagnostic[] = [];

  for (const step of raw.steps) {
    validateStepRefs(step, sections, context, diagnostics, `step "${step.name}"`);
  }
  validateLoopMonitorRefs(raw, sections, context, diagnostics);
  validateNextTargets(config, raw, diagnostics);
  validateReachability(config, diagnostics);
  collectUnusedSectionWarnings(raw, diagnostics);

  return {
    diagnostics,
    filePath,
  };
}
