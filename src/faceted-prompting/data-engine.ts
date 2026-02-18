/**
 * DataEngine — abstract interface for facet data retrieval.
 *
 * Compose logic depends only on this interface; callers wire
 * concrete implementations (FileDataEngine, SqliteDataEngine, etc.).
 *
 * This module depends only on node:fs, node:path.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { FacetKind, FacetContent } from './types.js';

/** Plural-kind to directory name mapping (identity for all current kinds). */
const KIND_DIR: Record<FacetKind, string> = {
  personas: 'personas',
  policies: 'policies',
  knowledge: 'knowledge',
  instructions: 'instructions',
  'output-contracts': 'output-contracts',
};

/**
 * Abstract interface for facet data retrieval.
 *
 * Methods return Promises so that implementations backed by
 * async I/O (database, network) can be used without changes.
 */
export interface DataEngine {
  /**
   * Resolve a single facet by kind and key (name without extension).
   * Returns undefined if the facet does not exist.
   */
  resolve(kind: FacetKind, key: string): Promise<FacetContent | undefined>;

  /** List available facet keys for a given kind. */
  list(kind: FacetKind): Promise<string[]>;
}

/**
 * File-system backed DataEngine.
 *
 * Resolves facets from a single root directory using the convention:
 *   {root}/{kind}/{key}.md
 */
export class FileDataEngine implements DataEngine {
  constructor(private readonly root: string) {}

  async resolve(kind: FacetKind, key: string): Promise<FacetContent | undefined> {
    const dir = KIND_DIR[kind];
    const filePath = join(this.root, dir, `${key}.md`);
    if (!existsSync(filePath)) return undefined;
    const body = readFileSync(filePath, 'utf-8');
    return { body, sourcePath: filePath };
  }

  async list(kind: FacetKind): Promise<string[]> {
    const dir = KIND_DIR[kind];
    const dirPath = join(this.root, dir);
    if (!existsSync(dirPath)) return [];
    return readdirSync(dirPath)
      .filter(f => f.endsWith('.md'))
      .map(f => f.slice(0, -3));
  }
}

/**
 * Chains multiple DataEngines with first-match-wins resolution.
 *
 * resolve() returns the first non-undefined result.
 * list() returns deduplicated keys from all engines.
 */
export class CompositeDataEngine implements DataEngine {
  constructor(private readonly engines: readonly DataEngine[]) {
    if (engines.length === 0) {
      throw new Error('CompositeDataEngine requires at least one engine');
    }
  }

  async resolve(kind: FacetKind, key: string): Promise<FacetContent | undefined> {
    for (const engine of this.engines) {
      const result = await engine.resolve(kind, key);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  async list(kind: FacetKind): Promise<string[]> {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const engine of this.engines) {
      const keys = await engine.list(kind);
      for (const key of keys) {
        if (!seen.has(key)) {
          seen.add(key);
          result.push(key);
        }
      }
    }
    return result;
  }
}
