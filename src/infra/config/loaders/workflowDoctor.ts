import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PieceConfigRawSchema } from '../../../core/models/index.js';
import type { PieceConfig } from '../../../core/models/index.js';
import { resolvePieceConfigValue } from '../resolvePieceConfigValue.js';
import { getRepertoireDir } from '../paths.js';
import { loadPieceFromFile } from './pieceParser.js';
import { formatPieceLoadWarning } from './pieceLoadWarning.js';
import {
  type FacetResolutionContext,
  type PieceSections,
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

type RawWorkflow = ReturnType<typeof PieceConfigRawSchema.parse>;
type RawMovement = RawWorkflow['movements'][number];

const SPECIAL_NEXT = new Set(['COMPLETE', 'ABORT']);

function isNamedRef(ref: string): boolean {
  return !isResourcePath(ref) && !/\s/.test(ref);
}

function buildContext(projectDir: string, filePath: string): FacetResolutionContext {
  return {
    lang: resolvePieceConfigValue(projectDir, 'language'),
    pieceDir: dirname(filePath),
    projectDir,
    repertoireDir: getRepertoireDir(),
  };
}

function buildSections(raw: RawWorkflow, pieceDir: string): PieceSections {
  return {
    personas: raw.personas,
    resolvedInstructions: resolveSectionMap(raw.instructions, pieceDir),
    resolvedKnowledge: resolveSectionMap(raw.knowledge, pieceDir),
    resolvedPolicies: resolveSectionMap(raw.policies, pieceDir),
    resolvedReportFormats: resolveSectionMap(raw.report_formats, pieceDir),
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

function collectStepEdges(config: PieceConfig): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const movement of config.movements) {
    const nextSteps = new Set<string>();
    for (const rule of movement.rules ?? []) {
      if (rule.next && !SPECIAL_NEXT.has(rule.next)) {
        nextSteps.add(rule.next);
      }
    }
    edges.set(movement.name, nextSteps);
  }
  return edges;
}

function collectReachableSteps(config: PieceConfig): Set<string> {
  const edges = collectStepEdges(config);
  const visited = new Set<string>();
  const queue = [config.initialMovement];

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

  const collectMovement = (movement: RawMovement): void => {
    if (movement.persona && isNamedRef(movement.persona)) {
      used.personas.add(movement.persona);
    }

    if (movement.instruction && isNamedRef(movement.instruction)) {
      used.instructions.add(movement.instruction);
    }

    const policyRefs = Array.isArray(movement.policy) ? movement.policy : movement.policy ? [movement.policy] : [];
    for (const ref of policyRefs) {
      if (isNamedRef(ref)) {
        used.policies.add(ref);
      }
    }

    const knowledgeRefs = Array.isArray(movement.knowledge) ? movement.knowledge : movement.knowledge ? [movement.knowledge] : [];
    for (const ref of knowledgeRefs) {
      if (isNamedRef(ref)) {
        used.knowledge.add(ref);
      }
    }

    for (const report of movement.output_contracts?.report ?? []) {
      if (isNamedRef(report.format)) {
        used.report_formats.add(report.format);
      }
      if (report.order && isNamedRef(report.order)) {
        used.report_formats.add(report.order);
      }
    }

    for (const sub of movement.parallel ?? []) {
      collectMovement(sub as RawMovement);
    }
  };

  for (const movement of raw.movements) {
    collectMovement(movement);
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

function validateMovementRefs(
  movement: RawMovement,
  sections: PieceSections,
  context: FacetResolutionContext,
  diagnostics: WorkflowDiagnostic[],
  label: string,
): void {
  const pieceDir = context.pieceDir!;
  if (movement.persona && isNamedRef(movement.persona)) {
    appendMissingRef(
      diagnostics,
      `${label} persona`,
      movement.persona,
      () => sections.personas?.[movement.persona!] !== undefined
        || resolvePersona(movement.persona, sections, pieceDir, context).personaPath !== undefined,
    );
  }
  validateScalarRefs(
    diagnostics,
    `${label} policy`,
    Array.isArray(movement.policy)
      ? movement.policy.filter(isNamedRef)
      : movement.policy && isNamedRef(movement.policy) ? movement.policy : undefined,
    (ref) => canResolveNamedFacetRef(ref, sections.resolvedPolicies, 'policies', context),
  );
  validateScalarRefs(
    diagnostics,
    `${label} knowledge`,
    Array.isArray(movement.knowledge)
      ? movement.knowledge.filter(isNamedRef)
      : movement.knowledge && isNamedRef(movement.knowledge) ? movement.knowledge : undefined,
    (ref) => canResolveNamedFacetRef(ref, sections.resolvedKnowledge, 'knowledge', context),
  );
  if (movement.instruction && isNamedRef(movement.instruction)) {
    appendMissingRef(
      diagnostics,
      `${label} instruction`,
      movement.instruction,
      () => canResolveNamedFacetRef(
        movement.instruction!,
        sections.resolvedInstructions,
        'instructions',
        context,
      ),
    );
  }

  for (const report of movement.output_contracts?.report ?? []) {
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
    if (report.order && isNamedRef(report.order)) {
      appendMissingRef(
        diagnostics,
        `${label} output_contract order`,
        report.order,
        () => canResolveNamedFacetRef(
          report.order!,
          sections.resolvedReportFormats,
          'output-contracts',
          context,
        ),
      );
    }
  }

  for (const sub of movement.parallel ?? []) {
    validateMovementRefs(sub as RawMovement, sections, context, diagnostics, `${label}/${sub.name}`);
  }
}

function validateLoopMonitorRefs(
  raw: RawWorkflow,
  sections: PieceSections,
  context: FacetResolutionContext,
  diagnostics: WorkflowDiagnostic[],
): void {
  const pieceDir = context.pieceDir!;
  for (const monitor of raw.loop_monitors ?? []) {
    const label = `loop monitor (${monitor.cycle.join(' -> ')})`;
    if (monitor.judge.persona && isNamedRef(monitor.judge.persona)) {
      appendMissingRef(
        diagnostics,
        `${label} persona`,
        monitor.judge.persona,
        () => sections.personas?.[monitor.judge.persona!] !== undefined
          || resolvePersona(monitor.judge.persona, sections, pieceDir, context).personaPath !== undefined,
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

function validateNextTargets(config: PieceConfig, raw: RawWorkflow, diagnostics: WorkflowDiagnostic[]): void {
  const movementNames = new Set(config.movements.map((movement) => movement.name));
  if (!movementNames.has(config.initialMovement)) {
    diagnostics.push({
      level: 'error',
      message: `initial_step references missing step "${config.initialMovement}"`,
    });
  }

  for (const movement of config.movements) {
    for (const rule of movement.rules ?? []) {
      if (!rule.next || SPECIAL_NEXT.has(rule.next) || movementNames.has(rule.next)) {
        continue;
      }
      diagnostics.push({
        level: 'error',
        message: `Step "${movement.name}" routes to unknown next step "${rule.next}"`,
      });
    }

    for (const sub of movement.parallel ?? []) {
      for (const rule of sub.rules ?? []) {
        if (!rule.next || SPECIAL_NEXT.has(rule.next) || movementNames.has(rule.next)) {
          continue;
        }
        diagnostics.push({
          level: 'error',
          message: `Step "${movement.name}/${sub.name}" routes to unknown next step "${rule.next}"`,
        });
      }
    }
  }

  for (const monitor of raw.loop_monitors ?? []) {
    const label = monitor.cycle.join(' -> ');
    for (const rule of monitor.judge.rules) {
      if (!rule.next || SPECIAL_NEXT.has(rule.next) || movementNames.has(rule.next)) {
        continue;
      }
      diagnostics.push({
        level: 'error',
        message: `Loop monitor "${label}" routes to unknown next step "${rule.next}"`,
      });
    }
  }
}

function validateReachability(config: PieceConfig, diagnostics: WorkflowDiagnostic[]): void {
  const reachable = collectReachableSteps(config);
  const unreachable = config.movements
    .map((movement) => movement.name)
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
  let config: PieceConfig;
  try {
    config = loadPieceFromFile(filePath, projectDir);
  } catch (error) {
    return {
      diagnostics: [{ level: 'error', message: formatPieceLoadWarning(basename(filePath), error) }],
      filePath,
    };
  }

  const raw = PieceConfigRawSchema.parse(parseYaml(readFileSync(filePath, 'utf-8')));
  const context = buildContext(projectDir, filePath);
  const sections = buildSections(raw, context.pieceDir!);
  const diagnostics: WorkflowDiagnostic[] = [];

  for (const movement of raw.movements) {
    validateMovementRefs(movement, sections, context, diagnostics, `step "${movement.name}"`);
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
