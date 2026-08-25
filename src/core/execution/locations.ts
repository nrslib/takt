import { isAbsolute, relative, resolve } from 'node:path';
import { buildRunPathsFromRunsDirectory, type RunPaths } from '../workflow/run/run-paths.js';

/** The three directories a task execution is allowed to use. */
export interface ExecutionLocations {
  readonly projectDirectory: string;
  readonly executionDirectory: string;
  readonly stateDirectory: string;
}

export interface StatePaths {
  readonly stateDirectory: string;
  readonly stateFile: string;
  readonly tasksFile: string;
  readonly tasksDirectory: string;
  readonly runsDirectory: string;
  readonly sessionsDirectory: string;
  readonly worktreeMetadataDirectory: string;
  readonly eventsDirectory: string;
  readonly locksDirectory: string;
  /** Fingerprint persisted by the central state owner for the runs root. */
  readonly runsRootFingerprint?: Readonly<{ readonly dev: number; readonly ino: number }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function assertAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  return resolve(path);
}

/**
 * Resolve the central, channel-neutral state namespace.  This function is
 * deliberately pure: callers decide when and how to create the directories.
 */
export function resolveStatePaths(globalConfigDirectory: string, stateId: string): StatePaths {
  const globalRoot = assertAbsolute(globalConfigDirectory, 'globalConfigDirectory');
  if (!UUID_PATTERN.test(stateId)) throw new Error('stateId is invalid');
  const stateDirectory = resolve(globalRoot, 'state', 'projects', stateId);
  return {
    stateDirectory,
    stateFile: resolve(stateDirectory, 'state.json'),
    tasksFile: resolve(stateDirectory, 'tasks.yaml'),
    tasksDirectory: resolve(stateDirectory, 'tasks'),
    runsDirectory: resolve(stateDirectory, 'runs'),
    sessionsDirectory: resolve(stateDirectory, 'sessions'),
    worktreeMetadataDirectory: resolve(stateDirectory, 'worktree-metadata'),
    eventsDirectory: resolve(stateDirectory, 'events'),
    locksDirectory: resolve(stateDirectory, 'locks'),
  };
}

export function resolveRunPaths(statePaths: StatePaths, runId: string): RunPaths {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)) throw new Error('runId is invalid');
  const paths = buildRunPathsFromRunsDirectory(statePaths.runsDirectory, runId);
  assertContained(statePaths.runsDirectory, paths.runRootAbs, 'runRoot');
  return paths;
}

export function assertContained(root: string, candidate: string, label = 'path'): void {
  const absoluteRoot = assertAbsolute(root, 'root');
  const absoluteCandidate = assertAbsolute(candidate, label);
  const child = relative(absoluteRoot, absoluteCandidate);
  if (child === '' || child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`${label} is outside its owning directory`);
  }
}

export function resolveExecutionLocations(input: ExecutionLocations): ExecutionLocations {
  const projectDirectory = assertAbsolute(input.projectDirectory, 'projectDirectory');
  const executionDirectory = assertAbsolute(input.executionDirectory, 'executionDirectory');
  const stateDirectory = assertAbsolute(input.stateDirectory, 'stateDirectory');
  return Object.freeze({ projectDirectory, executionDirectory, stateDirectory });
}

export type { RunPaths };
