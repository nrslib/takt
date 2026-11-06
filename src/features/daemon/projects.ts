import { createHash } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod/v4';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitive-text.js';
import { listWatchEntries, readSmallJson, MAX_WATCH_ENTRIES } from './watchers/files.js';

const RegistrationSchema = z.object({
  version: z.literal(2), locationId: z.string().regex(/^[a-f0-9]{64}$/u), stateId: z.uuid(),
  canonicalDirectory: z.string().refine(isAbsolute),
  managerUsed: z.boolean().optional(),
});
const WorkspaceSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1), repositoryDirectories: z.array(z.string().refine(isAbsolute)).max(MAX_WATCH_ENTRIES),
});

export interface DaemonProjectRoute {
  repositoryDirectory: string;
  workspaceId: string | null;
}

function projectLocation(directory: string): string {
  return createHash('sha256').update(directory).digest('hex');
}

function reportProjectReadError(error: unknown): void {
  process.stderr.write(`Cannot read daemon project state: ${sanitizeSensitiveText(getErrorMessage(error))}\n`);
}

export async function readDaemonProjectRoutes(globalConfigDirectory: string,
  onReadError: (error: unknown) => void = reportProjectReadError): Promise<readonly DaemonProjectRoute[]> {
  const registrations = new Map<string, { available: boolean; managerUsed: boolean }>();
  const projectsDirectory = join(globalConfigDirectory, 'projects');
  for (const entry of await listWatchEntries(projectsDirectory)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const project = RegistrationSchema.parse(await readSmallJson(join(projectsDirectory, entry.name)));
      if (`${project.locationId}.json` !== entry.name || projectLocation(project.canonicalDirectory) !== project.locationId) {
        throw new Error('Project registration identity differs from its filename');
      }
      let available = false;
      try {
        const directory = await realpath(project.canonicalDirectory);
        await access(directory, constants.R_OK | constants.X_OK);
        const info = await stat(directory);
        available = directory === project.canonicalDirectory && info.isDirectory();
      } catch (error) { onReadError(error); }
      registrations.set(project.canonicalDirectory, { available, managerUsed: project.managerUsed === true });
    } catch (error) { onReadError(error); }
  }
  const routes = new Map<string, DaemonProjectRoute>();
  for (const [directory, project] of registrations) {
    if (project.available && project.managerUsed) routes.set(directory, { repositoryDirectory: directory, workspaceId: null });
  }
  const workspacesDirectory = join(globalConfigDirectory, 'workspaces');
  for (const entry of await listWatchEntries(workspacesDirectory)) {
    if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
    const workspace = WorkspaceSchema.parse(await readSmallJson(join(workspacesDirectory, entry.name, 'workspace.json')));
    if (workspace.id !== entry.name) throw new Error('Workspace ID differs from its directory');
    for (const candidate of workspace.repositoryDirectories) {
      let directory;
      try {
        directory = await realpath(candidate);
        await access(directory, constants.R_OK | constants.X_OK);
        if (!(await stat(directory)).isDirectory()) throw new Error('Workspace project is not a directory');
      } catch (error) { onReadError(error); continue; }
      if (registrations.get(directory)?.available === false) continue;
      const assigned = routes.get(directory);
      if (assigned !== undefined && assigned.workspaceId !== null && assigned.workspaceId !== workspace.id) {
        throw new Error('Repository is assigned to multiple workspaces');
      }
      routes.set(directory, { repositoryDirectory: directory, workspaceId: workspace.id });
      if (routes.size > MAX_WATCH_ENTRIES) throw new Error('Daemon project count exceeds the watch limit');
    }
  }
  return [...routes.values()].sort((left, right) => left.repositoryDirectory.localeCompare(right.repositoryDirectory));
}
