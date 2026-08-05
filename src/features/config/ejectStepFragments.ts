import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  getBuiltinLanguageStepsDir,
  getGlobalStepsDir,
  getRepertoireDir,
} from '../../infra/config/paths.js';
import { resolveWorkflowStepFragments } from '../../infra/config/loaders/workflowStepFragmentResolver.js';
import type { Language } from '../../core/models/index.js';
import { isPathInside } from '../../shared/utils/pathBoundary.js';
import { ensureCurrentTmpDirExists } from '../../shared/utils/index.js';
import { warn } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';

interface PlannedStepFragmentCopy {
  sourcePath: string;
}

interface EjectStepFragmentPlan {
  copies: readonly PlannedStepFragmentCopy[];
  stagedSources: ReadonlyMap<string, string>;
  retainedPaths: readonly string[];
}

function isSamePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function removeEmptyEjectDirectories(paths: readonly string[]): void {
  for (const path of [...paths].reverse()) {
    try {
      rmdirSync(path);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        continue;
      }
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOTEMPTY') {
        return;
      }
      throw error;
    }
  }
}

function ensureSafeEjectDirectory(trustedRoot: string, targetDir: string): () => void {
  const root = resolve(trustedRoot);
  const target = resolve(targetDir);
  if (!isPathInside(root, target)) {
    throw new Error(`Eject target escapes trusted root: ${target}`);
  }
  const rootStats = lstatIfExists(root);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Eject trusted root must be a non-symlink directory: ${root}`);
  }
  const createdPaths: string[] = [];
  let current = root;
  try {
    for (const segment of relative(root, target).split(sep).filter(Boolean)) {
      current = join(current, segment);
      const stats = lstatIfExists(current);
      if (stats === undefined) {
        mkdirSync(current);
        createdPaths.push(current);
        continue;
      }
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Eject target directory must not be a symlink: ${current}`);
      }
    }
  } catch (error) {
    removeEmptyEjectDirectories(createdPaths);
    throw error;
  }
  return () => removeEmptyEjectDirectories(createdPaths);
}

export function pathExistsForEject(path: string): boolean {
  const stats = lstatIfExists(path);
  if (stats?.isSymbolicLink()) {
    throw new Error(`Eject target file must not be a symlink: ${resolve(path)}`);
  }
  return stats !== undefined;
}

export function writeNewEjectedFile(trustedRoot: string, targetPath: string, content: string): () => void {
  const target = resolve(targetPath);
  const rollbackDirectories = ensureSafeEjectDirectory(trustedRoot, dirname(target));
  try {
    const existing = lstatIfExists(target);
    if (existing !== undefined) {
      if (existing.isSymbolicLink()) {
        throw new Error(`Eject target file must not be a symlink: ${target}`);
      }
      throw new Error(`Eject target file already exists: ${target}`);
    }
    const descriptor = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let written = false;
    let closed = false;
    try {
      writeFileSync(descriptor, content, 'utf-8');
      written = true;
    } finally {
      try {
        closeSync(descriptor);
        closed = true;
      } finally {
        if (!written || !closed) {
          rmSync(target, { force: true });
        }
      }
    }
  } catch (error) {
    rollbackDirectories();
    throw error;
  }
  return rollbackDirectories;
}

