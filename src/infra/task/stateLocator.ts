import { resolve } from 'node:path';
import type { ExecutionLocations, StatePaths } from '../../core/execution/locations.js';
import { getProjectConfigDir } from '../config/paths.js';

export interface StateLocator {
  resolve(projectDirectory: string): ExecutionLocations;
  paths(locations: ExecutionLocations): StatePaths;
}

/**
 * The CLI remains project-local in this release.  The locator keeps that
 * choice explicit so the central Web UI state cannot accidentally leak into
 * the existing task runner.
 */
export class ProjectLocalStateLocator implements StateLocator {
  resolve(projectDirectory: string): ExecutionLocations {
    const project = resolve(projectDirectory);
    const stateDirectory = getProjectConfigDir(project);
    return Object.freeze({
      projectDirectory: project,
      executionDirectory: project,
      stateDirectory,
    });
  }

  paths(locations: ExecutionLocations): StatePaths {
    return {
      stateDirectory: locations.stateDirectory,
      stateFile: resolve(locations.stateDirectory, 'state.json'),
      tasksFile: resolve(locations.stateDirectory, 'tasks.yaml'),
      tasksDirectory: resolve(locations.stateDirectory, 'tasks'),
      runsDirectory: resolve(locations.stateDirectory, 'runs'),
      sessionsDirectory: resolve(locations.stateDirectory, 'sessions'),
      worktreeMetadataDirectory: resolve(locations.stateDirectory, 'worktree-metadata'),
      eventsDirectory: resolve(locations.stateDirectory, 'events'),
      locksDirectory: resolve(locations.stateDirectory, 'locks'),
    };
  }
}

export function createProjectLocalStateLocator(): ProjectLocalStateLocator {
  return new ProjectLocalStateLocator();
}
