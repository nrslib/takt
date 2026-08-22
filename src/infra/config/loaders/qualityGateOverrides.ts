/**
 * Quality gate override application logic
 *
 * Resolves quality gates from config overrides with 3-layer priority:
 * 1. Project .takt/config.yaml workflow_overrides
 * 2. Global ~/.takt/config.yaml workflow_overrides
 * 3. Workflow YAML quality_gates
 *
 * Merge strategy: Additive (config gates + YAML gates)
 */

import * as path from 'node:path';
import type { WorkflowOverrides } from '../../../core/models/config-types.js';
import { DEFAULT_COMMAND_GATE_TIMEOUT_MS } from '../../../core/models/quality-gate-defaults.js';
import type { QualityGate } from '../../../core/models/workflow-types.js';

function getStepQualityGates(
  overrides: WorkflowOverrides | undefined,
  stepName: string,
): QualityGate[] | undefined {
  return overrides?.steps?.[stepName]?.qualityGates;
}

function normalizeCommandGateCwd(cwd: string | undefined): string {
  if (cwd === undefined) {
    return '.';
  }

  const normalized = path.normalize(cwd);
  if (normalized === path.parse(normalized).root) {
    return normalized;
  }

  const withoutTrailingSeparator = normalized.endsWith(path.sep) ? normalized.slice(0, -1) : normalized;
  return withoutTrailingSeparator.length > 0 ? withoutTrailingSeparator : '.';
}

function qualityGateDedupeKey(gate: QualityGate): string {
  if (typeof gate === 'string') {
    return `string:${JSON.stringify(gate)}`;
  }

  const cwd = normalizeCommandGateCwd(gate.cwd);
  const timeoutMs = gate.timeoutMs ?? DEFAULT_COMMAND_GATE_TIMEOUT_MS;

  return `command:${JSON.stringify([
    gate.type,
    gate.name ?? null,
    gate.command,
    cwd,
    timeoutMs,
  ])}`;
}

function dedupeQualityGates(gates: QualityGate[]): QualityGate[] {
  const seenKeys = new Set<string>();
  const uniqueGates: QualityGate[] = [];

  for (const gate of gates) {
    const key = qualityGateDedupeKey(gate);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    uniqueGates.push(gate);
  }

  return uniqueGates;
}

/**
 * Apply quality gate overrides to an agent step.
 *
 * Merge order (gates are added in this sequence):
 * 1. Global override in global config (filtered by edit flag if qualityGatesEditOnly=true)
 * 2. Step-specific override in global config
 * 3. Persona-specific override in global config
 * 4. Global override in project config (filtered by edit flag if qualityGatesEditOnly=true)
 * 5. Step-specific override in project config
 * 6. Persona-specific override in project config
 * 7. Workflow YAML quality_gates
 *
 * Merge strategy: Additive merge (all gates are combined, no overriding)
 *
 * @param stepName - Name of the step
 * @param yamlGates - Quality gates from workflow YAML
 * @param editFlag - Whether the step has edit: true
 * @param personaName - Persona name used by the step
 * @param projectOverrides - Project-level workflow_overrides (from .takt/config.yaml)
 * @param globalOverrides - Global-level workflow_overrides (from ~/.takt/config.yaml)
 * @returns Merged quality gates array
 */
export function applyQualityGateOverrides(
  stepName: string,
  yamlGates: QualityGate[] | undefined,
  editFlag: boolean | undefined,
  personaName: string | undefined,
  projectOverrides: WorkflowOverrides | undefined,
  globalOverrides: WorkflowOverrides | undefined,
): QualityGate[] | undefined {
  if (personaName !== undefined && personaName.trim().length === 0) {
    throw new Error(`Invalid persona name for step "${stepName}": empty value`);
  }
  const normalizedPersonaName = personaName?.trim();

  // Track whether yamlGates was explicitly defined (even if empty)
  const hasYamlGates = yamlGates !== undefined;
  const gates: QualityGate[] = [];

  // Collect global gates from global config
  const globalGlobalGates = globalOverrides?.qualityGates;
  const globalEditOnly = globalOverrides?.qualityGatesEditOnly ?? false;
  if (globalGlobalGates && (!globalEditOnly || editFlag === true)) {
    gates.push(...globalGlobalGates);
  }

  // Collect step-specific gates from global config
  const globalStepGates = getStepQualityGates(globalOverrides, stepName);
  if (globalStepGates) {
    gates.push(...globalStepGates);
  }

  // Collect persona-specific gates from global config
  const globalPersonaGates = normalizedPersonaName
    ? globalOverrides?.personas?.[normalizedPersonaName]?.qualityGates
    : undefined;
  if (globalPersonaGates) {
    gates.push(...globalPersonaGates);
  }

  // Collect global gates from project config
  const projectGlobalGates = projectOverrides?.qualityGates;
  const projectEditOnly = projectOverrides?.qualityGatesEditOnly ?? false;
  if (projectGlobalGates && (!projectEditOnly || editFlag === true)) {
    gates.push(...projectGlobalGates);
  }

  // Collect step-specific gates from project config
  const projectStepGates = getStepQualityGates(projectOverrides, stepName);
  if (projectStepGates) {
    gates.push(...projectStepGates);
  }

  // Collect persona-specific gates from project config
  const projectPersonaGates = normalizedPersonaName
    ? projectOverrides?.personas?.[normalizedPersonaName]?.qualityGates
    : undefined;
  if (projectPersonaGates) {
    gates.push(...projectPersonaGates);
  }

  // Add YAML gates (lowest priority)
  if (yamlGates) {
    gates.push(...yamlGates);
  }

  const uniqueGates = dedupeQualityGates(gates);

  // Return undefined only if no gates were defined anywhere
  // If yamlGates was explicitly set (even if empty), return the merged array
  if (uniqueGates.length > 0) {
    return uniqueGates;
  }
  return hasYamlGates ? [] : undefined;
}