function createEjectStepFragmentPlan(
  workflowContent: string,
  lang: Language,
  targetDir: string,
  workflowPath: string,
  isProjectEject: boolean,
): EjectStepFragmentPlan {
  const builtinLanguageDir = getBuiltinLanguageStepsDir(lang);
  const outputCandidateDirs = [targetDir, getGlobalStepsDir(), builtinLanguageDir];
  const copiesByName = new Map<string, PlannedStepFragmentCopy>();
  const stagedSources = new Map<string, string>();
  const retainedPaths = new Set<string>();
  const projectDir = isProjectEject ? dirname(dirname(targetDir)) : dirname(targetDir);
  const parsed = parseYaml(workflowContent);
  const dependencies = resolveWorkflowStepFragments(parsed, {
    workflowPath,
    candidateDirs: outputCandidateDirs,
    context: {
      lang,
      projectDir,
      workflowDir: dirname(workflowPath),
      repertoireDir: getRepertoireDir(),
    },
    trustInfo: {
      source: 'user',
      sourcePath: workflowPath,
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    },
    nestedCandidateDirs: (fragment) => {
      const sourceIsBuiltin = isSamePath(fragment.candidateDir, builtinLanguageDir);
      return sourceIsBuiltin ? [targetDir, ...fragment.candidateDirs] : undefined;
    },
  }).dependencies;

  for (const dependency of dependencies) {
    const sourceIsTarget = isSamePath(dependency.sourceRoot, targetDir);
    const sourceIsBuiltin = isSamePath(dependency.sourceRoot, builtinLanguageDir);
    if (sourceIsTarget) {
      stagedSources.set(basename(dependency.sourcePath), dependency.sourcePath);
      retainedPaths.add(dependency.sourcePath);
      continue;
    }
    if (!sourceIsBuiltin) continue;
    const name = basename(dependency.sourcePath);
    const existing = copiesByName.get(name);
    if (existing && !isSamePath(existing.sourcePath, dependency.sourcePath)) {
      throw new Error(`Configuration error in workflow ${workflowPath}: step fragment "${dependency.ref}" resolves to conflicting sources during eject: ${existing.sourcePath} and ${dependency.sourcePath}`);
    }
    copiesByName.set(name, { sourcePath: dependency.sourcePath });
    stagedSources.set(name, dependency.sourcePath);
  }
  return { copies: [...copiesByName.values()], stagedSources, retainedPaths: [...retainedPaths] };
}

function validateEjectStepFragmentPlan(
  plan: EjectStepFragmentPlan,
  workflowContent: string,
  lang: Language,
  isProjectEject: boolean,
): void {
  const stagingProjectDir = mkdtempSync(join(ensureCurrentTmpDirExists(), 'takt-eject-step-fragments-'));
  try {
    const stagingStepsDir = join(stagingProjectDir, '.takt', 'steps');
    mkdirSync(stagingStepsDir, { recursive: true });
    for (const [name, sourcePath] of plan.stagedSources) {
      copyFileSync(sourcePath, join(stagingStepsDir, name));
    }
    const stagingWorkflowPath = join(stagingProjectDir, '.takt', 'workflows', 'ejected.yaml');
    mkdirSync(dirname(stagingWorkflowPath), { recursive: true });
    writeFileSync(stagingWorkflowPath, workflowContent, 'utf-8');
    resolveWorkflowStepFragments(parseYaml(workflowContent), {
      workflowPath: stagingWorkflowPath,
      candidateDirs: [stagingStepsDir, getGlobalStepsDir(), getBuiltinLanguageStepsDir(lang)],
      context: {
        lang,
        projectDir: stagingProjectDir,
        workflowDir: dirname(stagingWorkflowPath),
        repertoireDir: getRepertoireDir(),
      },
      trustInfo: isProjectEject
        ? {
            source: 'project',
            sourcePath: stagingWorkflowPath,
            isProjectTrustRoot: true,
            isProjectWorkflowRoot: true,
          }
        : {
            source: 'user',
            sourcePath: stagingWorkflowPath,
            isProjectTrustRoot: false,
            isProjectWorkflowRoot: false,
          },
    });
  } finally {
    rmSync(stagingProjectDir, { recursive: true, force: true });
  }
}

