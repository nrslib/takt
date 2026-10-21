export declare function isWithinRoot(path: string, root: string): boolean;
export declare function ensurePathWithinHome(path: string, homeDir: string, label: string): {
    resolvedPath: string;
    homeRealPath: string;
};
export declare function ensurePathWithinRoots(path: string, roots: readonly string[], label: string): string;
export declare function ensurePathWithinAllowedRoots(path: string, roots: readonly string[], label: string): string;
export declare function ensurePathIsNotSymbolicLink(path: string, label: string): string;
export declare function ensurePathAncestorsContainNoSymbolicLinks(path: string, label: string, stopAtPath?: string): string;
export declare function ensurePathAncestorsAndRealPathWithinHome(path: string, homeDir: string, label: string): {
    resolvedPath: string;
    homeRealPath: string;
};
export declare function ensurePathAncestorsAndRealPathWithinAllowedRoots(path: string, roots: readonly string[], label: string): {
    resolvedPath: string;
    allowedRootRealPaths: readonly string[];
};
