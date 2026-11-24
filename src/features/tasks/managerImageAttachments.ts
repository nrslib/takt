import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod/v4';
import type { RunPaths } from '../../core/workflow/run/run-paths.js';
import { ConversationImageStore } from '../../infra/conversations/imageAttachments.js';
import { ConversationIdSchema } from '../../infra/conversations/schema.js';
import { ensurePrivateImageDirectory, writePrivateImageCopy } from '../../infra/fs/private-image-copy.js';
import { reserveTaskSpecDirectory, cleanupTaskSpecDirectory, type SaveEnqueuedTaskFile, type EnqueuedTaskPublicationScope } from '../../infra/task/enqueueService.js';
import { hasTaskDirectory } from '../../infra/task/taskStateReader.js';
import { readManagerImage } from '../manager/imageAttachments.js';
import { MAX_INLINE_IMAGE_BYTES } from '../interactive/inlineImagePaste.js';
import { hasManagerImageSourcePath, normalizeWorkflowImagePaths, selectWorkflowImagePaths } from '../manager/workflowImageReferences.js';

const metadataFile = '.manager-images.json';
const imageTask = z.object({ sourceRoot: z.string().refine(isAbsolute), conversationId: ConversationIdSchema,
  referenceId: z.uuid(), images: z.array(z.object({ id: z.uuid(), path: z.string().refine(isAbsolute),
    fileName: z.string().regex(/^image-[1-9]\d*\.(png|jpg|gif|webp)$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()) }).strict();

export function readManagerImageTask(taskDirectory: string): z.infer<typeof imageTask> | undefined {
  const path = join(taskDirectory, metadataFile);
  let stat;
  try { stat = fs.lstatSync(path); }
  catch (error) { if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe manager image task metadata');
  ensurePrivateImageDirectory(resolve(taskDirectory, '..', '..', '..'), taskDirectory);
  const file = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return imageTask.parse(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  finally { fs.closeSync(file); }
}

export async function withManagerImageTask<T>(input: {
  imageRoot: string; conversationId: string; repositoryDirectory: string; task: string; saveTaskFile: SaveEnqueuedTaskFile;
}, action: (task: string, saveTaskFile: SaveEnqueuedTaskFile, selectedImagePaths: readonly string[]) => Promise<T>): Promise<T> {
  const store = new ConversationImageStore(input.imageRoot, input.conversationId);
  const paths = selectWorkflowImagePaths(input.task, join(store.directory, 'attachments'));
  if (paths.length === 0) return action(input.task, input.saveTaskFile, paths);
  const task = normalizeWorkflowImagePaths(input.task, paths.map((path) => ({ path, fileName: basename(path) })));
  const publicationScope: EnqueuedTaskPublicationScope = (publish) => store.exclusiveWithAcquisitionTimeout(async () => {
    const metadata = await store.read();
    const selected = paths.map((path) => {
      const image = metadata.images.find((image) => store.path(image.fileName) === path);
      if (image === undefined) throw new Error('Manager image is unavailable');
      return { ...image, path };
    });
    const prepared = reserveTaskSpecDirectory(input.repositoryDirectory, task);
    const referenceId = randomUUID();
    const reference = { id: referenceId, repositoryDirectory: input.repositoryDirectory,
      taskDirectory: prepared.taskDir, imageIds: selected.map((image) => image.id), copies: [] };
    try {
      await store.save({ ...metadata, workflows: [...metadata.workflows ?? [], reference] });
      ensurePrivateImageDirectory(input.repositoryDirectory, prepared.taskDir);
      writePrivateImageCopy(input.repositoryDirectory, join(prepared.taskDir, '.gitignore'), Buffer.from('*\n'));
      const images = [];
      for (const { id, path, fileName } of selected) {
        const bytes = await readManagerImage(input.imageRoot, path);
        writePrivateImageCopy(input.repositoryDirectory, join(prepared.taskDir, 'attachments', fileName), bytes);
        images.push({ id, path, fileName, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      writePrivateImageCopy(input.repositoryDirectory, join(prepared.taskDir, metadataFile), Buffer.from(JSON.stringify({
        sourceRoot: input.imageRoot, conversationId: input.conversationId, referenceId, images,
      })));
      writePrivateImageCopy(input.repositoryDirectory, join(prepared.taskDir, 'order.md'), Buffer.from(task));
      return publish(prepared);
    } catch (error) {
      // Publication can succeed even when a later log/response fails. Reconcile against the authoritative task record.
      const published = await hasTaskDirectory(input.repositoryDirectory, prepared.taskDir);
      if (!published) {
        cleanupTaskSpecDirectory(prepared.taskDir);
        const latest = await store.read();
        await store.save({ ...latest, workflows: latest.workflows?.filter((workflow) => workflow.id !== referenceId) });
      }
      throw error;
    }
  });
  const save: SaveEnqueuedTaskFile = (cwd, content, options, prepare, signal) =>
    input.saveTaskFile(cwd, content, options, prepare, signal, publicationScope);
  return action(task, save, paths);
}

export async function registerManagerImageRun(sourceTaskDir: string, paths: RunPaths): Promise<void> {
  const task = readManagerImageTask(sourceTaskDir);
  if (task === undefined) return;
  const store = new ConversationImageStore(task.sourceRoot, task.conversationId);
  await store.exclusive(async () => {
    const metadata = await store.read();
    const workflow = metadata.workflows?.find((workflow) => workflow.id === task.referenceId);
    if (workflow === undefined || workflow.taskDirectory !== sourceTaskDir
      || task.images.some((image) => !metadata.images.some((stored) => stored.id === image.id))) throw new Error('Manager image reference was released');
    const runRoot = resolve(paths.runRootAbs);
    const suffix = relative(runRoot, paths.contextTaskAbs);
    if (suffix !== join('context', 'task')) throw new Error('Invalid manager image run context');
    if (workflow.copies.some((copy) => copy.taskDirectory === paths.contextTaskAbs)) return;
    await store.save({ ...metadata, workflows: metadata.workflows!.map((entry) => entry.id !== workflow.id ? entry
      : { ...entry, copies: [...entry.copies, { root: runRoot, taskDirectory: paths.contextTaskAbs }] }) });
  });
}

export function copyPrivateTaskAttachments(source: string, destination: string, root: string): void {
  const task = readManagerImageTask(dirname(source));
  if (task === undefined) throw new Error('Missing manager image task metadata');
  const attachmentDirectory = source;
  const copy = (source: string, destination: string): void => {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error('Unsafe manager image attachment');
    if (stat.isDirectory()) {
      ensurePrivateImageDirectory(root, destination);
      for (const entry of fs.readdirSync(source)) copy(join(source, entry), join(destination, entry));
    } else {
      if (!stat.isFile() || stat.size > MAX_INLINE_IMAGE_BYTES) throw new Error('Invalid manager image attachment');
      const file = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const bytes = fs.readFileSync(file);
        const selected = task.images.find((image) => relative(attachmentDirectory, source) === image.fileName);
        if (selected !== undefined && createHash('sha256').update(bytes).digest('hex') !== selected.sha256) throw new Error('Manager image bytes changed');
        writePrivateImageCopy(root, destination, bytes);
      } finally { fs.closeSync(file); }
    }
  };
  copy(source, destination);
}

export function normalizeManagerImageTaskOrder(taskDirectory: string | undefined, content: string): string {
  const task = taskDirectory === undefined ? undefined : readManagerImageTask(taskDirectory);
  const normalized = task === undefined ? content : normalizeWorkflowImagePaths(content, task.images);
  if (hasManagerImageSourcePath(normalized)) {
    throw new Error('Corrected task references a manager image that is not saved with this task');
  }
  return normalized;
}

export function replacePrivateStagedOrder(root: string, paths: RunPaths, content: string): void {
  const temporary = join(dirname(paths.contextTaskOrderAbs), `.${basename(paths.contextTaskOrderAbs)}-${randomUUID()}.tmp`);
  try {
    writePrivateImageCopy(root, temporary, Buffer.from(content));
    fs.renameSync(temporary, paths.contextTaskOrderAbs);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
