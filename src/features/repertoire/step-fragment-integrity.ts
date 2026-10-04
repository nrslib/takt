import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { collectStepFragmentUses, getOwnValue, isRecord } from '../../infra/config/loaders/workflowStepFragmentReader.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { STEP_FRAGMENT_EXTENSIONS } from './file-filter.js';

const FACET_POOL_EXTENSIONS = ['.yaml', '.yml'] as const;
const FACET_TYPES = ['policies', 'knowledge'] as const;

interface FragmentSource {
  content: string;
  path: string;
}

interface StepFragmentIntegrityOptions {
  sources: readonly FragmentSource[];
  packageRoot: string;
  copiedStepNames: ReadonlySet<string>;
  owner: string;
  repo: string;
}

function collectWorkflowUses(value: unknown, refs: Set<string>): void {
  if (!isRecord(value) || !Array.isArray(value.steps)) return;
  for (const step of value.steps) collectStepFragmentUses(step, refs);
}

function assertSourceReferencesAreCopied(source: FragmentSource, options: StepFragmentIntegrityOptions): void {
  const refs = new Set<string>();
  try {
    const parsed = parseYaml(source.content);
    if (source.path.startsWith('workflows/')) {
      collectWorkflowUses(parsed, refs);
    } else {
      collectStepFragmentUses(parsed, refs);
    }
  } catch (error) {
    throw new Error(`Configuration error in repertoire source ${sanitizeTerminalText(source.path)}: failed to inspect step fragment references`, { cause: error });
  }
  for (const ref of refs) {
    const selfScopedPrefix = `@${options.owner}/${options.repo}/`;
    const localName = ref.startsWith(selfScopedPrefix) ? ref.slice(selfScopedPrefix.length) : ref;
    if (localName.includes('/') || localName.includes('\\')) continue;
    const paths = STEP_FRAGMENT_EXTENSIONS.map((extension) => (
      join(options.packageRoot, 'steps', `${localName}${extension}`)
    ));
    if (paths.some((path) => existsSync(path)) && !options.copiedStepNames.has(localName)) {
      throw new Error(`Step fragment "${sanitizeTerminalText(localName)}" referenced by ${sanitizeTerminalText(source.path)} is excluded from package installation`);
    }
  }
}

export function assertCopiedStepFragmentReferences(options: StepFragmentIntegrityOptions): void {
  for (const source of options.sources) assertSourceReferencesAreCopied(source, options);
}

interface FacetPoolIntegrityOptions {
  sources: readonly FragmentSource[];
  packageRoot: string;
  copiedPoolNames: ReadonlySet<string>;
  copiedFacetNamesByType: ReadonlyMap<string, ReadonlySet<string>>;
  owner: string;
  repo: string;
}

type SectionMap = Record<string, string>;

function extractSectionMaps(parsed: unknown): { policies?: SectionMap; knowledge?: SectionMap } {
  if (!isRecord(parsed)) return {};
  const policies = isRecord(getOwnValue(parsed, 'policies')) ? getOwnValue(parsed, 'policies') as SectionMap : undefined;
  const knowledge = isRecord(getOwnValue(parsed, 'knowledge')) ? getOwnValue(parsed, 'knowledge') as SectionMap : undefined;
  return { policies, knowledge };
}

function extractInlinePoolSectionMaps(parsed: unknown): Map<string, { policies?: SectionMap; knowledge?: SectionMap }> {
  const result = new Map<string, { policies?: SectionMap; knowledge?: SectionMap }>();
  if (!isRecord(parsed)) return result;
  const facetPools = getOwnValue(parsed, 'facet_pools');
  if (!isRecord(facetPools)) return result;
  for (const [name, pool] of Object.entries(facetPools)) {
    if (!isRecord(pool)) continue;
    if ('uses' in pool) continue;
    result.set(name, extractSectionMaps(pool));
  }
  return result;
}

// Resolve a candidate facet ref (alias) through the pool's policies/knowledge maps.
// Returns the facet file basename (without extension) when the map points to a relative path,
// or the alias itself when no map entry exists (bare facet name fallback).
function resolveAliasFacetName(
  ref: string,
  sectionMaps: { policies?: SectionMap; knowledge?: SectionMap },
  facetType: (typeof FACET_TYPES)[number],
): string {
  const map = facetType === 'policies' ? sectionMaps.policies : sectionMaps.knowledge;
  if (map === undefined) return ref;
  const mapped = map[ref];
  if (mapped === undefined) return ref;
  // Map value is a relative path like ./facets/policies/x.md or ../facets/knowledge/y.md.
  // Extract the basename without extension as the facet file name.
  const base = mapped.split('/').pop();
  if (base === undefined) return ref;
  return base.replace(/\.md$/i, '');
}

