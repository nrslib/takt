import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CURSOR_MCP_CONFIG_PATH, cursorApprovalKey, readCursorProjectServers, relocateCursorProjectServer } from './cursor-native-config.js';

const CURSOR_DATA_DIR = 'CURSOR_DATA_DIR';
const DISABLED_FILE = 'mcp-disabled.json';
const AUTH_FILE = 'mcp-auth.json';
const APPROVALS_FILE = 'mcp-approvals.json';
const SELECTIONS_FILE = 'mcp-group-selections.json';

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // JSON parser errors can include credential values from the input.
    throw new Error('Failed to read Cursor MCP management data');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function projectRoot(cwd: string): Promise<string> {
  const original = await realpath(cwd);
  let current = original;
  while (dirname(current) !== current) {
    try {
      await access(join(current, '.git'));
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    current = dirname(current);
  }
  return original;
}

function projectDirectory(dataRoot: string, root: string): string {
  const key = root.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return join(dataRoot, 'projects', key);
}

function nativeDataRoot(cwd: string, environment: NodeJS.ProcessEnv): string {
  const configured = environment[CURSOR_DATA_DIR];
  if (configured?.trim()) return resolve(cwd, configured);
  const home = process.platform === 'win32' ? environment.USERPROFILE : environment.HOME;
  return join(home ?? homedir(), '.cursor');
}

/** Preserve native management state without writing back to the user's store. */
export async function prepareCursorMcpExclusions(
  cwd: string,
  dataRoot: string,
  excludedNames: readonly string[],
  environment: NodeJS.ProcessEnv,
  configRoot?: string,
): Promise<Readonly<Record<string, string>>> {
  const root = await projectRoot(cwd);
  const sourceRoot = nativeDataRoot(cwd, environment);
  const source = projectDirectory(sourceRoot, root);
  const targetRoot = configRoot === undefined ? root : await realpath(configRoot);
  const target = projectDirectory(dataRoot, targetRoot);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const disabled = await readOptionalJson(join(source, DISABLED_FILE));
  if (disabled !== undefined && (!Array.isArray(disabled) || !disabled.every((name) => typeof name === 'string'))) {
    throw new Error('Invalid Cursor MCP disabled server list');
  }
  await writeFile(join(target, DISABLED_FILE), JSON.stringify([...new Set([...((disabled as string[] | undefined) ?? []), ...excludedNames])]), { mode: 0o600 });
  const approvals = await readOptionalJson(join(source, APPROVALS_FILE));
  if (approvals !== undefined && (!Array.isArray(approvals) || !approvals.every((key) => typeof key === 'string'))) {
    throw new Error('Invalid Cursor MCP approvals');
  }
  let targetApprovals = (approvals as string[] | undefined) ?? [];
  let runtimeNames: string[] = [];
  let currentAuth: unknown;
  let currentSelections: unknown;
  let projectNames: string[] = [];
  if (configRoot !== undefined) {
    const runtime = await readCursorProjectServers(configRoot, environment);
    runtimeNames = Object.keys(runtime);
    const current = projectDirectory(nativeDataRoot(targetRoot, environment), targetRoot);
    currentAuth = await readOptionalJson(join(current, AUTH_FILE));
    currentSelections = await readOptionalJson(join(current, SELECTIONS_FILE));
    const existingApprovals = await readOptionalJson(join(current, APPROVALS_FILE));
    const runtimeKeys = Object.entries(runtime).map(([name, server]) => cursorApprovalKey(name, server, targetRoot, environment));
    targetApprovals = Array.isArray(existingApprovals) ? existingApprovals.filter((key): key is string =>
      typeof key === 'string' && runtimeKeys.includes(key)) : [];
    const project = await readCursorProjectServers(root, environment);
    const retained = Object.fromEntries(Object.entries(project).filter(([name]) =>
      !excludedNames.includes(name) && !Object.hasOwn(runtime, name)));
    projectNames = Object.keys(retained);
    const relocated = Object.fromEntries(Object.entries(retained).map(([name, server]) => {
      const moved = relocateCursorProjectServer(server, resolve(cwd), environment);
      if (Array.isArray(approvals) && approvals.includes(cursorApprovalKey(name, server, root, environment))) {
        targetApprovals.push(cursorApprovalKey(name, moved, targetRoot, environment));
      }
      return [name, moved];
    }));
    await writeFile(join(configRoot, CURSOR_MCP_CONFIG_PATH), JSON.stringify({ mcpServers: { ...relocated, ...runtime } }), { mode: 0o600 });
    const currentDisabled = await readOptionalJson(join(current, DISABLED_FILE));
    if (Array.isArray(currentDisabled) && currentDisabled.every((name) => typeof name === 'string')) {
      await writeFile(join(target, DISABLED_FILE), JSON.stringify([...new Set([
        ...((disabled as string[] | undefined) ?? []), ...currentDisabled, ...excludedNames,
      ])]), { mode: 0o600 });
    }
  }
  await writeFile(join(target, APPROVALS_FILE), JSON.stringify(targetApprovals), { mode: 0o600 });
  const selections = await readOptionalJson(join(source, SELECTIONS_FILE));
  if (selections !== undefined || currentSelections !== undefined) {
    if ((selections !== undefined && !isRecord(selections)) || (currentSelections !== undefined && !isRecord(currentSelections))) {
      throw new Error('Invalid Cursor MCP selection data');
    }
    await writeFile(join(target, SELECTIONS_FILE), JSON.stringify({ ...selections as object, ...currentSelections as object }), { mode: 0o600 });
  }
  const auth = await readOptionalJson(join(source, AUTH_FILE));
  if (auth !== undefined || currentAuth !== undefined) {
    if ((auth !== undefined && !isRecord(auth)) || (currentAuth !== undefined && !isRecord(currentAuth))) {
      throw new Error('Invalid Cursor MCP authentication data');
    }
    const original = (auth as Record<string, unknown> | undefined) ?? {};
    const current = (currentAuth as Record<string, unknown> | undefined) ?? {};
    const retained = Object.fromEntries([...new Set([...Object.keys(original), ...Object.keys(current)])]
      .filter((name) => !excludedNames.includes(name))
      .flatMap((name) => {
        const value = runtimeNames.includes(name) ? current[name]
          : projectNames.includes(name) ? original[name] : current[name] ?? original[name];
        return value === undefined ? [] : [[name, value]];
      }));
    await writeFile(join(target, AUTH_FILE), JSON.stringify(retained), { mode: 0o600 });
  }
  return { [CURSOR_DATA_DIR]: dataRoot };
}
