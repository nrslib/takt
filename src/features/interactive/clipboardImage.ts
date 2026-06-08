import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_INLINE_IMAGE_BYTES, type PastedImage } from './inlineImagePaste.js';

const CLIPBOARD_COMMAND_TIMEOUT_MS = 10_000;
const CLIPBOARD_COMMAND_MAX_BUFFER = 1024 * 1024;

const MACOS_CLIPBOARD_IMAGE_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('Foundation');

function writePasteboardData(type, outputPath) {
  const data = $.NSPasteboard.generalPasteboard.dataForType($(type));
  if (!data) {
    return false;
  }
  if (!data.writeToFileAtomically($(outputPath), true)) {
    throw new Error('Failed to write clipboard image data.');
  }
  return true;
}

function run(argv) {
  const pngPath = argv[0];
  const tiffPath = argv[1];
  if (writePasteboardData('public.png', pngPath)) {
    return 'png';
  }
  if (writePasteboardData('public.tiff', tiffPath)) {
    return 'tiff';
  }
  throw new Error('Clipboard does not contain a PNG or TIFF image.');
}
`;

async function assertClipboardImageWithinLimit(filePath: string): Promise<void> {
  const stats = await stat(filePath);
  if (stats.size > MAX_INLINE_IMAGE_BYTES) {
    throw new Error(`Clipboard image exceeds the ${MAX_INLINE_IMAGE_BYTES} byte limit.`);
  }
}

async function execClipboardCommand(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (!childProcess.execFile) {
    throw new Error('node:child_process.execFile is required to read clipboard images.');
  }

  const execFileAsync = promisify(childProcess.execFile) as (
    command: string,
    commandArgs: string[],
    options: { timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string; stderr: string }>;

  return execFileAsync(file, args, {
    timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
    maxBuffer: CLIPBOARD_COMMAND_MAX_BUFFER,
  });
}

async function readMacOSClipboardImage(): Promise<PastedImage> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'takt-clipboard-image-'));
  const pngPath = path.join(tempDir, 'clipboard.png');
  const tiffPath = path.join(tempDir, 'clipboard.tiff');

  try {
    const { stdout } = await execClipboardCommand('osascript', [
      '-l',
      'JavaScript',
      '-e',
      MACOS_CLIPBOARD_IMAGE_SCRIPT,
      pngPath,
      tiffPath,
    ]);

    if (stdout.trim() === 'tiff') {
      await execClipboardCommand('sips', [
        '-s',
        'format',
        'png',
        tiffPath,
        '--out',
        pngPath,
      ]);
    }

    await assertClipboardImageWithinLimit(pngPath);
    return {
      mimeType: 'image/png',
      data: await readFile(pngPath),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function readClipboardImage(): Promise<PastedImage> {
  if (process.platform !== 'darwin') {
    throw new Error('Clipboard image paste is currently supported only on macOS.');
  }

  return readMacOSClipboardImage();
}
