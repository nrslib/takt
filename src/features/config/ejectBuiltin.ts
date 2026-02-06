/**
 * /eject command implementation
 *
 * Copies a builtin piece (and its agents) for user customization.
 * Directory structure is mirrored so relative agent paths work as-is.
 *
 * Default target: project-local (.takt/)
 * With --global: user global (~/.takt/)
 */

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  getGlobalPiecesDir,
  getGlobalAgentsDir,
  getProjectPiecesDir,
  getProjectAgentsDir,
  getBuiltinPiecesDir,
  getBuiltinAgentsDir,
  getLanguage,
} from '../../infra/config/index.js';
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
  const targetAgentsDir = options.global ? getGlobalAgentsDir() : getProjectAgentsDir(projectDir);
  const builtinAgentsDir = getBuiltinAgentsDir(lang);
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

  // Copy related agent files
  const agentPaths = extractAgentRelativePaths(builtinPath);
  let copiedAgents = 0;

  for (const relPath of agentPaths) {
    const srcPath = join(builtinAgentsDir, relPath);
    const destPath = join(targetAgentsDir, relPath);

    if (!existsSync(srcPath)) continue;

    if (existsSync(destPath)) {
      info(`  Agent already exists: ${destPath}`);
      continue;
    }

    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, readFileSync(srcPath));
    info(`  ✓ ${destPath}`);
    copiedAgents++;
  }

  if (copiedAgents > 0) {
    success(`${copiedAgents} agent file(s) ejected.`);
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

/**
 * Extract agent relative paths from a builtin piece YAML.
 * Matches `agent: ../agents/{path}` and returns the {path} portions.
 */
function extractAgentRelativePaths(piecePath: string): string[] {
  const content = readFileSync(piecePath, 'utf-8');
  const paths = new Set<string>();
  const regex = /agent:\s*\.\.\/agents\/(.+)/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[1]) {
      paths.add(match[1].trim());
    }
  }

  return Array.from(paths);
}
