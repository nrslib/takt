import { execFile } from 'node:child_process';

const CANCELLED_OUTPUT = '__TAKT_DIRECTORY_PICKER_CANCELLED__';
const PICK_DIRECTORY_SCRIPT = `
try
  set selectedFolder to choose folder with prompt "TAKTの実行ディレクトリを選択"
  return POSIX path of selectedFolder
on error number -128
  return "${CANCELLED_OUTPUT}"
end try
`.trim();

export type NativeDirectoryPickerResult =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly path: string };

export class NativeDirectoryPickerUnavailableError extends Error {}

type ExecuteFile = (file: string, args: readonly string[]) => Promise<string>;

let pickerQueue: Promise<void> = Promise.resolve();

function executeFile(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 5 * 60 * 1000 },
      (error, stdout, stderr) => {
        if (error !== null) {
          rejectPromise(new Error(stderr.trim() || error.message));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

async function pickNativeDirectoryOnce(options: {
  readonly platform: NodeJS.Platform;
  readonly execute: ExecuteFile;
}): Promise<NativeDirectoryPickerResult> {
  if (options.platform !== 'darwin') {
    throw new NativeDirectoryPickerUnavailableError(
      'Native Finder directory selection is available only on macOS',
    );
  }
  const output = (await options.execute('osascript', ['-e', PICK_DIRECTORY_SCRIPT]))
    .replace(/\r?\n$/, '');
  if (output === CANCELLED_OUTPUT) return { cancelled: true };
  if (output.length === 0) throw new Error('Finder did not return a directory path');
  return { cancelled: false, path: output };
}

export function pickNativeDirectory(options: {
  readonly platform: NodeJS.Platform;
  readonly execute: ExecuteFile;
}): Promise<NativeDirectoryPickerResult> {
  if (options.platform !== 'darwin') return pickNativeDirectoryOnce(options);
  const result = pickerQueue.then(() => pickNativeDirectoryOnce(options));
  pickerQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function pickNativeDirectoryOnHost(): Promise<NativeDirectoryPickerResult> {
  return pickNativeDirectory({ platform: process.platform, execute: executeFile });
}
