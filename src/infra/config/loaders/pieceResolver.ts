/**
 * Piece resolution — 3-layer lookup logic.
 *
 * Resolves piece names and paths to concrete PieceConfig objects,
 * using the priority chain: project-local → user → builtin.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { PieceConfig, PieceMovement, InteractiveMode } from '../../../core/models/index.js';
import { getGlobalPiecesDir, getBuiltinPiecesDir, getProjectConfigDir, getRepertoireDir } from '../paths.js';
import { isScopeRef, parseScopeRef } from '../../../faceted-prompting/index.js';
import { resolvePieceConfigValues } from '../resolvePieceConfigValue.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { loadPieceFromFile } from './pieceParser.js';

const log = createLogger('piece-resolver');

export type PieceSource = 'builtin' | 'user' | 'project' | 'repertoire';

export interface PieceWithSource {
  config: PieceConfig;
  source: PieceSource;
}

export function listBuiltinPieceNames(cwd: string, options?: { includeDisabled?: boolean }): string[] {
  const config = resolvePieceConfigValues(cwd, ['language', 'disabledBuiltins']);
  const lang = config.language;
  const dir = getBuiltinPiecesDir(lang);
  const disabled = options?.includeDisabled ? undefined : (config.disabledBuiltins ?? []);
  const names = new Set<string>();
  for (const entry of iteratePieceDir(dir, 'builtin', disabled)) {
    names.add(entry.name);
  }
  return Array.from(names);
}

/** Get builtin piece by name */
export function getBuiltinPiece(name: string, projectCwd: string): PieceConfig | null {
  const config = resolvePieceConfigValues(projectCwd, ['enableBuiltinPieces', 'language', 'disabledBuiltins']);
  if (config.enableBuiltinPieces === false) return null;
  const lang = config.language;
  const disabled = config.disabledBuiltins ?? [];
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
  projectCwd: string,
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
 * Load piece by identifier (auto-detects @scope ref, file path, or piece name).
 */
export function loadPieceByIdentifier(
  identifier: string,
  projectCwd: string,
): PieceConfig | null {
  if (isScopeRef(identifier)) {
    return loadRepertoirePieceByRef(identifier, projectCwd);
  }
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

    previews.push({
      name: movement.name,
      personaDisplayName: movement.personaDisplayName,
      personaContent: readMovementPersona(movement),
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
 * Read persona content from a movement.
 * When personaPath is set, reads from file (returns empty on failure).
 * Otherwise uses inline persona string.
 */
function readMovementPersona(movement: PieceMovement): string {
  if (movement.personaPath) {
    try {
      return readFileSync(movement.personaPath, 'utf-8');
    } catch (err) {
      log.debug('Failed to read persona file', {
        path: movement.personaPath,
        error: getErrorMessage(err),
      });
      return '';
    }
  }
  return movement.persona ?? '';
}

/** First movement info for persona mode */
export interface FirstMovementInfo {
  /** Persona prompt content */
  personaContent: string;
  /** Persona display name */
  personaDisplayName: string;
  /** Allowed tools for this movement */
  allowedTools: string[];
}

/**
 * Get piece description by identifier.
 * Returns the piece name, description, workflow structure, optional movement previews,
 * piece-level interactive mode default, and first movement info for persona mode.
 */
export function getPieceDescription(
  identifier: string,
  projectCwd: string,
  previewCount?: number,
): {
  name: string;
  description: string;
  pieceStructure: string;
  movementPreviews: MovementPreview[];
  interactiveMode?: InteractiveMode;
  firstMovement?: FirstMovementInfo;
} {
  const piece = loadPieceByIdentifier(identifier, projectCwd);
  if (!piece) {
    return { name: identifier, description: '', pieceStructure: '', movementPreviews: [] };
  }

  const previews = previewCount && previewCount > 0
    ? buildMovementPreviews(piece, previewCount)
    : [];

  const firstMovement = buildFirstMovementInfo(piece);

  return {
    name: piece.name,
    description: piece.description ?? '',
    pieceStructure: buildWorkflowString(piece.movements),
    movementPreviews: previews,
    interactiveMode: piece.interactiveMode,
    firstMovement,
  };
}

/**
 * Build first movement info for persona mode.
 * Reads persona content from the initial movement.
 */
function buildFirstMovementInfo(piece: PieceConfig): FirstMovementInfo | undefined {
  const movement = piece.movements.find((m) => m.name === piece.initialMovement);
  if (!movement) return undefined;

  return {
    personaContent: readMovementPersona(movement),
    personaDisplayName: movement.personaDisplayName,
    allowedTools: movement.allowedTools ?? [],
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
    let stat: ReturnType<typeof statSync>;
    try { stat = statSync(entryPath); } catch (e) { log.debug(`stat failed for ${entryPath}: ${getErrorMessage(e)}`); continue; }

    if (stat.isFile() && (entry.endsWith('.yaml') || entry.endsWith('.yml'))) {
      const pieceName = entry.replace(/\.ya?ml$/, '');
      if (disabled?.includes(pieceName)) continue;
      yield { name: pieceName, path: entryPath, source };
      continue;
    }

    if (stat.isDirectory()) {
      const category = entry;
      for (const subEntry of readdirSync(entryPath)) {
        if (!subEntry.endsWith('.yaml') && !subEntry.endsWith('.yml')) continue;
        const subEntryPath = join(entryPath, subEntry);
        try { if (!statSync(subEntryPath).isFile()) continue; } catch (e) { log.debug(`stat failed for ${subEntryPath}: ${getErrorMessage(e)}`); continue; }
        const pieceName = subEntry.replace(/\.ya?ml$/, '');
        const qualifiedName = `${category}/${pieceName}`;
        if (disabled?.includes(qualifiedName)) continue;
        yield { name: qualifiedName, path: subEntryPath, category, source };
      }
    }
  }
}

/**
 * Iterate piece YAML files in all repertoire packages.
 * Qualified name format: @{owner}/{repo}/{piece-name}
 */
function* iterateRepertoirePieces(repertoireDir: string): Generator<PieceDirEntry> {
  if (!existsSync(repertoireDir)) return;
  for (const ownerEntry of readdirSync(repertoireDir)) {
    if (!ownerEntry.startsWith('@')) continue;
    const ownerPath = join(repertoireDir, ownerEntry);
    try { if (!statSync(ownerPath).isDirectory()) continue; } catch (e) { log.debug(`stat failed for owner dir ${ownerPath}: ${getErrorMessage(e)}`); continue; }
    const owner = ownerEntry.slice(1);
    for (const repoEntry of readdirSync(ownerPath)) {
      const repoPath = join(ownerPath, repoEntry);
      try { if (!statSync(repoPath).isDirectory()) continue; } catch (e) { log.debug(`stat failed for repo dir ${repoPath}: ${getErrorMessage(e)}`); continue; }
      const piecesDir = join(repoPath, 'pieces');
      if (!existsSync(piecesDir)) continue;
      for (const pieceFile of readdirSync(piecesDir)) {
        if (!pieceFile.endsWith('.yaml') && !pieceFile.endsWith('.yml')) continue;
        const piecePath = join(piecesDir, pieceFile);
        try { if (!statSync(piecePath).isFile()) continue; } catch (e) { log.debug(`stat failed for piece file ${piecePath}: ${getErrorMessage(e)}`); continue; }
        const pieceName = pieceFile.replace(/\.ya?ml$/, '');
        yield { name: `@${owner}/${repoEntry}/${pieceName}`, path: piecePath, source: 'repertoire' };
      }
    }
  }
}

/**
 * Load a piece by @scope reference (@{owner}/{repo}/{piece-name}).
 * Resolves to ~/.takt/repertoire/@{owner}/{repo}/pieces/{piece-name}.yaml
 */
function loadRepertoirePieceByRef(identifier: string, projectCwd: string): PieceConfig | null {
  const scopeRef = parseScopeRef(identifier);
  const repertoireDir = getRepertoireDir();
  const piecesDir = join(repertoireDir, `@${scopeRef.owner}`, scopeRef.repo, 'pieces');
  const filePath = resolvePieceFile(piecesDir, scopeRef.name);
  if (!filePath) return null;
  return loadPieceFromFile(filePath, projectCwd);
}

/** Get the 3-layer directory list (builtin → user → project-local) */
function getPieceDirs(cwd: string): { dir: string; source: PieceSource; disabled?: string[] }[] {
  const config = resolvePieceConfigValues(cwd, ['enableBuiltinPieces', 'language', 'disabledBuiltins']);
  const disabled = config.disabledBuiltins ?? [];
  const lang = config.language;
  const dirs: { dir: string; source: PieceSource; disabled?: string[] }[] = [];
  if (config.enableBuiltinPieces !== false) {
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

  const repertoireDir = getRepertoireDir();
  for (const entry of iterateRepertoirePieces(repertoireDir)) {
    try {
      pieces.set(entry.name, { config: loadPieceFromFile(entry.path, cwd), source: entry.source });
    } catch (err) {
      log.debug('Skipping invalid repertoire piece file', { path: entry.path, error: getErrorMessage(err) });
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
