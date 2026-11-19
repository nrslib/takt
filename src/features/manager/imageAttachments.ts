import { randomUUID } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { ManagerImageAttachmentReference } from '../../shared/types/image-attachments.js';
import { ConversationImageStore, ensureImageDirectory } from '../../infra/conversations/imageAttachments.js';
import { readPrivateFile, writeNewPrivateFile, writePrivateFile } from '../../infra/daemon/privateFile.js';
import { createImageAttachmentCollection } from '../../shared/utils/imageAttachmentStore.js';
import { MAX_INLINE_IMAGE_BYTES, validatePastedImage } from '../interactive/inlineImagePaste.js';
import { selectReferencedImageAttachments } from '../../shared/utils/imageAttachmentSelection.js';
import { ConversationError } from './conversationErrors.js';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { hasTaskDirectory } from '../../infra/task/taskStateReader.js';
import { removePrivateImageCopy } from '../../infra/conversations/imageFiles.js';

export async function managerImageDirectory(assignment: ConversationAssignment, configDirectory: string): Promise<string> {
  if (assignment.kind === 'daemon') throw new ConversationError('invalid_input');
  if (assignment.kind === 'repository') return assignment.repositoryDirectory;
  return ensureImageDirectory(configDirectory, ['workspaces', assignment.workspaceId]);
}

export interface ManagerImageReferences {
  hasImageReference(conversationId: string, imageId: string, activeOnly?: boolean): Promise<boolean>;
}

async function readImage(cwd: string, path: string, temporary: boolean): Promise<Buffer> {
  const root = join(resolve(cwd), '.takt', temporary ? 'tmp' : 'manager-images', ...(temporary ? ['images'] : []));
  const suffix = relative(root, resolve(path));
  if (suffix === '' || suffix.startsWith('..' + sep) || suffix === '..' || resolve(root, suffix) !== resolve(path)) throw new ConversationError('invalid_input');
  let directory = resolve(cwd);
  // The image root and all descendants must not redirect reads outside the managed area.
  for (const component of [...relative(resolve(cwd), root).split(sep), ...suffix.split(sep).slice(0, -1)]) {
    directory = join(directory, component);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ConversationError('invalid_input');
  }
  const data = await readPrivateFile(path, MAX_INLINE_IMAGE_BYTES);
  if (data === undefined) throw new ConversationError('unavailable_attachment');
  validatePastedImage(data, basename(path));
  return data;
}

export async function readManagerImage(cwd: string, path: string): Promise<Buffer> {
  return readImage(cwd, path, false);
}

export async function resolveManagerImages(cwd: string, conversationId: string, ids: readonly string[]): Promise<ManagerImageAttachmentReference[]> {
  if (ids.length === 0) return [];
  const store = new ConversationImageStore(cwd, conversationId);
  const metadata = await store.read();
  return Promise.all(ids.map(async (id) => {
    const image = metadata.images.find((image) => image.id === id);
    if (image === undefined) throw new ConversationError('unavailable_attachment');
    const path = store.path(image.fileName);
    await readManagerImage(cwd, path);
    return { id, placeholder: image.placeholder, path };
  }));
}

export class ManagerImageAttachments {
  constructor(private readonly references: ManagerImageReferences) {}

  async cleanup(cwd: string, conversationId: string, connectedOwners: readonly string[]): Promise<void> {
    const metadata = await new ConversationImageStore(cwd, conversationId).read();
    const owners = new Set([...metadata.images, ...metadata.deleting ?? []].map((image) => image.owner));
    for (const owner of owners) if (!connectedOwners.includes(owner)) await this.release(cwd, conversationId, owner);
  }

