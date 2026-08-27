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
  if (!isAbsolute(input.globalConfigDirectory) || input.globalConfigDirectory.length === 0) {
    throw new Error('Central worktree resolution requires an absolute global config directory');
  }
  if (input.request === false) {
    return { enabled: false, skipProjectLocalTaktSync: true };
  }
  const central = join(input.globalConfigDirectory, 'worktrees', input.stateId);
  const configured = input.configuredWorktreeDirectory;
  const cloneMetadataDirectory = join(
    input.globalConfigDirectory,
    'state',
    'projects',
    input.stateId,
    'worktree-metadata',
  );
  const provisioned = (baseDirectory: string): CentralWorktreeResolution => ({
    enabled: true,
    baseDirectory,
    cloneMetadataDirectory,
    skipProjectLocalTaktSync: true,
  });
  if (typeof input.request === 'string') {
    return provisioned(isAbsolute(input.request)
      ? resolve(input.request)
      : resolve(input.executionDirectory, input.request));
  }
  if (configured !== undefined) {
    return provisioned(isAbsolute(configured)
      ? resolve(configured)
      : resolve(input.projectDirectory, configured));
  }
  const sibling = resolve(input.projectDirectory, '..', 'takt-worktrees');
  if (canProvision(sibling)) {
    return provisioned(sibling);
  }
  if (input.centralFallbackAllowed !== false) {
    return provisioned(central);
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
