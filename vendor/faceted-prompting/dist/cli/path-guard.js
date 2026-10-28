import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
export function isWithinRoot(path, root) {
    return path === root || path.startsWith(`${root}${sep}`);
}
export function ensurePathWithinHome(path, homeDir, label) {
    const resolvedPath = resolve(path);
    const resolvedHomeDir = resolve(homeDir);
    const homeRealPath = realpathSync(resolvedHomeDir);
    if (!isWithinRoot(resolvedPath, resolvedHomeDir)) {
        throw new Error(`${label} must be inside home directory: ${resolvedPath}`);
    }
    return { resolvedPath, homeRealPath };
}
export function ensurePathWithinRoots(path, roots, label) {
    const resolvedPath = resolve(path);
    if (!existsSync(resolvedPath)) {
        throw new Error(`Missing ${label}: ${resolvedPath}`);
    }
    const pathStat = lstatSync(resolvedPath);
    if (pathStat.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed for ${label}: ${resolvedPath}`);
    }
    const realPath = realpathSync(resolvedPath);
    for (const root of roots) {
        const resolvedRoot = resolve(root);
        const realRoot = existsSync(resolvedRoot) ? realpathSync(resolvedRoot) : resolvedRoot;
        if (isWithinRoot(realPath, realRoot)) {
            return realPath;
        }
    }
    throw new Error(`${label} must be inside allowed facets directory: ${realPath}`);
}
export function ensurePathWithinAllowedRoots(path, roots, label) {
    const resolvedPath = resolve(path);
    const resolvedRoots = roots.map(root => resolve(root));
    if (!resolvedRoots.some(root => isWithinRoot(resolvedPath, root))) {
        throw new Error(`${label} must be inside allowed roots: ${resolvedPath}`);
    }
    return resolvedPath;
}
export function ensurePathIsNotSymbolicLink(path, label) {
    const resolvedPath = resolve(path);
    if (!existsSync(resolvedPath)) {
        return resolvedPath;
    }
    const stat = lstatSync(resolvedPath);
    if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed for ${label}: ${resolvedPath}`);
    }
    return resolvedPath;
}
function findNearestExistingAncestor(path) {
    let current = path;
    while (!existsSync(current)) {
        const parent = dirname(current);
        if (parent === current) {
            throw new Error(`No existing ancestor found for path: ${path}`);
        }
        current = parent;
    }
    return current;
}
export function ensurePathAncestorsContainNoSymbolicLinks(path, label, stopAtPath) {
    const resolvedPath = resolve(path);
    const resolvedStopAtPath = stopAtPath ? resolve(stopAtPath) : undefined;
    const nearestExistingAncestor = findNearestExistingAncestor(resolvedPath);
    let current = resolvedPath;
    while (true) {
        if (existsSync(current)) {
            const stat = lstatSync(current);
            if (stat.isSymbolicLink()) {
                throw new Error(`Symbolic links are not allowed in ${label} path: ${current}`);
            }
        }
        if (current === nearestExistingAncestor) {
            break;
        }
        const parent = dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    if (!resolvedStopAtPath || !isWithinRoot(nearestExistingAncestor, resolvedStopAtPath)) {
        return resolvedPath;
    }
    current = dirname(nearestExistingAncestor);
    while (true) {
        if (existsSync(current)) {
            const stat = lstatSync(current);
            if (stat.isSymbolicLink()) {
                throw new Error(`Symbolic links are not allowed in ${label} path: ${current}`);
            }
        }
        if (current === resolvedStopAtPath) {
            break;
        }
        const parent = dirname(current);
        if (parent === current) {
            break;
        }
        if (!isWithinRoot(parent, resolvedStopAtPath)) {
            break;
        }
        current = parent;
    }
    return resolvedPath;
}
export function ensurePathAncestorsAndRealPathWithinHome(path, homeDir, label) {
    const { resolvedPath, homeRealPath } = ensurePathWithinHome(path, homeDir, label);
    const resolvedHomeDir = resolve(homeDir);
    ensurePathAncestorsContainNoSymbolicLinks(resolvedPath, label, resolvedHomeDir);
    const existingAncestor = findNearestExistingAncestor(resolvedPath);
    const ancestorRealPath = realpathSync(existingAncestor);
    if (!isWithinRoot(ancestorRealPath, homeRealPath)) {
        throw new Error(`${label} must resolve inside home directory: ${resolvedPath}`);
    }
    return { resolvedPath, homeRealPath };
}
export function ensurePathAncestorsAndRealPathWithinAllowedRoots(path, roots, label) {
    const resolvedPath = ensurePathWithinAllowedRoots(path, roots, label);
    const resolvedRoots = roots.map(root => resolve(root));
    const containingRoot = resolvedRoots.find(root => isWithinRoot(resolvedPath, root));
    if (!containingRoot) {
        throw new Error(`${label} must be inside allowed roots: ${resolvedPath}`);
    }
    ensurePathAncestorsContainNoSymbolicLinks(resolvedPath, label, containingRoot);
    const existingAncestor = findNearestExistingAncestor(resolvedPath);
    const ancestorRealPath = realpathSync(existingAncestor);
    const allowedRootRealPaths = resolvedRoots.map(root => (existsSync(root) ? realpathSync(root) : root));
    const containingRootRealPath = existsSync(containingRoot) ? realpathSync(containingRoot) : undefined;
    if (containingRootRealPath && !isWithinRoot(ancestorRealPath, containingRootRealPath)) {
        throw new Error(`${label} must resolve inside allowed roots: ${resolvedPath}`);
    }
    return { resolvedPath, allowedRootRealPaths };
}
