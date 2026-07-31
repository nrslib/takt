import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import {
  type FacetResolutionContext,
  type WorkflowSections,
  isResourcePath,
  resolveFacetPath,
  resolvePersona,
} from './resource-resolver.js';
import { isWorkflowParamReference } from './workflowCallableArgResolver.js';
import type { FacetType } from '../paths.js';
import type { WorkflowDiagnostic } from './workflowDoctorTypes.js';
import { enumerateParallelSubSteps } from './workflowParallelTraversal.js';
type RawWorkflow = ReturnType<typeof WorkflowConfigRawSchema.parse>;
type RawStep = RawWorkflow['steps'][number];
type RawParamDefinition = NonNullable<NonNullable<RawWorkflow['subworkflow']>['params']>[string];
type RawFacetParamDefinition = Extract<RawParamDefinition, { type: 'facet_ref' | 'facet_ref[]' }>;
type RawFacetParamType = RawFacetParamDefinition['type'];
function isNamedRef(ref: string): boolean {
  return !isResourcePath(ref) && !/\s/.test(ref);
}

function appendMissingRef(
  diagnostics: WorkflowDiagnostic[],
  label: string,
  ref: string | undefined,
  resolver: () => boolean,
  path: readonly PropertyKey[],
): void {
  if (!ref || resolver()) {
    return;
  }
  diagnostics.push({
    level: 'error',
    message: `${label} references missing resource "${ref}"`,
    path,
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

function collectNamedRefs(refs: string | string[] | undefined): string[] {
  if (refs === undefined) {
    return [];
  }
  const list = Array.isArray(refs) ? refs : [refs];
  return list.filter(isNamedRef);
}

function getParamDefinition(
  raw: RawWorkflow,
  value: unknown,
  expectedTypes: readonly RawFacetParamType[],
  expectedKind: RawFacetParamDefinition['facet_kind'],
): RawFacetParamDefinition | undefined {
  if (!isWorkflowParamReference(value)) {
    return undefined;
  }
  const definition = raw.subworkflow?.params?.[value.$param];
  if (!definition) {
    return undefined;
  }
  if (
    definition.type === 'workflow_ref'
    || !expectedTypes.includes(definition.type)
    || definition.facet_kind !== expectedKind
  ) {
    return undefined;
  }
  return definition;
}

function collectNamedRefsFromField(
  raw: RawWorkflow,
  value: unknown,
  expectedTypes: readonly RawFacetParamType[],
  expectedKind: RawFacetParamDefinition['facet_kind'],
): string[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => {
    if (typeof entry === 'string') {
      return isNamedRef(entry) ? [entry] : [];
    }
    const definition = getParamDefinition(raw, entry, expectedTypes, expectedKind);
    return definition?.default === undefined ? [] : collectNamedRefs(definition.default);
  });
}

function validateScalarRefs(
  diagnostics: WorkflowDiagnostic[],
  label: string,
  refs: string | string[] | undefined,
  resolver: (ref: string) => boolean,
  path: readonly PropertyKey[],
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
      path,
    });
  }
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
    for (const ref of collectNamedRefsFromField(raw, step.persona, ['facet_ref'], 'persona')) {
      used.personas.add(ref);
    }
    if (step.team_leader?.persona && isNamedRef(step.team_leader.persona)) {
      used.personas.add(step.team_leader.persona);
    }
    if (step.team_leader?.part_persona && isNamedRef(step.team_leader.part_persona)) {
      used.personas.add(step.team_leader.part_persona);
    }

    for (const ref of collectNamedRefsFromField(raw, step.instruction, ['facet_ref'], 'instruction')) {
      used.instructions.add(ref);
    }
    for (const ref of collectNamedRefsFromField(raw, step.policy, ['facet_ref', 'facet_ref[]'], 'policy')) {
      used.policies.add(ref);
    }
    for (const ref of collectNamedRefsFromField(raw, step.knowledge, ['facet_ref', 'facet_ref[]'], 'knowledge')) {
      used.knowledge.add(ref);
    }
    for (const report of step.output_contracts?.report ?? []) {
      for (const ref of collectNamedRefsFromField(raw, report.format, ['facet_ref'], 'report_format')) {
        used.report_formats.add(ref);
      }
    }
    const parallelSubSteps = step.parallel === undefined
      ? []
      : enumerateParallelSubSteps(step.parallel, []);
    for (const { subStep: sub } of parallelSubSteps) {
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
  raw: RawWorkflow,
  step: RawStep,
  sections: WorkflowSections,
  context: FacetResolutionContext,
  diagnostics: WorkflowDiagnostic[],
  label: string,
  stepPath: readonly PropertyKey[],
): void {
  const workflowDir = context.workflowDir!;
  for (const ref of collectNamedRefsFromField(raw, step.persona, ['facet_ref'], 'persona')) {
    appendMissingRef(
      diagnostics,
      `${label} persona`,
      ref,
      () => sections.personas?.[ref] !== undefined
        || resolvePersona(ref, sections, workflowDir, context).personaPath !== undefined,
      [...stepPath, 'persona'],
    );
  }
  if (step.team_leader?.persona && isNamedRef(step.team_leader.persona)) {
    appendMissingRef(
      diagnostics,
      `${label} team_leader persona`,
      step.team_leader.persona,
      () => sections.personas?.[step.team_leader!.persona!] !== undefined
        || resolvePersona(step.team_leader!.persona, sections, workflowDir, context).personaPath !== undefined,
      [...stepPath, 'team_leader', 'persona'],
    );
  }
  if (step.team_leader?.part_persona && isNamedRef(step.team_leader.part_persona)) {
    appendMissingRef(
      diagnostics,
      `${label} team_leader part_persona`,
      step.team_leader.part_persona,
      () => sections.personas?.[step.team_leader!.part_persona!] !== undefined
        || resolvePersona(step.team_leader!.part_persona, sections, workflowDir, context).personaPath !== undefined,
      [...stepPath, 'team_leader', 'part_persona'],
    );
  }
  validateScalarRefs(
    diagnostics,
    `${label} policy`,
    collectNamedRefsFromField(raw, step.policy, ['facet_ref', 'facet_ref[]'], 'policy'),
    (ref) => canResolveNamedFacetRef(ref, sections.resolvedPolicies, 'policies', context),
    [...stepPath, 'policy'],
  );
  validateScalarRefs(
    diagnostics,
    `${label} knowledge`,
    collectNamedRefsFromField(raw, step.knowledge, ['facet_ref', 'facet_ref[]'], 'knowledge'),
    (ref) => canResolveNamedFacetRef(ref, sections.resolvedKnowledge, 'knowledge', context),
    [...stepPath, 'knowledge'],
  );
  for (const ref of collectNamedRefsFromField(raw, step.instruction, ['facet_ref'], 'instruction')) {
    appendMissingRef(
      diagnostics,
      `${label} instruction`,
      ref,
      () => canResolveNamedFacetRef(ref, sections.resolvedInstructions, 'instructions', context),
      [...stepPath, 'instruction'],
    );
  }
  for (const [reportIndex, report] of (step.output_contracts?.report ?? []).entries()) {
    for (const ref of collectNamedRefsFromField(raw, report.format, ['facet_ref'], 'report_format')) {
      appendMissingRef(
        diagnostics,
        `${label} output_contract format`,
        ref,
        () => canResolveNamedFacetRef(ref, sections.resolvedReportFormats, 'output-contracts', context),
        [...stepPath, 'output_contracts', 'report', reportIndex, 'format'],
      );
    }
  }
  const parallelSubSteps = step.parallel === undefined
    ? []
    : enumerateParallelSubSteps(step.parallel, [...stepPath, 'parallel']);
  for (const { subStep: sub, path } of parallelSubSteps) {
    validateStepRefs(
      raw,
      sub as RawStep,
      sections,
      context,
      diagnostics,
      `${label}/${sub.name}`,
      path,
    );
  }
}

