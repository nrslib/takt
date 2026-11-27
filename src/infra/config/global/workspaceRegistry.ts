import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../project/sessionStore.js';
import { resolveGitRepositoryDirectory } from '../../task/repositoryDirectory.js';

const WORKSPACE_FILE_NAME = 'workspace.json';
const WorkspaceIdSchema = z.uuid();
const WorkspaceSchema = z.object({
  id: WorkspaceIdSchema,
  name: z.string().trim().min(1),
  repositoryDirectories: z.array(z.string().refine(isAbsolute)).readonly(),
}).readonly();
export type Workspace = z.infer<typeof WorkspaceSchema>;

function workspaceDirectory(globalConfigDirectory: string, id: string): string {
  return join(globalConfigDirectory, 'workspaces', WorkspaceIdSchema.parse(id));
}

async function writeWorkspace(globalConfigDirectory: string, workspace: Workspace): Promise<Workspace> {
  const parsed = WorkspaceSchema.parse(workspace);
  const directory = workspaceDirectory(globalConfigDirectory, parsed.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(directory, WORKSPACE_FILE_NAME), `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
  return parsed;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function readWorkspace(globalConfigDirectory: string, id: string): Promise<Workspace | undefined> {
  let serialized: string;
  try {
    serialized = await readFile(join(workspaceDirectory(globalConfigDirectory, id), WORKSPACE_FILE_NAME), 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const workspace = WorkspaceSchema.parse(JSON.parse(serialized));
  if (workspace.id !== id) throw new Error('Workspace ID differs from its directory');
  return workspace;
}

export async function readWorkspaceRegistry(globalConfigDirectory: string): Promise<readonly Workspace[]> {
  let entries;
  try {
    entries = await readdir(join(globalConfigDirectory, 'workspaces'), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const workspaces: Workspace[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !WorkspaceIdSchema.safeParse(entry.name).success) continue;
    const workspace = await readWorkspace(globalConfigDirectory, entry.name);
    if (workspace !== undefined) workspaces.push(workspace);
  }
  return workspaces;
}

async function requireWorkspace(globalConfigDirectory: string, id: string): Promise<Workspace> {
  const workspace = await readWorkspace(globalConfigDirectory, id);
  if (workspace === undefined) throw new Error(`Workspace does not exist: ${id}`);
  return workspace;
}

async function assertUnassigned(globalConfigDirectory: string, directory: string, workspaceId: string): Promise<void> {
  const owner = (await readWorkspaceRegistry(globalConfigDirectory))
    .find((workspace) => workspace.id !== workspaceId && workspace.repositoryDirectories.includes(directory));
  if (owner !== undefined) throw new Error(`Repository already belongs to workspace ${owner.name} (${owner.id}): ${directory}`);
}

export async function findWorkspaceForRepository(globalConfigDirectory: string, repositoryDirectory: string): Promise<Workspace | undefined> {
  const directory = await resolveGitRepositoryDirectory(repositoryDirectory);
  return (await readWorkspaceRegistry(globalConfigDirectory)).find((workspace) => workspace.repositoryDirectories.includes(directory));
}

export async function createWorkspace(options: {
  readonly globalConfigDirectory: string;
  readonly name: string;
  readonly repositoryDirectories: readonly string[];
}): Promise<Workspace> {
  const repositoryDirectories = [...new Set(await Promise.all(options.repositoryDirectories.map(resolveGitRepositoryDirectory)))];
  const workspace = WorkspaceSchema.parse({ id: randomUUID(), name: options.name, repositoryDirectories });
  for (const directory of repositoryDirectories) await assertUnassigned(options.globalConfigDirectory, directory, workspace.id);
  return writeWorkspace(options.globalConfigDirectory, workspace);
}

export function generateWorkspaceName(repositoryDirectories: readonly string[]): string {
  return repositoryDirectories.length === 0 ? 'workspace' : repositoryDirectories.map((directory) => basename(directory)).join(' + ');
}

export async function addWorkspaceRepository(globalConfigDirectory: string, id: string, repositoryDirectory: string): Promise<Workspace> {
  const directory = await resolveGitRepositoryDirectory(repositoryDirectory);
  const workspace = await requireWorkspace(globalConfigDirectory, id);
  await assertUnassigned(globalConfigDirectory, directory, id);
  if (workspace.repositoryDirectories.includes(directory)) return workspace;
  return writeWorkspace(globalConfigDirectory, { ...workspace, repositoryDirectories: [...workspace.repositoryDirectories, directory] });
}

export async function removeWorkspaceRepository(globalConfigDirectory: string, id: string, repositoryDirectory: string): Promise<Workspace> {
  const workspace = await requireWorkspace(globalConfigDirectory, id);
  return writeWorkspace(globalConfigDirectory, {
    ...workspace, repositoryDirectories: workspace.repositoryDirectories.filter((directory) => directory !== repositoryDirectory),
  });
}

export async function renameWorkspace(globalConfigDirectory: string, id: string, name: string): Promise<Workspace> {
  return writeWorkspace(globalConfigDirectory, { ...await requireWorkspace(globalConfigDirectory, id), name });
}
