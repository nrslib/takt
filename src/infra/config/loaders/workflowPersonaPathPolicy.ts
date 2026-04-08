import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  getBuiltinFacetDir,
  getGlobalConfigDir,
  getGlobalFacetDir,
  getProjectConfigDir,
  getProjectFacetDir,
  getRepertoireFacetDir,
  getRepertoirePackageDir,
  isPathSafe,
} from '../paths.js';
import { getPackageFromWorkflowDir, getWorkflowBaseDir, type FacetResolutionContext } from './workflowPackageScope.js';

function getWorkflowPersonaBases(context: FacetResolutionContext): string[] {
  const bases = [
    getBuiltinFacetDir(context.lang, 'personas'),
    getGlobalFacetDir('personas'),
    join(getGlobalConfigDir(), 'personas'),
    join(getGlobalConfigDir(), 'agents'),
  ];

  if (context.projectDir) {
    const projectConfigDir = getProjectConfigDir(context.projectDir);
    bases.push(
      join(context.projectDir, 'personas'),
      join(context.projectDir, 'agents'),
      join(projectConfigDir, 'personas'),
      join(projectConfigDir, 'agents'),
      getProjectFacetDir(context.projectDir, 'personas'),
    );
  }

  if (context.workflowDir) {
    const workflowBaseDir = getWorkflowBaseDir(context.workflowDir);
    const workflowParentDir = dirname(workflowBaseDir);
    bases.push(
      workflowBaseDir,
      join(workflowBaseDir, 'personas'),
      join(workflowBaseDir, 'agents'),
      join(workflowParentDir, 'personas'),
      join(workflowParentDir, 'agents'),
    );
  }

  if (context.workflowDir && context.repertoireDir) {
    const workflowBaseDir = getWorkflowBaseDir(context.workflowDir);
    const pkg = getPackageFromWorkflowDir(workflowBaseDir, context.repertoireDir);
    if (pkg) {
      const packageDir = getRepertoirePackageDir(pkg.owner, pkg.repo);
      bases.push(
        join(packageDir, 'personas'),
        join(packageDir, 'agents'),
        getRepertoireFacetDir(pkg.owner, pkg.repo, 'personas', context.repertoireDir),
      );
    }
  }

  return bases;
}

export function assertAllowedPersonaPath(personaPath: string, context?: FacetResolutionContext): void {
  if (!context) {
    return;
  }

  const isAllowed = getWorkflowPersonaBases(context).some((base) => isPathSafe(base, personaPath));
  if (!isAllowed) {
    throw new Error(`Persona prompt file path is not allowed: ${personaPath}`);
  }

  if (!existsSync(personaPath)) {
    throw new Error(`Persona prompt file not found: ${personaPath}`);
  }
}