function validateLoopMonitorRefs(
  raw: RawWorkflow,
  sections: WorkflowSections,
  context: FacetResolutionContext,
  diagnostics: WorkflowDiagnostic[],
): void {
  const workflowDir = context.workflowDir!;
  for (const [monitorIndex, monitor] of (raw.loop_monitors ?? []).entries()) {
    const label = `loop monitor (${monitor.cycle.join(' -> ')})`;
    if (monitor.judge.persona && isNamedRef(monitor.judge.persona)) {
      appendMissingRef(
        diagnostics,
        `${label} persona`,
        monitor.judge.persona,
        () => sections.personas?.[monitor.judge.persona!] !== undefined
          || resolvePersona(monitor.judge.persona, sections, workflowDir, context).personaPath !== undefined,
        ['loop_monitors', monitorIndex, 'judge', 'persona'],
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
        ['loop_monitors', monitorIndex, 'judge', 'instruction'],
      );
    }
  }
}

export function validateWorkflowReferences(
  raw: RawWorkflow,
  sections: WorkflowSections,
  context: FacetResolutionContext,
  diagnostics: WorkflowDiagnostic[],
): void {
  for (const [stepIndex, step] of raw.steps.entries()) {
    validateStepRefs(raw, step, sections, context, diagnostics, `step "${step.name}"`, ['steps', stepIndex]);
  }
  validateLoopMonitorRefs(raw, sections, context, diagnostics);
  collectUnusedSectionWarnings(raw, diagnostics);
}