export function copyReferencedBuiltinStepFragments(
  workflowContent: string,
  lang: Language,
  targetDir: string,
  workflowPath: string,
  isProjectEject: boolean,
): () => void {
  const plan = createEjectStepFragmentPlan(workflowContent, lang, targetDir, workflowPath, isProjectEject);
  validateEjectStepFragmentPlan(plan, workflowContent, lang, isProjectEject);

  for (const retainedPath of plan.retainedPaths) {
    warn(`User step fragment already exists: ${sanitizeTerminalText(retainedPath)}`);
    warn('Skipping step fragment copy (user version takes priority).');
  }

  const trustedRoot = dirname(dirname(targetDir));
  const targetDirExisted = pathExistsForEject(targetDir);
  const createdPaths: string[] = [];
  const rollbackDirectories: Array<() => void> = [];
  const rollback = (): void => {
    for (const path of [...createdPaths].reverse()) rmSync(path, { force: true });
    if (!targetDirExisted && existsSync(targetDir)) removeEmptyEjectDirectories([targetDir]);
    for (const rollbackDirectory of [...rollbackDirectories].reverse()) rollbackDirectory();
  };

  try {
    for (const fragment of plan.copies) {
      const targetPath = join(targetDir, basename(fragment.sourcePath));
      if (pathExistsForEject(targetPath)) {
        warn(`User step fragment already exists: ${sanitizeTerminalText(targetPath)}`);
        warn('Skipping step fragment copy (user version takes priority).');
        continue;
      }
      rollbackDirectories.push(writeNewEjectedFile(
        trustedRoot,
        targetPath,
        readFileSync(fragment.sourcePath, 'utf-8'),
      ));
      createdPaths.push(targetPath);
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return rollback;
}

export function copyReferencedBuiltinFacetPools(
  workflowContent: string,
  lang: Language,
  targetDir: string,
  workflowPath: string,
  isProjectEject: boolean,
  builtinSourceDir: string,
  builtinBoundaryDir: string,
): () => void {
  const trustedRoot = dirname(dirname(targetDir));
  const targetDirExisted = pathExistsForEject(targetDir);
  const createdPaths: string[] = [];
  const rollbackDirectories: Array<() => void> = [];
  const rollback = (): void => {
    for (const path of [...createdPaths].reverse()) rmSync(path, { force: true });
    if (!targetDirExisted && existsSync(targetDir)) removeEmptyEjectDirectories([targetDir]);
    for (const rollbackDirectory of [...rollbackDirectories].reverse()) rollbackDirectory();
  };

  const parsed = parseYaml(workflowContent) as Record<string, unknown>;
  const facetPools = parsed?.facet_pools;
  if (!isPlainObjectRecord(facetPools)) return rollback;
  const poolNames = new Set<string>();
  for (const pool of Object.values(facetPools)) {
    if (!isPlainObjectRecord(pool)) continue;
    const uses = pool.uses;
    if (typeof uses === 'string') {
      poolNames.add(uses);
    }
  }

  try {
    for (const name of poolNames) {
      let sourcePoolPath: string | undefined;
      for (const ext of ['.yaml', '.yml']) {
        const candidate = join(builtinSourceDir, `${name}${ext}`);
        if (existsSync(candidate)) {
          sourcePoolPath = candidate;
          break;
        }
      }
      if (sourcePoolPath === undefined) continue;
      const poolContent = readFileSync(sourcePoolPath, 'utf-8');
      const targetPoolPath = join(targetDir, basename(sourcePoolPath));
      if (pathExistsForEject(targetPoolPath)) {
        warn(`User facet pool already exists: ${sanitizeTerminalText(targetPoolPath)}`);
        warn('Skipping facet pool copy (user version takes priority).');
      } else {
        rollbackDirectories.push(writeNewEjectedFile(trustedRoot, targetPoolPath, poolContent));
        createdPaths.push(targetPoolPath);
      }
      const poolParsed = parseYaml(poolContent) as Record<string, unknown>;
      const facetSections: Array<{ map: Record<string, string> | undefined }> = [
        { map: isPlainObjectRecord(poolParsed.policies) ? poolParsed.policies as Record<string, string> : undefined },
        { map: isPlainObjectRecord(poolParsed.knowledge) ? poolParsed.knowledge as Record<string, string> : undefined },
      ];
      for (const { map } of facetSections) {
        if (!map) continue;
        for (const relPath of Object.values(map)) {
          if (typeof relPath !== 'string') continue;
          const sourceFacetPath = resolve(builtinSourceDir, relPath);
          if (!existsSync(sourceFacetPath)) continue;
          // Builtin pools own facets live under builtins/<lang>/facets/, which is a sibling of
          // builtins/<lang>/facet-pools/. The copy boundary must be the builtin language resources
          // root (builtins/<lang>/) so pool-referenced facets are copied, while still rejecting
          // paths that escape the language resource root.
          if (!isPathInside(builtinBoundaryDir, sourceFacetPath)) continue;
          // Mirror the facet's position relative to the builtin language root into the eject
          // target's language root (dirname(targetDir) = .takt/ for project eject). This keeps
          // ../facets/... references in the ejected pool file resolvable from targetDir.
          const targetLanguageRoot = dirname(targetDir);
          const relativeFacetPath = relative(builtinBoundaryDir, sourceFacetPath);
          const targetFacetPath = join(targetLanguageRoot, relativeFacetPath);
          if (pathExistsForEject(targetFacetPath)) {
            warn(`User facet file already exists: ${sanitizeTerminalText(targetFacetPath)}`);
            warn('Skipping facet copy (user version takes priority).');
            continue;
          }
          rollbackDirectories.push(writeNewEjectedFile(trustedRoot, targetFacetPath, readFileSync(sourceFacetPath, 'utf-8')));
          createdPaths.push(targetFacetPath);
        }
      }
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return rollback;
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
