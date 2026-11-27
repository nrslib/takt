import { lstat, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export async function removePrivateImageCopy(root: string, file: string): Promise<void> {
  const suffix = relative(resolve(root), resolve(file));
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith('..' + sep) || suffix === '') throw new Error('Image file is outside its managed root');
  let current = resolve(root);
  for (const component of ['', ...suffix.split(sep).slice(0, -1)]) {
    current = join(current, component);
    let stat;
    try { stat = await lstat(current); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe image cleanup directory');
  }
  try { await unlink(file); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
}