function assertFacetPoolReferencesAreCopied(source: FragmentSource, options: FacetPoolIntegrityOptions): void {
  const refs = new Set<string>();
  let parsed: unknown;
  try {
    parsed = parseYaml(source.content);
    collectFacetPoolUses(parsed, refs);
  } catch (error) {
    throw new Error(`Configuration error in repertoire source ${sanitizeTerminalText(source.path)}: failed to inspect facet pool references`, { cause: error });
  }
  // Build alias resolution maps: pool-file's own sections + (for workflow sources) inline pool sections.
  const poolOwnSections = extractSectionMaps(parsed);
  const inlinePoolSections = extractInlinePoolSectionMaps(parsed);
  for (const ref of refs) {
    const selfScopedPrefix = `@${options.owner}/${options.repo}/`;
    const localName = ref.startsWith(selfScopedPrefix) ? ref.slice(selfScopedPrefix.length) : ref;
    if (localName.includes('/') || localName.includes('\\')) continue;
    const poolPaths = FACET_POOL_EXTENSIONS.map((extension) => (
      join(options.packageRoot, 'facet-pools', `${localName}${extension}`)
    ));
    if (poolPaths.some((path) => existsSync(path))) {
      if (!options.copiedPoolNames.has(localName)) {
        throw new Error(`Facet pool "${sanitizeTerminalText(localName)}" referenced by ${sanitizeTerminalText(source.path)} is excluded from package installation`);
      }
      continue;
    }
    // Try resolving the alias through each candidate facet type using the pool's section maps.
    let foundAsFacet = false;
    for (const facetType of FACET_TYPES) {
      const resolvedName = resolveAliasFacetName(localName, poolOwnSections, facetType);
      const facetPath = join(options.packageRoot, 'facets', facetType, `${resolvedName}.md`);
      if (existsSync(facetPath)) {
        foundAsFacet = true;
        const copied = options.copiedFacetNamesByType.get(facetType);
        if (copied === undefined || !copied.has(resolvedName)) {
          throw new Error(`Facet "${sanitizeTerminalText(resolvedName)}" (${facetType}) referenced by ${sanitizeTerminalText(source.path)} is excluded from package installation`);
        }
        break;
      }
      // For workflow sources, also check inline pool section maps for alias resolution.
      let foundInline = false;
      for (const sections of inlinePoolSections.values()) {
        const inlineResolved = resolveAliasFacetName(localName, sections, facetType);
        if (inlineResolved === localName) continue;
        const inlinePath = join(options.packageRoot, 'facets', facetType, `${inlineResolved}.md`);
        if (existsSync(inlinePath)) {
          foundInline = true;
          foundAsFacet = true;
          const copied = options.copiedFacetNamesByType.get(facetType);
          if (copied === undefined || !copied.has(inlineResolved)) {
            throw new Error(`Facet "${sanitizeTerminalText(inlineResolved)}" (${facetType}) referenced by ${sanitizeTerminalText(source.path)} is excluded from package installation`);
          }
          break;
        }
      }
      if (foundInline) break;
    }
    if (!foundAsFacet) continue;
  }
}

export function assertCopiedFacetPoolReferences(options: FacetPoolIntegrityOptions): void {
  for (const source of options.sources) assertFacetPoolReferencesAreCopied(source, options);
}

export function collectFacetPoolUses(value: unknown, refs = new Set<string>(), visited = new WeakSet<object>()): Set<string> {
  if (!isRecord(value)) return refs;
  if (visited.has(value)) return refs;
  visited.add(value);
  const facetPools = getOwnValue(value, 'facet_pools');
  if (isRecord(facetPools)) {
    for (const pool of Object.values(facetPools)) {
      if (!isRecord(pool)) continue;
      const uses = getOwnValue(pool, 'uses');
      if (typeof uses === 'string') {
        refs.add(uses);
      }
      const candidates = getOwnValue(pool, 'candidates');
      if (Array.isArray(candidates)) {
        for (const candidate of candidates) {
          if (!isRecord(candidate)) continue;
          const policy = getOwnValue(candidate, 'policy');
          if (typeof policy === 'string') refs.add(policy);
          else if (Array.isArray(policy)) {
            for (const p of policy) if (typeof p === 'string') refs.add(p);
          }
          const knowledge = getOwnValue(candidate, 'knowledge');
          if (typeof knowledge === 'string') refs.add(knowledge);
          else if (Array.isArray(knowledge)) {
            for (const k of knowledge) if (typeof k === 'string') refs.add(k);
          }
        }
      }
    }
  }
  return refs;
}
