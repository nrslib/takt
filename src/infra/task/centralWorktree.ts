import { accessSync, constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { CentralWorktreeRequest } from './centralStateRepository.js';

export interface CentralWorktreeResolution {
  readonly enabled: boolean;
  readonly baseDirectory?: string;
  readonly cloneMetadataDirectory?: string;
  readonly skipProjectLocalTaktSync: true;
}

/**
 * Resolve Web UI worktree policy without consulting or writing project
 * framework state.  Provisioning is performed by the clone adapter.
 */
export function resolveCentralWorktree(input: {
  readonly request: CentralWorktreeRequest;
  readonly projectDirectory: string;
  readonly executionDirectory: string;
  readonly globalConfigDirectory: string;
  readonly stateId: string;
  readonly configuredWorktreeDirectory?: string;
  readonly centralFallbackAllowed?: boolean;
}): CentralWorktreeResolution {
  if (input.request === false) {
    return { enabled: false, skipProjectLocalTaktSync: true };
  }
  const central = join(input.globalConfigDirectory, 'worktrees', input.stateId);
  const configured = input.configuredWorktreeDirectory;
  if (typeof input.request === 'string') {
    return {
      enabled: true,
      baseDirectory: isAbsolute(input.request)
        ? resolve(input.request)
        : resolve(input.executionDirectory, input.request),
      cloneMetadataDirectory: join(input.globalConfigDirectory, 'state', 'projects', input.stateId, 'worktree-metadata'),
      skipProjectLocalTaktSync: true,
    };
  }
  if (configured !== undefined) {
    return {
      enabled: true,
      baseDirectory: isAbsolute(configured)
        ? resolve(configured)
        : resolve(input.projectDirectory, configured),
      cloneMetadataDirectory: join(input.globalConfigDirectory, 'state', 'projects', input.stateId, 'worktree-metadata'),
      skipProjectLocalTaktSync: true,
    };
  }
  const sibling = resolve(input.projectDirectory, '..', 'takt-worktrees');
  if (canProvision(sibling)) {
    return {
      enabled: true,
      baseDirectory: sibling,
      cloneMetadataDirectory: join(input.globalConfigDirectory, 'state', 'projects', input.stateId, 'worktree-metadata'),
      skipProjectLocalTaktSync: true,
    };
  }
  if (input.centralFallbackAllowed !== false) {
    return {
      enabled: true,
      baseDirectory: central,
      cloneMetadataDirectory: join(input.globalConfigDirectory, 'state', 'projects', input.stateId, 'worktree-metadata'),
      skipProjectLocalTaktSync: true,
    };
  }
  throw new Error('The configured sibling worktree directory is not provisionable');
}

function canProvision(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    try {
      accessSync(resolve(directory, '..'), constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}
