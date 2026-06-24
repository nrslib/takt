import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import { getWorkflowStepKind } from '../../../core/models/workflow-step-kind.js';
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
type RawWorkflow = ReturnType<typeof WorkflowConfigRawSchema.parse>;
type RawStep = RawWorkflow['steps'][number];
type RawParamDefinition = NonNullable<NonNullable<RawWorkflow['subworkflow']>['params']>[string];
type RawParamType = RawParamDefinition['type'];
type WorkflowUsedLocalFacetKeys = Record<'personas' | 'policies' | 'knowledge' | 'instructions' | 'report_formats', Set<string>>;
export type WorkflowFacetReference = {
  section: keyof WorkflowUsedLocalFacetKeys;
  ref: string;
};
export type WorkflowCallReference = {
  call: string;
  stepName: string;
};
function isNamedRef(ref: string): boolean {
  return !isResourcePath(ref) && !/\s/.test(ref);
}

function appendMissingRef(
  diagnostics: WorkflowDiagnostic[],
  label: string,
  ref: string | undefined,
  resolver: () => boolean,
): void {
  if (!ref || resolver()) {
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
  expectedTypes: readonly RawParamType[],
  expectedKind: RawParamDefinition['facet_kind'],
): RawParamDefinition | undefined {
  if (!isWorkflowParamReference(value)) {
    return undefined;
  }
  const definition = raw.subworkflow?.params?.[value.$param];
  if (!definition) {
    return undefined;
  }
  if (!expectedTypes.includes(definition.type) || definition.facet_kind !== expectedKind) {
    return undefined;
  }
  return definition;
}

function collectNamedRefsFromField(
  raw: RawWorkflow,
  value: unknown,
  expectedTypes: readonly RawParamType[],
  expectedKind: RawParamDefinition['facet_kind'],
): string[] {
  if (typeof value === 'string' || Array.isArray(value)) {
    return collectNamedRefs(value);
  }
  const definition = getParamDefinition(raw, value, expectedTypes, expectedKind);
  if (!definition?.default) {
    return [];
  }
  return collectNamedRefs(definition.default);
}

function collectFacetRefsFromField(
  raw: RawWorkflow,
  value: unknown,
  expectedTypes: readonly RawParamType[],
  expectedKind: RawParamDefinition['facet_kind'],
): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((ref): ref is string => typeof ref === 'string');
  }
  const definition = getParamDefinition(raw, value, expectedTypes, expectedKind);
  if (!definition?.default) {
    return [];
  }
  return Array.isArray(definition.default) ? definition.default : [definition.default];
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

function collectWorkflowUsedLocalFacetKeys(raw: RawWorkflow): WorkflowUsedLocalFacetKeys {
  const used = {
    instructions: new Set<string>(),
    knowledge: new Set<string>(),
    personas: new Set<string>(),
    policies: new Set<string>(),
    report_formats: new Set<string>(),
  };
  for (const reference of collectWorkflowUsedFacetReferences(raw)) {
    if (isNamedRef(reference.ref)) {
      used[reference.section].add(reference.ref);
    }
  }
  return used;
}

export function collectWorkflowUsedFacetReferences(raw: RawWorkflow): WorkflowFacetReference[] {
  const references: WorkflowFacetReference[] = [];
  const addReference = (section: WorkflowFacetReference['section'], ref: unknown): void => {
    if (typeof ref === 'string') {
      references.push({ section, ref });
    }
  };
  const collectStep = (step: RawStep): void => {
    addReference('personas', step.persona);
    addReference('personas', step.team_leader?.persona);
    addReference('personas', step.team_leader?.part_persona);
    for (const ref of collectFacetRefsFromField(raw, step.instruction, ['facet_ref'], 'instruction')) {
      addReference('instructions', ref);
    }
    for (const ref of collectFacetRefsFromField(raw, step.policy, ['facet_ref', 'facet_ref[]'], 'policy')) {
      addReference('policies', ref);
    }
    for (const ref of collectFacetRefsFromField(raw, step.knowledge, ['facet_ref', 'facet_ref[]'], 'knowledge')) {
      addReference('knowledge', ref);
    }
    for (const report of step.output_contracts?.report ?? []) {
      for (const ref of collectFacetRefsFromField(raw, report.format, ['facet_ref'], 'report_format')) {
        addReference('report_formats', ref);
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
    addReference('personas', monitor.judge.persona);
    addReference('instructions', monitor.judge.instruction);
  }
  return references;
}

export function collectWorkflowCallReferences(raw: RawWorkflow): WorkflowCallReference[] {
  const calls: WorkflowCallReference[] = [];
  const collectStep = (step: RawStep): void => {
    if (getWorkflowStepKind(step) === 'workflow_call' && typeof step.call === 'string') {
      calls.push({ call: step.call, stepName: step.name });
    }
    for (const sub of step.parallel ?? []) {
      collectStep(sub as RawStep);
    }
  };
  for (const step of raw.steps) {
    collectStep(step);
  }
  return calls;
}

function collectUnusedSectionWarnings(raw: RawWorkflow, diagnostics: WorkflowDiagnostic[]): void {
  const used = collectWorkflowUsedLocalFacetKeys(raw);
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
    collectNamedRefsFromField(raw, step.policy, ['facet_ref', 'facet_ref[]'], 'policy'),
    (ref) => canResolveNamedFacetRef(ref, sections.resolvedPolicies, 'policies', context),
  );
  validateScalarRefs(
    diagnostics,
    `${label} knowledge`,
    collectNamedRefsFromField(raw, step.knowledge, ['facet_ref', 'facet_ref[]'], 'knowledge'),
    (ref) => canResolveNamedFacetRef(ref, sections.resolvedKnowledge, 'knowledge', context),
  );
  for (const ref of collectNamedRefsFromField(raw, step.instruction, ['facet_ref'], 'instruction')) {
    appendMissingRef(
      diagnostics,
      `${label} instruction`,
      ref,
      () => canResolveNamedFacetRef(ref, sections.resolvedInstructions, 'instructions', context),
    );
  }
  for (const report of step.output_contracts?.report ?? []) {
    for (const ref of collectNamedRefsFromField(raw, report.format, ['facet_ref'], 'report_format')) {
      appendMissingRef(
        diagnostics,
        `${label} output_contract format`,
        ref,
        () => canResolveNamedFacetRef(ref, sections.resolvedReportFormats, 'output-contracts', context),
      );
    }
  }
  for (const sub of step.parallel ?? []) {
    validateStepRefs(raw, sub as RawStep, sections, context, diagnostics, `${label}/${sub.name}`);
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

export function validateWorkflowReferences(
  raw: RawWorkflow,
  sections: WorkflowSections,
  context: FacetResolutionContext,
  diagnostics: WorkflowDiagnostic[],
): void {
  for (const step of raw.steps) {
    validateStepRefs(raw, step, sections, context, diagnostics, `step "${step.name}"`);
  }
  validateLoopMonitorRefs(raw, sections, context, diagnostics);
  collectUnusedSectionWarnings(raw, diagnostics);
}