  async prepare(cwd: string, conversationId: string, owner: string, sourcePath: string): Promise<ManagerImageAttachmentReference> {
    const store = new ConversationImageStore(cwd, conversationId);
    return store.exclusive(async () => {
      const data = await readImage(cwd, sourcePath, true);
      const image = validatePastedImage(data, basename(sourcePath));
      const metadata = await store.read();
      const id = randomUUID();
      if (metadata.images.some((image) => image.id === id)) throw new ConversationError('invalid_input');
      await ensureImageDirectory(cwd, ['.takt', 'manager-images', conversationId, 'attachments']);
      await writePrivateFile(join(store.directory, '.gitignore'), '*\n');
      const attachments = createImageAttachmentCollection({ tmpRoot: store.root, sessionId: conversationId,
        initialAttachments: metadata.images.map((image) => ({ ...image, tempPath: store.path(image.fileName) })),
        initialAttachmentIndex: metadata.lastIndex }, (attachment, data) => writeNewPrivateFile(attachment.tempPath, data));
      const saved = await attachments.saveImage(image.data, image.mimeType);
      try {
        await store.save({ ...metadata, images: [...metadata.images, { id, owner, placeholder: saved.placeholder, fileName: saved.fileName }],
          lastIndex: Number(saved.placeholder.match(/\d+/u)![0]) });
      } catch (error) {
        await unlink(saved.tempPath);
        throw error;
      }
      return { id, placeholder: saved.placeholder, path: saved.tempPath };
    });
  }

  async accept<T>(cwd: string, conversationId: string, owner: string, text: string, ids: readonly string[], accept: () => Promise<T>): Promise<T> {
    const store = new ConversationImageStore(cwd, conversationId);
    return store.exclusive(async () => {
      const metadata = await store.read();
      for (const id of ids) {
        const image = metadata.images.find((image) => image.id === id);
        if (image === undefined || image.owner !== owner && !await this.references.hasImageReference(conversationId, id)) throw new ConversationError('unavailable_attachment');
      }
      const images = await resolveManagerImages(cwd, conversationId, ids);
      const referenced = selectReferencedImageAttachments(text, images.map((image) => ({ placeholder: image.placeholder,
        tempPath: image.path, fileName: basename(image.path) })));
      if (referenced.length !== images.length) throw new ConversationError('invalid_input');
      return accept();
    });
  }

  async release(cwd: string, conversationId: string, owner: string): Promise<void> {
    const store = new ConversationImageStore(cwd, conversationId);
    await store.exclusive(async () => {
      let metadata = await store.read();
      const workflows = [];
      for (const workflow of metadata.workflows ?? []) {
        if (await hasTaskDirectory(workflow.repositoryDirectory, workflow.taskDirectory)) {
          workflows.push(workflow);
          continue;
        }
        const taskRoot = join(workflow.repositoryDirectory, '.takt', 'tasks');
        const taskSuffix = relative(taskRoot, workflow.taskDirectory);
        if (taskSuffix === '' || taskSuffix === '..' || taskSuffix.split(sep).length !== 1) throw new Error('Invalid manager image task directory');
        const fileNames = [...metadata.images, ...metadata.deleting ?? []].filter((image) => workflow.imageIds.includes(image.id)).map((image) => image.fileName);
        for (const copy of [{ root: workflow.repositoryDirectory, taskDirectory: workflow.taskDirectory }, ...workflow.copies]) {
          const suffix = relative(copy.root, copy.taskDirectory);
          if (!suffix.startsWith('.takt' + sep) || suffix.split(sep).includes('..')) throw new Error('Invalid manager image copy directory');
          for (const fileName of fileNames) await removePrivateImageCopy(copy.root, join(copy.taskDirectory, 'attachments', fileName));
        }
      }
      if (metadata.workflows !== undefined) metadata = { ...metadata, workflows };
      const unused = [];
      for (const image of metadata.images) {
        if (image.owner === owner && !workflows.some((workflow) => workflow.imageIds.includes(image.id))
          && !await this.references.hasImageReference(conversationId, image.id, true)) unused.push(image);
      }
      const removed = new Set(unused.map((image) => image.id));
      const deleting = [...metadata.deleting ?? [], ...unused];
      // Persist removal from the published set before unlink, retaining failed deletions for recovery.
      metadata = { ...metadata, images: metadata.images.filter((image) => !removed.has(image.id)),
        ...(deleting.length === 0 ? {} : { deleting }) };
      await store.save(metadata);
      for (const image of deleting) await removePrivateImageCopy(cwd, store.path(image.fileName));
      if (metadata.deleting !== undefined) {
        const completed = { ...metadata };
        delete completed.deleting;
        await store.save(completed);
      }
    });
  }
}
