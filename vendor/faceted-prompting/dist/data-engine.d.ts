/**
 * DataEngine — abstract interface for facet data retrieval.
 *
 * Compose logic depends only on this interface; callers wire
 * concrete implementations (FileDataEngine, SqliteDataEngine, etc.).
 *
 * This module depends only on node:fs, node:path.
 */
import type { FacetKind, FacetContent } from './types.js';
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
export declare class FileDataEngine implements DataEngine {
    private readonly root;
    constructor(root: string);
    resolve(kind: FacetKind, key: string): Promise<FacetContent | undefined>;
    list(kind: FacetKind): Promise<string[]>;
}
/**
 * Chains multiple DataEngines with first-match-wins resolution.
 *
 * resolve() returns the first non-undefined result.
 * list() returns deduplicated keys from all engines.
 */
export declare class CompositeDataEngine implements DataEngine {
    private readonly engines;
    constructor(engines: readonly DataEngine[]);
    resolve(kind: FacetKind, key: string): Promise<FacetContent | undefined>;
    list(kind: FacetKind): Promise<string[]>;
}
