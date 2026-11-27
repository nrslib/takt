export interface ExpandedFacetIncludes {
    readonly body: string;
    readonly sourcePaths: readonly string[];
}
export declare function expandFacetIncludes(params: {
    body: string;
    facetsRoots: readonly string[];
    repertoireDirs: readonly string[];
    allowedRoots: readonly string[];
}): ExpandedFacetIncludes;
