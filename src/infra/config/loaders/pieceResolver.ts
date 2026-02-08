/**
 * Piece resolution — 3-layer lookup logic.
 *
 * Resolves piece names and paths to concrete PieceConfig objects,
 * using the priority chain: project-local → user → builtin.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { PieceConfig, PieceMovement } from '../../../core/models/index.js';
import { getGlobalPiecesDir, getBuiltinPiecesDir, getProjectConfigDir } from '../paths.js';
import { getLanguage, getDisabledBuiltins, getBuiltinPiecesEnabled } from '../global/globalConfig.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { loadPieceFromFile } from './pieceParser.js';

const log = createLogger('piece-resolver');

export type PieceSource = 'builtin' | 'user' | 'project';

export interface PieceWithSource {
  config: PieceConfig;
  source: PieceSource;
}

export function listBuiltinPieceNames(options?: { includeDisabled?: boolean }): string[] {
  const lang = getLanguage();
  const dir = getBuiltinPiecesDir(lang);
  const disabled = options?.includeDisabled ? undefined : getDisabledBuiltins();
  const names = new Set<string>();
  for (const entry of iteratePieceDir(dir, 'builtin', disabled)) {
    names.add(entry.name);
  }
  return Array.from(names);
}

/** Get builtin piece by name */
export function getBuiltinPiece(name: string, projectCwd?: string): PieceConfig | null {
  if (!getBuiltinPiecesEnabled()) return null;
  const lang = getLanguage();
  const disabled = getDisabledBuiltins();
  if (disabled.includes(name)) return null;

  const builtinDir = getBuiltinPiecesDir(lang);
  const yamlPath = join(builtinDir, `${name}.yaml`);
  if (existsSync(yamlPath)) {
    return loadPieceFromFile(yamlPath, projectCwd);
  }
  return null;
}

/**
 * Resolve a path that may be relative, absolute, or home-directory-relative.
 */
