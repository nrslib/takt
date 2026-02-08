/**
 * Facet catalog — scan and display available facets across 3 layers.
 *
 * Scans builtin, user (~/.takt/), and project (.takt/) directories
 * for facet files (.md) and displays them with layer provenance.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import chalk from 'chalk';
import type { PieceSource } from '../../infra/config/loaders/pieceResolver.js';
import { getLanguageResourcesDir } from '../../infra/resources/index.js';
import { getGlobalConfigDir, getProjectConfigDir } from '../../infra/config/paths.js';
import { getLanguage, getBuiltinPiecesEnabled } from '../../infra/config/global/globalConfig.js';
import { section, error as logError, info } from '../../shared/ui/index.js';

const FACET_TYPES = [
  'personas',
  'policies',
  'knowledge',
  'instructions',
  'output-contracts',
] as const;

export type FacetType = (typeof FACET_TYPES)[number];

export interface FacetEntry {
  name: string;
  description: string;
  source: PieceSource;
  overriddenBy?: PieceSource;
}

/** Validate a string as a FacetType. Returns the type or null. */
export function parseFacetType(input: string): FacetType | null {
  if ((FACET_TYPES as readonly string[]).includes(input)) {
    return input as FacetType;
  }
  return null;
}

/**
 * Extract description from a markdown file.
 * Returns the first `# ` heading text, or falls back to the first non-empty line.
 */
export function extractDescription(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  let firstNonEmpty = '';
  for (const line of content.split('\n')) {
    if (line.startsWith('# ')) {
      return line.slice(2).trim();
    }
    if (!firstNonEmpty && line.trim()) {
      firstNonEmpty = line.trim();
    }
  }
  return firstNonEmpty;
}

/** Build the 3-layer directory list for a given facet type. */
function getFacetDirs(
  facetType: FacetType,
  cwd: string,
): { dir: string; source: PieceSource }[] {
  const dirs: { dir: string; source: PieceSource }[] = [];

  if (getBuiltinPiecesEnabled()) {
    const lang = getLanguage();
    dirs.push({ dir: join(getLanguageResourcesDir(lang), facetType), source: 'builtin' });
  }

  dirs.push({ dir: join(getGlobalConfigDir(), facetType), source: 'user' });
  dirs.push({ dir: join(getProjectConfigDir(cwd), facetType), source: 'project' });

  return dirs;
}

/** Scan a single directory for .md facet files. */
function scanDirectory(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md'));
}

/**
 * Scan all layers for facets of a given type.
 *
 * Scans builtin → user → project in order.
 * When a facet name appears in a higher-priority layer, the lower-priority
 * entry gets `overriddenBy` set to the overriding layer.
 */
export function scanFacets(facetType: FacetType, cwd: string): FacetEntry[] {
  const dirs = getFacetDirs(facetType, cwd);
  const entriesByName = new Map<string, FacetEntry>();
  const allEntries: FacetEntry[] = [];

  for (const { dir, source } of dirs) {
    const files = scanDirectory(dir);
    for (const file of files) {
      const name = basename(file, '.md');
      const description = extractDescription(join(dir, file));
      const entry: FacetEntry = { name, description, source };

      const existing = entriesByName.get(name);
      if (existing) {
        existing.overriddenBy = source;
      }

      entriesByName.set(name, entry);
      allEntries.push(entry);
    }
  }

  return allEntries;
}

/** Color a source tag for terminal display. */
function colorSourceTag(source: PieceSource): string {
  switch (source) {
    case 'builtin':
      return chalk.gray(`[${source}]`);
    case 'user':
      return chalk.yellow(`[${source}]`);
    case 'project':
      return chalk.green(`[${source}]`);
  }
}

/** Format and print a list of facet entries for one facet type. */
export function displayFacets(facetType: FacetType, entries: FacetEntry[]): void {
  section(`${capitalize(facetType)}:`);

  if (entries.length === 0) {
    console.log(chalk.gray('  (none)'));
    return;
  }

  const maxNameLen = Math.max(...entries.map((e) => e.name.length));
  const maxDescLen = Math.max(...entries.map((e) => e.description.length));

  for (const entry of entries) {
    const name = entry.name.padEnd(maxNameLen + 2);
    const desc = entry.description.padEnd(maxDescLen + 2);
    const tag = colorSourceTag(entry.source);
    const override = entry.overriddenBy
      ? chalk.gray(` (overridden by ${entry.overriddenBy})`)
      : '';
    console.log(`  ${name}${chalk.dim(desc)}${tag}${override}`);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Main entry point: show facet catalog.
 *
 * If facetType is provided, shows only that type.
 * Otherwise shows all facet types.
 */
export function showCatalog(cwd: string, facetType?: string): void {
  if (facetType !== undefined) {
    const parsed = parseFacetType(facetType);
    if (!parsed) {
      logError(`Unknown facet type: "${facetType}"`);
      info(`Available types: ${FACET_TYPES.join(', ')}`);
      return;
    }
    const entries = scanFacets(parsed, cwd);
    displayFacets(parsed, entries);
    return;
  }

  for (const type of FACET_TYPES) {
    const entries = scanFacets(type, cwd);
    displayFacets(type, entries);
  }
}
