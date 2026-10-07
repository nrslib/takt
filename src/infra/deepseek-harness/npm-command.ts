import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';

export interface ManagedNpmCommand {
  command: string;
  argsPrefix: string[];
}

interface ResolveNpmOptions {
  npmPath?: string;
  nodePath?: string;
  path?: string;
  platform?: NodeJS.Platform;
}

async function isRunnableFile(path: string, platform: NodeJS.Platform, needsExecutable = true): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, platform === 'win32' || !needsExecutable ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveManagedNpmCommand(options: ResolveNpmOptions = {}): Promise<ManagedNpmCommand> {
  if (options.npmPath !== undefined) return { command: options.npmPath, argsPrefix: [] };

  const nodePath = options.nodePath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const nodeDir = dirname(nodePath);
  const cliPath = platform === 'win32'
    ? join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (await isRunnableFile(cliPath, platform, false)) {
    return { command: nodePath, argsPrefix: [cliPath] };
  }

  if (platform !== 'win32') {
    const adjacentNpm = join(nodeDir, 'npm');
    try {
      if ((await lstat(adjacentNpm)).isSymbolicLink()) {
        const target = await realpath(adjacentNpm);
        if (basename(target) === 'npm-cli.js' && await isRunnableFile(target, platform, false)) {
          return { command: nodePath, argsPrefix: [target] };
        }
      }
    } catch {
      // Some Node distributions have no adjacent npm symlink.
    }
  }

  const path = options.path ?? process.env.PATH ?? '';
  const names = platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm.bat'] : ['npm'];
  for (const directory of path.split(platform === 'win32' ? ';' : delimiter)) {
    for (const name of names) {
      const candidate = join(directory || '.', name);
      if (await isRunnableFile(candidate, platform)) return { command: candidate, argsPrefix: [] };
    }
  }
  throw new Error('npm was not found. Add npm to PATH, then rerun `takt install deepseek-harness`.');
}