function resolvePath(pathInput: string, basePath: string): string {
  if (pathInput.startsWith('~')) {
    const home = homedir();
    return resolve(home, pathInput.slice(1).replace(/^\//, ''));
  }
  if (isAbsolute(pathInput)) {
    return pathInput;
  }
  return resolve(basePath, pathInput);
}

/**
 * Load piece from a file path.
 */
function loadPieceFromPath(
  filePath: string,
  basePath: string,
  projectCwd?: string,
): PieceConfig | null {
  const resolvedPath = resolvePath(filePath, basePath);
  if (!existsSync(resolvedPath)) {
    return null;
  }
  return loadPieceFromFile(resolvedPath, projectCwd);
}

/**
 * Resolve a piece YAML file path by trying both .yaml and .yml extensions.
 * For category/name identifiers (e.g. "frontend/react"), resolves to
 * {piecesDir}/frontend/react.yaml (or .yml).
 */
function resolvePieceFile(piecesDir: string, name: string): string | null {
  for (const ext of ['.yaml', '.yml']) {
    const filePath = join(piecesDir, `${name}${ext}`);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

/**
 * Load piece by name (name-based loading only, no path detection).
 * Supports category/name identifiers (e.g. "frontend/react").
 *
 * Priority:
 * 1. Project-local pieces → .takt/pieces/{name}.yaml
 * 2. User pieces → ~/.takt/pieces/{name}.yaml
 * 3. Builtin pieces → builtins/{lang}/pieces/{name}.yaml
 */
export function loadPiece(
  name: string,
  projectCwd: string,
): PieceConfig | null {
  const projectPiecesDir = join(getProjectConfigDir(projectCwd), 'pieces');
  const projectMatch = resolvePieceFile(projectPiecesDir, name);
  if (projectMatch) {
    return loadPieceFromFile(projectMatch, projectCwd);
  }

  const globalPiecesDir = getGlobalPiecesDir();
  const globalMatch = resolvePieceFile(globalPiecesDir, name);
  if (globalMatch) {
    return loadPieceFromFile(globalMatch, projectCwd);
  }

  return getBuiltinPiece(name, projectCwd);
}

/**
 * Check if a piece identifier looks like a file path (vs a piece name).
 */
export function isPiecePath(identifier: string): boolean {
  return (
    identifier.startsWith('/') ||
    identifier.startsWith('~') ||
    identifier.startsWith('./') ||
    identifier.startsWith('../') ||
    identifier.endsWith('.yaml') ||
    identifier.endsWith('.yml')
  );
}

/**
 * Load piece by identifier (auto-detects name vs path).
 */
export function loadPieceByIdentifier(
  identifier: string,
  projectCwd: string,
): PieceConfig | null {
  if (isPiecePath(identifier)) {
    return loadPieceFromPath(identifier, projectCwd, projectCwd);
  }
  return loadPiece(identifier, projectCwd);
}

/**
 * Build workflow structure string from piece movements.
 * Formats as numbered list with indented parallel sub-movements.
 *
 * @param movements - Piece movements list
 * @returns Workflow structure string (newline-separated list)
 */
function buildWorkflowString(movements: PieceMovement[]): string {
  if (!movements || movements.length === 0) return '';

  const lines: string[] = [];
  let index = 1;

  for (const movement of movements) {
    const desc = movement.description ? ` (${movement.description})` : '';
    lines.push(`${index}. ${movement.name}${desc}`);

    if (movement.parallel && movement.parallel.length > 0) {
      for (const sub of movement.parallel) {
        const subDesc = sub.description ? ` (${sub.description})` : '';
        lines.push(`   - ${sub.name}${subDesc}`);
      }
    }

    index++;
  }

  return lines.join('\n');
}

export interface MovementPreview {
  /** Movement name (e.g., "plan") */
  name: string;
  /** Persona display name (e.g., "Planner") */
  personaDisplayName: string;
  /** Persona prompt content (read from personaPath file) */
  personaContent: string;
  /** Instruction template content (already resolved at parse time) */
  instructionContent: string;
  /** Allowed tools for this movement */
  allowedTools: string[];
  /** Whether this movement can edit files */
  canEdit: boolean;
}

/**
 * Build movement previews for the first N movements of a piece.
 * Follows the execution order: initialMovement → rules[0].next → ...
 *
 * @param piece - Loaded PieceConfig
 * @param maxCount - Maximum number of previews to build
 * @returns Array of MovementPreview (may be shorter than maxCount)
 */
function buildMovementPreviews(piece: PieceConfig, maxCount: number): MovementPreview[] {
  if (maxCount <= 0 || piece.movements.length === 0) return [];

  const movementMap = new Map<string, PieceMovement>();
  for (const m of piece.movements) {
    movementMap.set(m.name, m);
  }

  const previews: MovementPreview[] = [];
  const visited = new Set<string>();
  let currentName: string | undefined = piece.initialMovement;

  while (currentName && previews.length < maxCount) {
    if (currentName === 'COMPLETE' || currentName === 'ABORT') break;
    if (visited.has(currentName)) break;
    visited.add(currentName);

    const movement = movementMap.get(currentName);
    if (!movement) break;

    let personaContent = '';
    if (movement.personaPath) {
      try {
        personaContent = readFileSync(movement.personaPath, 'utf-8');
      } catch (err) {
        log.debug('Failed to read persona file for preview', {
          path: movement.personaPath,
          error: getErrorMessage(err),
        });
      }
    } else if (movement.persona) {
      personaContent = movement.persona;
    }

    previews.push({
      name: movement.name,
      personaDisplayName: movement.personaDisplayName,
      personaContent,
      instructionContent: movement.instructionTemplate,
      allowedTools: movement.allowedTools ?? [],
      canEdit: movement.edit === true,
    });

    const nextName = movement.rules?.[0]?.next;
    if (!nextName) break;
    currentName = nextName;
  }

  return previews;
}

/**
 * Get piece description by identifier.
 * Returns the piece name, description, workflow structure, and optional movement previews.
 */
export function getPieceDescription(
  identifier: string,
  projectCwd: string,
  previewCount?: number,
): { name: string; description: string; pieceStructure: string; movementPreviews: MovementPreview[] } {
  const piece = loadPieceByIdentifier(identifier, projectCwd);
  if (!piece) {
    return { name: identifier, description: '', pieceStructure: '', movementPreviews: [] };
  }
  return {
    name: piece.name,
    description: piece.description ?? '',
    pieceStructure: buildWorkflowString(piece.movements),
    movementPreviews: previewCount && previewCount > 0
      ? buildMovementPreviews(piece, previewCount)
      : [],
  };
}

/** Entry for a piece file found in a directory */
export interface PieceDirEntry {
  /** Piece name (e.g. "react") */
  name: string;
  /** Full file path */
  path: string;
  /** Category (subdirectory name), undefined for root-level pieces */
  category?: string;
  /** Piece source (builtin, user, project) */
  source: PieceSource;
}

/**
 * Iterate piece YAML files in a directory, yielding name, path, and category.
 * Scans root-level files (no category) and 1-level subdirectories (category = dir name).
 * Shared by both loadAllPieces and listPieces to avoid DRY violation.
 */
function* iteratePieceDir(
  dir: string,
  source: PieceSource,
  disabled?: string[],
): Generator<PieceDirEntry> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const entryPath = join(dir, entry);
    const stat = statSync(entryPath);

    if (stat.isFile() && (entry.endsWith('.yaml') || entry.endsWith('.yml'))) {
      const pieceName = entry.replace(/\.ya?ml$/, '');
      if (disabled?.includes(pieceName)) continue;
      yield { name: pieceName, path: entryPath, source };
      continue;
    }

    // 1-level subdirectory scan: directory name becomes the category
    if (stat.isDirectory()) {
      const category = entry;
      for (const subEntry of readdirSync(entryPath)) {
        if (!subEntry.endsWith('.yaml') && !subEntry.endsWith('.yml')) continue;
        const subEntryPath = join(entryPath, subEntry);
        if (!statSync(subEntryPath).isFile()) continue;
        const pieceName = subEntry.replace(/\.ya?ml$/, '');
        const qualifiedName = `${category}/${pieceName}`;
        if (disabled?.includes(qualifiedName)) continue;
        yield { name: qualifiedName, path: subEntryPath, category, source };
      }
    }
  }
}

/** Get the 3-layer directory list (builtin → user → project-local) */
function getPieceDirs(cwd: string): { dir: string; source: PieceSource; disabled?: string[] }[] {
  const disabled = getDisabledBuiltins();
  const lang = getLanguage();
  const dirs: { dir: string; source: PieceSource; disabled?: string[] }[] = [];
  if (getBuiltinPiecesEnabled()) {
    dirs.push({ dir: getBuiltinPiecesDir(lang), disabled, source: 'builtin' });
  }
  dirs.push({ dir: getGlobalPiecesDir(), source: 'user' });
  dirs.push({ dir: join(getProjectConfigDir(cwd), 'pieces'), source: 'project' });
  return dirs;
}

/**
 * Load all pieces with source metadata.
 *
 * Priority (later entries override earlier):
 *   1. Builtin pieces
 *   2. User pieces (~/.takt/pieces/)
 *   3. Project-local pieces (.takt/pieces/)
 */
export function loadAllPiecesWithSources(cwd: string): Map<string, PieceWithSource> {
  const pieces = new Map<string, PieceWithSource>();

  for (const { dir, source, disabled } of getPieceDirs(cwd)) {
    for (const entry of iteratePieceDir(dir, source, disabled)) {
      try {
        pieces.set(entry.name, { config: loadPieceFromFile(entry.path, cwd), source: entry.source });
      } catch (err) {
        log.debug('Skipping invalid piece file', { path: entry.path, error: getErrorMessage(err) });
      }
    }
  }

  return pieces;
}

/**
 * Load all pieces with descriptions (for switch command).
 *
 * Priority (later entries override earlier):
 *   1. Builtin pieces
 *   2. User pieces (~/.takt/pieces/)
 *   3. Project-local pieces (.takt/pieces/)
 */
export function loadAllPieces(cwd: string): Map<string, PieceConfig> {
  const pieces = new Map<string, PieceConfig>();
  const withSources = loadAllPiecesWithSources(cwd);
  for (const [name, entry] of withSources) {
    pieces.set(name, entry.config);
  }
  return pieces;
}

/**
 * List available piece names (builtin + user + project-local, excluding disabled).
 * Category pieces use qualified names like "frontend/react".
 */
export function listPieces(cwd: string): string[] {
  const pieces = new Set<string>();

  for (const { dir, source, disabled } of getPieceDirs(cwd)) {
    for (const entry of iteratePieceDir(dir, source, disabled)) {
      pieces.add(entry.name);
    }
  }

  return Array.from(pieces).sort();
}

/**
 * List available pieces with category information for UI display.
 * Returns entries grouped by category for 2-stage selection.
 *
 * Root-level pieces (no category) and category names are presented
 * at the same level. Selecting a category drills into its pieces.
 */
export function listPieceEntries(cwd: string): PieceDirEntry[] {
  // Later entries override earlier (project-local > user > builtin)
  const pieces = new Map<string, PieceDirEntry>();

  for (const { dir, source, disabled } of getPieceDirs(cwd)) {
    for (const entry of iteratePieceDir(dir, source, disabled)) {
      pieces.set(entry.name, entry);
    }
  }

  return Array.from(pieces.values());
}
