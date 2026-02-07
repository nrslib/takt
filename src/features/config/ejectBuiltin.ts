/**
 * /eject command implementation
 *
 * Copies a builtin piece (and its personas/stances/instructions) for user customization.
 * Directory structure is mirrored so relative paths work as-is.
 *
 * Default target: project-local (.takt/)
 * With --global: user global (~/.takt/)
 */

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  getGlobalPiecesDir,
  getGlobalPersonasDir,
  getProjectPiecesDir,
  getProjectPersonasDir,
  getBuiltinPiecesDir,
  getLanguage,
} from '../../infra/config/index.js';
import { getLanguageResourcesDir } from '../../infra/resources/index.js';
import { header, success, info, warn, error, blankLine } from '../../shared/ui/index.js';

export interface EjectOptions {
  global?: boolean;
  projectDir?: string;
}

/**
 * Eject a builtin piece to project or global space for customization.
 * Copies the piece YAML and related agent .md files, preserving
 * the directory structure so relative paths continue to work.
 */
export async function ejectBuiltin(name?: string, options: EjectOptions = {}): Promise<void> {
  header('Eject Builtin');

  const lang = getLanguage();
  const builtinPiecesDir = getBuiltinPiecesDir(lang);

  if (!name) {
    // List available builtins
    listAvailableBuiltins(builtinPiecesDir, options.global);
    return;
  }

  const builtinPath = join(builtinPiecesDir, `${name}.yaml`);
  if (!existsSync(builtinPath)) {
    error(`Builtin piece not found: ${name}`);
    info('Run "takt eject" to see available builtins.');
    return;
  }

  const projectDir = options.projectDir || process.cwd();
  const targetPiecesDir = options.global ? getGlobalPiecesDir() : getProjectPiecesDir(projectDir);
  const targetBaseDir = options.global ? dirname(getGlobalPersonasDir()) : dirname(getProjectPersonasDir(projectDir));
  const builtinBaseDir = getLanguageResourcesDir(lang);
  const targetLabel = options.global ? 'global (~/.takt/)' : 'project (.takt/)';

  info(`Ejecting to ${targetLabel}`);
  blankLine();

  // Copy piece YAML as-is (no path rewriting — directory structure mirrors builtin)
  const pieceDest = join(targetPiecesDir, `${name}.yaml`);
  if (existsSync(pieceDest)) {
    warn(`User piece already exists: ${pieceDest}`);
    warn('Skipping piece copy (user version takes priority).');
  } else {
    mkdirSync(dirname(pieceDest), { recursive: true });
    const content = readFileSync(builtinPath, 'utf-8');
    writeFileSync(pieceDest, content, 'utf-8');
    success(`Ejected piece: ${pieceDest}`);
  }

  // Copy related resource files (agents, personas, stances, instructions, report-formats)
  const resourceRefs = extractResourceRelativePaths(builtinPath);
  let copiedCount = 0;

  for (const ref of resourceRefs) {
    const srcPath = join(builtinBaseDir, ref.type, ref.path);
    const destPath = join(targetBaseDir, ref.type, ref.path);

    if (!existsSync(srcPath)) continue;

    if (existsSync(destPath)) {
      info(`  Already exists: ${destPath}`);
      continue;
    }

    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, readFileSync(srcPath));
    info(`  ${destPath}`);
    copiedCount++;
  }

  if (copiedCount > 0) {
    success(`${copiedCount} resource file(s) ejected.`);
  }
}

/** List available builtin pieces for ejection */
function listAvailableBuiltins(builtinPiecesDir: string, isGlobal?: boolean): void {
  if (!existsSync(builtinPiecesDir)) {
    warn('No builtin pieces found.');
    return;
  }

  info('Available builtin pieces:');
  blankLine();

  for (const entry of readdirSync(builtinPiecesDir).sort()) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    if (!statSync(join(builtinPiecesDir, entry)).isFile()) continue;

    const name = entry.replace(/\.ya?ml$/, '');
    info(`  ${name}`);
  }

  blankLine();
  const globalFlag = isGlobal ? ' --global' : '';
  info(`Usage: takt eject {name}${globalFlag}`);
  if (!isGlobal) {
    info('  Add --global to eject to ~/.takt/ instead of .takt/');
  }
}

/** Resource reference extracted from piece YAML */
interface ResourceRef {
  /** Resource type directory (personas, stances, instructions, report-formats) */
  type: string;
  /** Relative path within the resource type directory */
  path: string;
}

/** Known resource type directories that can be referenced from piece YAML */
const RESOURCE_TYPES = ['personas', 'stances', 'instructions', 'report-formats'];

/**
 * Extract resource relative paths from a builtin piece YAML.
 * Matches `../{type}/{path}` patterns for all known resource types.
 */
function extractResourceRelativePaths(piecePath: string): ResourceRef[] {
  const content = readFileSync(piecePath, 'utf-8');
  const seen = new Set<string>();
  const refs: ResourceRef[] = [];
  const typePattern = RESOURCE_TYPES.join('|');
  const regex = new RegExp(`\\.\\.\\/(?:${typePattern})\\/(.+)`, 'g');

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    // Re-parse to extract type and path separately
    const fullMatch = match[0];
    const typeMatch = fullMatch.match(/\.\.\/([^/]+)\/(.+)/);
    if (typeMatch?.[1] && typeMatch[2]) {
      const type = typeMatch[1];
      const path = typeMatch[2].trim();
      const key = `${type}/${path}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ type, path });
      }
    }
  }

  return refs;
}
