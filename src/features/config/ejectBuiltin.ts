/**
 * /eject command implementation
 *
 * Copies a builtin workflow YAML for user customization.
 * Also supports ejecting individual facets (persona, policy, etc.)
 * to override builtins via layer resolution.
 *
 * Default target: project-local (.takt/)
 * With --global: user global (~/.takt/)
 */

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { FacetType } from '../../infra/config/paths.js';
import {
  getGlobalPiecesDir,
  getProjectPiecesDir,
  getBuiltinPiecesDir,
  getProjectFacetDir,
  getGlobalFacetDir,
  getBuiltinFacetDir,
  getLanguage,
} from '../../infra/config/index.js';
import { header, success, info, warn, error, blankLine } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';

export interface EjectOptions {
  global?: boolean;
  projectDir: string;
}

/** Singular CLI facet type names mapped to directory (plural) FacetType */
const FACET_TYPE_MAP: Record<string, FacetType> = {
  persona: 'personas',
  policy: 'policies',
  knowledge: 'knowledge',
  instruction: 'instructions',
  'output-contract': 'output-contracts',
};

/** Valid singular facet type names for CLI */
export const VALID_FACET_TYPES = Object.keys(FACET_TYPE_MAP);

/**
 * Parse singular CLI facet type to plural directory FacetType.
 * Returns undefined if the input is not a valid facet type.
 */
export function parseFacetType(singular: string): FacetType | undefined {
  return FACET_TYPE_MAP[singular];
}

/**
 * Eject a builtin workflow YAML to project or global space for customization.
 * Only copies the workflow YAML — facets are resolved via layer system.
 */
export async function ejectBuiltin(name: string | undefined, options: EjectOptions): Promise<void> {
  header('Eject Builtin');

  const lang = getLanguage();
  const builtinPiecesDir = getBuiltinPiecesDir(lang);

  if (!name) {
    listAvailableBuiltins(builtinPiecesDir, options.global);
    return;
  }

  const builtinPath = join(builtinPiecesDir, `${name}.yaml`);
  const safeName = sanitizeTerminalText(name);
  if (!existsSync(builtinPath)) {
    error(`Builtin workflow not found: ${safeName}`);
    info('Run "takt eject" to see available builtins.');
    return;
  }

  const targetPiecesDir = options.global ? getGlobalPiecesDir() : getProjectPiecesDir(options.projectDir);
  const targetLabel = options.global ? 'global (~/.takt/)' : 'project (.takt/)';

  info(`Ejecting workflow YAML to ${targetLabel}`);
  blankLine();

  const pieceDest = join(targetPiecesDir, `${name}.yaml`);
  const safePieceDest = sanitizeTerminalText(pieceDest);
  if (existsSync(pieceDest)) {
    warn(`User workflow already exists: ${safePieceDest}`);
    warn('Skipping workflow copy (user version takes priority).');
  } else {
    mkdirSync(dirname(pieceDest), { recursive: true });
    const content = readFileSync(builtinPath, 'utf-8');
    writeFileSync(pieceDest, content, 'utf-8');
    success(`Ejected workflow: ${safePieceDest}`);
  }
}

/**
 * Eject an individual facet from builtin to upper layer for customization.
 * Copies the builtin facet .md file to project (.takt/{type}/) or global (~/.takt/{type}/).
 */
export async function ejectFacet(
  facetType: FacetType,
  name: string,
  options: EjectOptions,
): Promise<void> {
  header('Eject Facet');

  const lang = getLanguage();
  const builtinDir = getBuiltinFacetDir(lang, facetType);
  const srcPath = join(builtinDir, `${name}.md`);

  if (!existsSync(srcPath)) {
    error(`Builtin ${facetType}/${name}.md not found`);
    info(`Available ${facetType}:`);
    listAvailableFacets(builtinDir);
    return;
  }

  const targetDir = options.global
    ? getGlobalFacetDir(facetType)
    : getProjectFacetDir(options.projectDir, facetType);
  const targetLabel = options.global ? 'global (~/.takt/)' : 'project (.takt/)';
  const destPath = join(targetDir, `${name}.md`);

  info(`Ejecting ${facetType}/${name} to ${targetLabel}`);
  blankLine();

  if (existsSync(destPath)) {
    warn(`Already exists: ${destPath}`);
    warn('Skipping copy (existing file takes priority).');
    return;
  }

  mkdirSync(dirname(destPath), { recursive: true });
  const content = readFileSync(srcPath, 'utf-8');
  writeFileSync(destPath, content, 'utf-8');
  success(`Ejected: ${destPath}`);
}

/** List available builtin workflows for ejection */
function listAvailableBuiltins(builtinPiecesDir: string, isGlobal?: boolean): void {
  if (!existsSync(builtinPiecesDir)) {
    warn('No builtin workflows found.');
    return;
  }

  info('Available builtin workflows:');
  blankLine();

  for (const entry of readdirSync(builtinPiecesDir).sort()) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    if (!statSync(join(builtinPiecesDir, entry)).isFile()) continue;

    const name = entry.replace(/\.ya?ml$/, '');
    info(`  ${sanitizeTerminalText(name)}`);
  }

  blankLine();
  const globalFlag = isGlobal ? ' --global' : '';
  info(`Usage: takt eject {name}${globalFlag}`);
  info(`  Eject individual facet: takt eject {type} {name}${globalFlag}`);
  info(`  Types: ${VALID_FACET_TYPES.join(', ')}`);
  if (!isGlobal) {
    info('  Add --global to eject to ~/.takt/ instead of .takt/');
  }
}

/** List available facet files in a builtin directory */
function listAvailableFacets(builtinDir: string): void {
  if (!existsSync(builtinDir)) {
    info('  (none)');
    return;
  }

  for (const entry of readdirSync(builtinDir).sort()) {
    if (!entry.endsWith('.md')) continue;
    if (!statSync(join(builtinDir, entry)).isFile()) continue;
    info(`  ${sanitizeTerminalText(entry.replace(/\.md$/, ''))}`);
  }
}
