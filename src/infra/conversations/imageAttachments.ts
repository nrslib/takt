import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod/v4';
import { ConversationIdSchema } from './schema.js';
import { FileAsyncLock } from '../daemon/lock.js';
import { readEntirePrivateFile, ensurePrivateDirectory, writePrivateFile } from '../daemon/privateFile.js';

const image = z.object({ id: z.uuid(), owner: z.uuid(), placeholder: z.string().regex(/^\[Image #[1-9]\d*\]$/),
  fileName: z.string().regex(/^image-[1-9]\d*\.(png|jpg|gif|webp)$/) }).strict();
const metadata = z.object({ images: z.array(image), lastIndex: z.number().int().nonnegative() }).strict().superRefine((value, ctx) => {
  for (const field of ['id', 'placeholder', 'fileName'] as const) {
    if (new Set(value.images.map((item) => item[field])).size !== value.images.length) ctx.addIssue({ code: 'custom', message: `Duplicate image ${field}` });
  }
});
export type ConversationImageMetadata = z.infer<typeof metadata>;

/** Each parent is private and is checked before the next child is created. */
export async function ensureImageDirectory(root: string, components: readonly string[]): Promise<string> {
  let directory = resolve(root);
  for (const component of components) {
    if (component === '' || component === '.' || component === '..' || /[/\\]/u.test(component)) throw new Error('Invalid image directory component');
    directory = join(directory, component);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe image directory');
    await ensurePrivateDirectory(directory);
  }
  return directory;
}

export class ConversationImageStore {
  readonly root: string;
  readonly directory: string;
  private readonly lock = new FileAsyncLock();
  constructor(readonly cwd: string, readonly conversationId: string) {
    ConversationIdSchema.parse(conversationId);
    this.root = join(cwd, '.takt', 'manager-images');
    this.directory = join(this.root, conversationId);
  }
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    await ensureImageDirectory(this.cwd, ['.takt', 'manager-images', this.conversationId]);
    return this.lock.exclusive(join(this.directory, '.lock'), action, { signal: new AbortController().signal, timeoutMs: 5000 });
  }
  async read(): Promise<ConversationImageMetadata> {
    let directory = resolve(this.cwd);
    for (const component of ['.takt', 'manager-images', this.conversationId]) {
      directory = join(directory, component);
      let stat;
      try { stat = await lstat(directory); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { images: [], lastIndex: 0 };
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe image directory');
    }
    const content = await readEntirePrivateFile(join(this.directory, 'images.json'));
    return content === undefined ? { images: [], lastIndex: 0 } : metadata.parse(JSON.parse(content.toString('utf8')));
  }
  async save(value: ConversationImageMetadata): Promise<void> {
    await writePrivateFile(join(this.directory, 'images.json'), JSON.stringify(metadata.parse(value)));
  }
  path(fileName: string): string {
    image.shape.fileName.parse(fileName);
    return join(this.directory, 'attachments', fileName);
  }
}
