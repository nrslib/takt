import { spawn } from 'node:child_process';

type HostOpener = (command: string, args: readonly string[]) => void | Promise<void>;

function defaultExecute(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('spawn', resolve);
    child.once('error', reject);
    child.unref();
  });
}

export async function openLiveRunDirectory(options: {
  readonly platform?: NodeJS.Platform;
  readonly directory: string;
  readonly execute?: HostOpener;
}): Promise<void> {
  const commandByPlatform: Partial<Record<NodeJS.Platform, string>> = {
    darwin: 'open',
    linux: 'xdg-open',
    win32: 'explorer.exe',
  };
  const platform = options.platform ?? process.platform;
  const command = commandByPlatform[platform];
  if (command === undefined) {
    throw new Error(`Unsupported platform for opening a live run directory: ${platform}`);
  }
  await (options.execute ?? defaultExecute)(command, [options.directory]);
}
