import { join } from 'node:path';
export const FACET_PARTIAL_KINDS = [
    'instructions',
    'policies',
    'knowledge',
    'output-contracts',
];
export function isFacetPartialKind(kind) {
    return FACET_PARTIAL_KINDS.some(facetPartialKind => facetPartialKind === kind);
}
export function facetPartialsFacetDir(kind) {
    return `partials/${kind}`;
}
export function facetPartialsDir(facetsRoot, kind) {
    return join(facetsRoot, facetPartialsFacetDir(kind));
}
export function facetPartialKindFromPath(path) {
    const segments = path.split(/[\\/]+/u);
    const partialsIndex = segments.lastIndexOf('partials');
    if (partialsIndex < 0) {
        return undefined;
    }
    const kind = segments[partialsIndex + 1];
    if (!kind || !isFacetPartialKind(kind)) {
        return undefined;
    }
    return kind;
}
