export declare const FACET_PARTIAL_KINDS: readonly ["instructions", "policies", "knowledge", "output-contracts"];
export type FacetPartialKind = (typeof FACET_PARTIAL_KINDS)[number];
export declare function isFacetPartialKind(kind: string): kind is FacetPartialKind;
export declare function facetPartialsFacetDir(kind: FacetPartialKind): string;
export declare function facetPartialsDir(facetsRoot: string, kind: FacetPartialKind): string;
export declare function facetPartialKindFromPath(path: string): FacetPartialKind | undefined;
