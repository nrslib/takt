export function readNpmDepsFetcherVersion(flakeSource: string): string;

export function replaceNpmDepsHash(flakeSource: string, hash: string): string;

export function summarizeLockChanges(beforeLock: string, afterLock: string): string[];
