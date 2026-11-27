import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readDaemonProjectRoutes } from '../features/daemon/projects.js';
import { listWatchEntries, MAX_WATCH_ENTRIES, MAX_WATCH_FILE_BYTES, readSmallText } from '../features/daemon/watchers/files.js';
import { readWatchTasks } from '../features/daemon/watchers/state.js';
import { registerProject, readProjectRegistry } from '../infra/config/global/projectRegistry.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';

async function projects(directory: string) { return (await readDaemonProjectRoutes(directory)).map((route) => route.repositoryDirectory); }

let root: string;
let cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-daemon-projects-')));
  cwd = join(root, 'project');
  mkdirSync(cwd);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it('preserves the manager mark across other commands and keeps legacy registrations valid', async () => {
  const options = { globalConfigDirectory: getGlobalConfigDir(), projectDirectory: cwd };
  const legacy = await registerProject({ ...options, command: 'ui' });
  expect(legacy.managerUsed).toBeUndefined();
  expect(await projects(getGlobalConfigDir())).toEqual([]);
  const marked = await registerProject({ ...options, command: 'manager', managerUsed: true });
  const later = await registerProject({ ...options, command: 'run' });
  expect(later.managerUsed).toBe(true);
  expect(later.stateId).toBe(marked.stateId);
  expect((await readProjectRegistry(getGlobalConfigDir())).warnings).toEqual([]);
  expect(await projects(getGlobalConfigDir())).toEqual([cwd]);
});

it('combines marked projects and workspace assignments once, skipping unavailable directories', async () => {
  const globalConfigDirectory = getGlobalConfigDir();
  const assigned = join(root, 'assigned');
  mkdirSync(assigned);
  await registerProject({ globalConfigDirectory, projectDirectory: cwd, command: 'manager', managerUsed: true });
  const id = randomUUID();
  const workspaceDirectory = join(globalConfigDirectory, 'workspaces', id);
  mkdirSync(workspaceDirectory, { recursive: true });
  writeFileSync(join(workspaceDirectory, 'workspace.json'), JSON.stringify({
    id, name: 'test', repositoryDirectories: [assigned, cwd, join(root, 'missing')],
  }));
  expect(await projects(globalConfigDirectory)).toEqual([assigned, cwd].sort());
  renameSync(cwd, join(root, 'original-project'));
  mkdirSync(cwd);
  expect((await readProjectRegistry(globalConfigDirectory)).projects).toEqual([
    expect.objectContaining({ canonicalDirectory: cwd, available: true }),
  ]);
  expect(await projects(globalConfigDirectory)).toEqual([assigned, cwd].sort());
  rmSync(cwd, { recursive: true });
  expect(await projects(globalConfigDirectory)).toEqual([assigned]);
});

it.each(['dev', 'ino', 'absent', 'malformed'] as const)(
  'routes a manager project with an ignored %s fingerprint', async (variant) => {
    const globalConfigDirectory = getGlobalConfigDir();
    const registered = await registerProject({
      globalConfigDirectory, projectDirectory: cwd, command: 'manager', managerUsed: true,
    });
    const path = join(globalConfigDirectory, 'projects', `${registered.locationId}.json`);
    const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const current = await stat(cwd);
    if (variant === 'absent') delete stored.fingerprint;
    else if (variant === 'malformed') stored.fingerprint = { dev: current.dev };
    else stored.fingerprint = { dev: current.dev, ino: current.ino, [variant]: current[variant] + 1 };
    await writeFile(path, JSON.stringify(stored));
    const errors: unknown[] = [];

    expect(await readDaemonProjectRoutes(globalConfigDirectory, (error) => errors.push(error)))
      .toEqual([{ repositoryDirectory: cwd, workspaceId: null }]);
    expect(errors).toEqual([]);

    await writeFile(path, JSON.stringify({ ...stored, managerUsed: false }));
    expect(await projects(globalConfigDirectory)).toEqual([]);
  },
);

it('routes workspace repositories together without importing a synchronous business store', async () => {
  const configDirectory = join(root, 'config');
  await registerProject({ globalConfigDirectory: configDirectory, projectDirectory: cwd, command: 'manager', managerUsed: true });
  const id = randomUUID();
  const directory = join(configDirectory, 'workspaces', id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ id, name: 'workspace', repositoryDirectories: [cwd] }));
  expect(await readDaemonProjectRoutes(configDirectory)).toEqual([{ repositoryDirectory: cwd, workspaceId: id }]);
});

it('bounds small-file reads before parsing and rejects growth beyond the limit', async () => {
  const file = join(root, 'small.json');
  await writeFile(file, 'x'.repeat(MAX_WATCH_FILE_BYTES));
  expect((await readSmallText(file)).length).toBe(MAX_WATCH_FILE_BYTES);
  await writeFile(file, 'x'.repeat(MAX_WATCH_FILE_BYTES + 1));
  await expect(readSmallText(file)).rejects.toThrow();
  await expect(readSmallText(root)).rejects.toThrow();
});

it('enumerates directories above one watch page without rejecting or dropping entries', async () => {
  const directory = join(root, 'bounded');
  await mkdir(directory);
  for (let index = 0; index < MAX_WATCH_ENTRIES; index++) await writeFile(join(directory, `${index}.json`), '{}');
  expect((await listWatchEntries(directory)).length).toBe(MAX_WATCH_ENTRIES);
  await writeFile(join(directory, 'extra.json'), '{}');
  expect(await listWatchEntries(directory)).toHaveLength(MAX_WATCH_ENTRIES + 1);
});

it('rejects YAML aliases without expanding them into a large observation payload', async () => {
  await mkdir(join(cwd, '.takt'));
  await writeFile(join(cwd, '.takt', 'tasks.yaml'), 'shared: &shared []\ntasks: *shared\n');
  await expect(readWatchTasks(cwd)).rejects.toThrow();
});
