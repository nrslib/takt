/**
 * Pure utility functions for generating install summary information.
 *
 * Extracted to enable unit testing without file I/O or system dependencies.
 */

import { parse as parseYaml } from 'yaml';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';

const log = createLogger('pack-summary');

export interface EditPieceInfo {
  name: string;
  allowedTools: string[];
  hasEdit: boolean;
  requiredPermissionModes: string[];
}

/**
 * Count facet files per type (personas, policies, knowledge, etc.)
 * and produce a human-readable summary string.
 *
 * @param facetRelativePaths - Paths relative to package root, starting with `facets/`
 */
export function summarizeFacetsByType(facetRelativePaths: string[]): string {
  const countsByType = new Map<string, number>();
  for (const path of facetRelativePaths) {
    const parts = path.split('/');
    if (parts.length >= 2 && parts[1]) {
      const type = parts[1];
      countsByType.set(type, (countsByType.get(type) ?? 0) + 1);
    }
  }
  return countsByType.size > 0
    ? Array.from(countsByType.entries()).map(([type, count]) => `${count} ${type}`).join(', ')
    : '0';
}

/**
 * Detect pieces that require permissions in any movement.
 *
 * A movement is considered permission-relevant when any of:
 * - `edit: true` is set
 * - `allowed_tools` has at least one entry
 * - `required_permission_mode` is set
 *
 * @param pieceYamls - Pre-read YAML content pairs. Invalid YAML is skipped (debug-logged).
 */
export function detectEditPieces(pieceYamls: Array<{ name: string; content: string }>): EditPieceInfo[] {
  const result: EditPieceInfo[] = [];
  for (const { name, content } of pieceYamls) {
    let raw: { movements?: { edit?: boolean; allowed_tools?: string[]; required_permission_mode?: string }[] } | null;
    try {
      raw = parseYaml(content) as typeof raw;
    } catch (e) {
      log.debug(`YAML parse failed for piece ${name}: ${getErrorMessage(e)}`);
      continue;
    }
    const movements = raw?.movements ?? [];
    const hasEditMovement = movements.some(m => m.edit === true);
    const hasToolMovements = movements.some(m => (m.allowed_tools?.length ?? 0) > 0);
    const hasPermissionMovements = movements.some(m => m.required_permission_mode != null);
    if (!hasEditMovement && !hasToolMovements && !hasPermissionMovements) continue;

    const allTools = new Set<string>();
    for (const m of movements) {
      if (m.allowed_tools) {
        for (const t of m.allowed_tools) allTools.add(t);
      }
    }
    const requiredPermissionModes: string[] = [];
    for (const m of movements) {
      if (m.required_permission_mode != null) {
        const mode = m.required_permission_mode;
        if (!requiredPermissionModes.includes(mode)) {
          requiredPermissionModes.push(mode);
        }
      }
    }
    result.push({
      name,
      allowedTools: Array.from(allTools),
      hasEdit: hasEditMovement,
      requiredPermissionModes,
    });
  }
  return result;
}

/**
 * Format warning lines for a single permission-relevant piece.
 * Returns one line per warning (edit, allowed_tools, required_permission_mode).
 */
export function formatEditPieceWarnings(ep: EditPieceInfo): string[] {
  const warnings: string[] = [];
  if (ep.hasEdit) {
    const toolStr = ep.allowedTools.length > 0 ? `, allowed_tools: [${ep.allowedTools.join(', ')}]` : '';
    warnings.push(`\n   ⚠ ${ep.name}: edit: true${toolStr}`);
  } else if (ep.allowedTools.length > 0) {
    warnings.push(`\n   ⚠ ${ep.name}: allowed_tools: [${ep.allowedTools.join(', ')}]`);
  }
  for (const mode of ep.requiredPermissionModes) {
    warnings.push(`\n   ⚠ ${ep.name}: required_permission_mode: ${mode}`);
  }
  return warnings;
}
