import * as fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function ensurePrivateImageDirectory(root: string, directory: string): void {
  const suffix = relative(resolve(root), resolve(directory));
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith('..' + sep)) throw new Error('Image directory is outside its managed root');
  let current = resolve(root);
  const base = fs.lstatSync(current);
  if (!base.isDirectory() || base.isSymbolicLink()) throw new Error('Unsafe image root');
  for (const component of suffix.split(sep).filter(Boolean)) {
    current = join(current, component);
    try { fs.mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe image directory');
    if (process.platform !== 'win32') fs.chmodSync(current, 0o700);
  }
}

export function writePrivateImageCopy(root: string, destination: string, data: Uint8Array): void {
  ensurePrivateImageDirectory(root, dirname(destination));
  const file = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(file, data); fs.fsyncSync(file); }
  catch (error) { fs.unlinkSync(destination); throw error; }
  finally { fs.closeSync(file); }
}
