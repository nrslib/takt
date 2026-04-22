import * as path from 'node:path';
import type { SystemStepRuntimeState } from '../../../core/workflow/system/system-step-services.js';
import { cloneAndIsolate } from '../../task/clone-exec.js';
import {
  removeClone,
  resolveCloneBaseDir,
} from '../../task/index.js';
import { checkoutWorktreeBranchFromOrigin } from './system-effect-git-helpers.js';

const PR_SYNC_SESSION_STORE_KEY = 'pr-sync-session-store';
const PR_SYNC_SESSION_CLEANUP_KEY = 'pr-sync-session-cleanup';

export interface PrSyncSession {
  readonly projectCwd: string;
  readonly branch: string;
  readonly worktreePath: string;
}

function buildWorktreePath(projectCwd: string): string {
  return path.join(resolveCloneBaseDir(projectCwd), `pr-sync-${Date.now()}`);
}

function createPrSyncSession(projectCwd: string, branch: string): PrSyncSession {
  const worktreePath = buildWorktreePath(projectCwd);

  try {
    cloneAndIsolate(projectCwd, worktreePath);
    checkoutWorktreeBranchFromOrigin(projectCwd, worktreePath, branch);
    return { projectCwd, branch, worktreePath };
  } catch (error) {
    removeClone(worktreePath);
    throw error;
  }
}

export function resolvePrSyncSessionStore(runtimeState?: SystemStepRuntimeState): Map<number, PrSyncSession> {
  if (!runtimeState) {
    return new Map<number, PrSyncSession>();
  }

  const cachedStore = runtimeState.cache.get(PR_SYNC_SESSION_STORE_KEY);
  if (cachedStore instanceof Map) {
    return cachedStore as Map<number, PrSyncSession>;
  }

  const store = new Map<number, PrSyncSession>();
  runtimeState.cache.set(PR_SYNC_SESSION_STORE_KEY, store);

  if (!runtimeState.cache.has(PR_SYNC_SESSION_CLEANUP_KEY)) {
    runtimeState.cleanupHandlers.add(() => releaseAllPrSyncSessions(store));
    runtimeState.cache.set(PR_SYNC_SESSION_CLEANUP_KEY, true);
  }

  return store;
}

export function acquirePrSyncSession(
  store: Map<number, PrSyncSession>,
  projectCwd: string,
  prNumber: number,
  branch: string,
): PrSyncSession {
  const existingSession = store.get(prNumber);
  if (existingSession) {
    if (existingSession.projectCwd !== projectCwd || existingSession.branch !== branch) {
      throw new Error(`PR sync session mismatch for PR #${prNumber}`);
    }
    return existingSession;
  }

  const session = createPrSyncSession(projectCwd, branch);
  store.set(prNumber, session);
  return session;
}

export function releasePrSyncSession(store: Map<number, PrSyncSession>, prNumber: number): void {
  const session = store.get(prNumber);
  if (!session) {
    return;
  }

  store.delete(prNumber);
  removeClone(session.worktreePath);
}

export function releaseAllPrSyncSessions(store: Map<number, PrSyncSession>): void {
  for (const prNumber of Array.from(store.keys())) {
    releasePrSyncSession(store, prNumber);
  }
}
