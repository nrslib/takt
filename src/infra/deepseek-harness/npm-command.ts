import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';

export interface ManagedNpmCommand {
  command: string;
  argsPrefix: string[];
}

interface ResolveNpmOptions {
  npmPath?: string;
  nodePath?: string;
  path?: string;
}

async function isRunnableFile(path: string, needsExecutable = true): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, needsExecutable ? constants.X_OK : constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve npm for the managed DeepSeek install. Callers reject unsupported
 * platforms first, so only the POSIX layouts of Linux and macOS are handled.
 */
export async function resolveManagedNpmCommand(options: ResolveNpmOptions = {}): Promise<ManagedNpmCommand> {
  if (options.npmPath !== undefined) return { command: options.npmPath, argsPrefix: [] };

  const nodePath = options.nodePath ?? process.execPath;
  const nodeDir = dirname(nodePath);
  const cliPath = join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (await isRunnableFile(cliPath, false)) {
    return { command: nodePath, argsPrefix: [cliPath] };
  }

  const adjacentNpm = join(nodeDir, 'npm');
  try {
    if ((await lstat(adjacentNpm)).isSymbolicLink()) {
      const target = await realpath(adjacentNpm);
      if (basename(target) === 'npm-cli.js' && await isRunnableFile(target, false)) {
        return { command: nodePath, argsPrefix: [target] };
      }
    }
  } catch {
    // Some Node distributions have no adjacent npm symlink.
  }

  // Skip empty and relative PATH entries: they resolve against the working
  // directory (the repository under review), which the user did not choose.
  // Absolute entries are the user's explicit choice, as in their shell.
  const path = options.path ?? process.env.PATH ?? '';
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, 'npm');
    if (await isRunnableFile(candidate)) return { command: candidate, argsPrefix: [] };
  }
  throw new Error('npm was not found. Add npm to PATH, then rerun `takt install deepseek-harness`.');
}
