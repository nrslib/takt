/**
 * Quality gate override application logic
 *
 * Resolves quality gates from config overrides with 3-layer priority:
 * 1. Project .takt/config.yaml piece_overrides
 * 2. Global ~/.takt/config.yaml piece_overrides
 * 3. Piece YAML quality_gates
 *
 * Merge strategy: Additive (config gates + YAML gates)
 */

import type { PieceOverrides } from '../../../core/models/persisted-global-config.js';

/**
 * Apply quality gate overrides to a movement.
 *
 * Merge order (gates are added in this sequence):
 * 1. Global override in global config (filtered by edit flag if qualityGatesEditOnly=true)
 * 2. Movement-specific override in global config
 * 3. Global override in project config (filtered by edit flag if qualityGatesEditOnly=true)
 * 4. Movement-specific override in project config
 * 5. Piece YAML quality_gates
 *
 * Merge strategy: Additive merge (all gates are combined, no overriding)
 *
 * @param movementName - Name of the movement
 * @param yamlGates - Quality gates from piece YAML
 * @param editFlag - Whether the movement has edit: true
 * @param projectOverrides - Project-level piece_overrides (from .takt/config.yaml)
 * @param globalOverrides - Global-level piece_overrides (from ~/.takt/config.yaml)
 * @returns Merged quality gates array
 */
export function applyQualityGateOverrides(
  movementName: string,
  yamlGates: string[] | undefined,
  editFlag: boolean | undefined,
  projectOverrides: PieceOverrides | undefined,
  globalOverrides: PieceOverrides | undefined,
): string[] | undefined {
  // Track whether yamlGates was explicitly defined (even if empty)
  const hasYamlGates = yamlGates !== undefined;
  const gates: string[] = [];

  // Collect global gates from global config
  const globalGlobalGates = globalOverrides?.qualityGates;
  const globalEditOnly = globalOverrides?.qualityGatesEditOnly ?? false;
  if (globalGlobalGates && (!globalEditOnly || editFlag === true)) {
    gates.push(...globalGlobalGates);
  }

  // Collect movement-specific gates from global config
  const globalMovementGates = globalOverrides?.movements?.[movementName]?.qualityGates;
  if (globalMovementGates) {
    gates.push(...globalMovementGates);
  }

  // Collect global gates from project config
  const projectGlobalGates = projectOverrides?.qualityGates;
  const projectEditOnly = projectOverrides?.qualityGatesEditOnly ?? false;
  if (projectGlobalGates && (!projectEditOnly || editFlag === true)) {
    gates.push(...projectGlobalGates);
  }

  // Collect movement-specific gates from project config
  const projectMovementGates = projectOverrides?.movements?.[movementName]?.qualityGates;
  if (projectMovementGates) {
    gates.push(...projectMovementGates);
  }

  // Add YAML gates (lowest priority)
  if (yamlGates) {
    gates.push(...yamlGates);
  }

  // Deduplicate gates (same text = same gate)
  const uniqueGates = Array.from(new Set(gates));

  // Return undefined only if no gates were defined anywhere
  // If yamlGates was explicitly set (even if empty), return the merged array
  if (uniqueGates.length > 0) {
    return uniqueGates;
  }
  return hasYamlGates ? [] : undefined;
}
