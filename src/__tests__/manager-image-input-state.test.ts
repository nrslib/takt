import { beforeEach, expect, it, vi } from 'vitest';
import { useManagerImages } from '../features/manager/useManagerImages.js';
import type { ImagePasteInput, ImagePasteHandlers } from '../features/tui/useImagePaste.js';
import type { StoredImageAttachment } from '../shared/types/image-attachments.js';
import type { ImageAttachmentStore } from '../features/interactive/imageAttachments.js';
import type { PastedImage } from '../features/interactive/inlineImagePaste.js';
import { deferred } from './helpers/daemon-turn.js';

const doubles = vi.hoisted(() => ({
  save: vi.fn(), cleanup: vi.fn(), seal: vi.fn(), list: vi.fn(), select: vi.fn(),
  prepare: vi.fn(), root: vi.fn(), ensure: vi.fn(), createStore: vi.fn(), insert: vi.fn(), notice: vi.fn(), effect: vi.fn(),
  pasteInput: undefined as ImagePasteInput | undefined,
}));
vi.mock('react', () => ({
  useRef: <T>(current: T) => ({ current }),
  useEffect: doubles.effect,
}));
vi.mock('../infra/conversations/imageAttachments.js', () => ({ ensureImageDirectory: doubles.ensure }));
vi.mock('../features/interactive/imageAttachments.js', () => ({
  createSessionImageAttachmentStore: doubles.createStore,
  createImagePasteHandler: (store: ImageAttachmentStore) => async (image: PastedImage) => (await store.saveImage(image.data, image.mimeType)).placeholder,
  createClipboardImagePasteHandler: (store: ImageAttachmentStore) => async () => (await store.saveImage(Buffer.from('png'), 'image/png')).placeholder,
  cleanupImageAttachmentStore: doubles.cleanup,
}));
vi.mock('../shared/utils/imageAttachmentReferences.js', () => ({ resolveReferencedImageAttachments: doubles.select }));
vi.mock('../features/tui/useImagePaste.js', async (original) => ({
  ...await original<typeof import('../features/tui/useImagePaste.js')>(),
  useImagePaste(input: ImagePasteInput): ImagePasteHandlers {
    doubles.pasteInput = input;
    return { routeInput: () => false, flushPending: () => {}, captureClipboard: () => {} };
  },
}));
const stored: StoredImageAttachment = { placeholder: '[Image #1]', tempPath: '/temporary/image-1.png', fileName: 'image-1.png' };
const image = { id: '11111111-1111-4111-8111-111111111111', placeholder: '[Image #7]', path: '/persistent/image-7.png' };
beforeEach(() => {
  vi.clearAllMocks(); doubles.pasteInput = undefined;
  doubles.save.mockResolvedValue(stored); doubles.list.mockReturnValue([stored]);
  doubles.prepare.mockResolvedValue(image); doubles.select.mockReturnValue([{ placeholder: image.placeholder, path: stored.tempPath }]);
  doubles.root.mockReset().mockResolvedValue('/repo');
  doubles.ensure.mockReset().mockResolvedValue('/repo/.takt/tmp/images');
  doubles.createStore.mockReset().mockImplementation(() => ({ saveImage: doubles.save, listAttachments: doubles.list, cleanup: doubles.cleanup, seal: doubles.seal }));
});
const create = () => useManagerImages({ lang: 'en', enabled: true,
  client: { prepareImage: doubles.prepare, getImageDirectory: doubles.root }, insert: doubles.insert, notice: doubles.notice });

it('prepares the shared store image and maps its returned placeholder to its persistent image ID', async () => {
  const images = create();
  expect(await doubles.pasteInput!.sink.saveInlineImage({ data: Buffer.from('png'), mimeType: 'image/png' })).toBe(image.placeholder);
  expect(doubles.prepare).toHaveBeenCalledExactlyOnceWith(stored.tempPath);
  expect(doubles.createStore).toHaveBeenCalledExactlyOnceWith('/repo');
  expect(doubles.ensure).toHaveBeenCalledExactlyOnceWith('/repo', ['.takt', 'tmp', 'images']);
  expect(doubles.ensure.mock.invocationCallOrder[0]).toBeLessThan(doubles.save.mock.invocationCallOrder[0]!);
  expect(images.ids('Inspect ' + image.placeholder)).toEqual([image.id]);
  expect(doubles.select).toHaveBeenCalledExactlyOnceWith('Inspect ' + image.placeholder, [{ ...stored, placeholder: image.placeholder }]);
});

it('does not resolve or create image storage for an unused connection, including when it stops', async () => {
  const images = create();
  await images.stop();
  expect(doubles.root).not.toHaveBeenCalled();
  expect(doubles.ensure).not.toHaveBeenCalled();
  expect(doubles.createStore).not.toHaveBeenCalled();
  expect(doubles.cleanup).not.toHaveBeenCalled();
});

it.each(['root', 'directory'] as const)('waits for %s initialization during stop without saving or inserting a late image', async (stage) => {
  const initialization = deferred<string>();
  (stage === 'root' ? doubles.root : doubles.ensure).mockReturnValueOnce(initialization.promise);
  const images = create();
  const saving = doubles.pasteInput!.sink.saveInlineImage({ data: Buffer.from('png'), mimeType: 'image/png' });
  const outcome = expect(saving).rejects.toThrow();
  const controller = new AbortController();
  const completion = saving.then(() => {}, () => {});
  doubles.pasteInput!.track({ controller, completion });
  await vi.waitFor(() => expect(stage === 'root' ? doubles.root : doubles.ensure).toHaveBeenCalledOnce());
  const action = vi.fn(); images.defer(action);
  let finished = false;
  const stopping = images.stop().then(() => { finished = true; });
  expect(controller.signal.aborted).toBe(true);
  expect(finished).toBe(false);
  initialization.resolve('/repo');
  await outcome; await stopping;
  doubles.pasteInput!.insertAtCaret('late');
  expect(doubles.createStore).not.toHaveBeenCalled();
  expect(doubles.save).not.toHaveBeenCalled();
  expect(doubles.prepare).not.toHaveBeenCalled();
  expect(doubles.insert).not.toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();
});

it('shares initialization for the same root and retries it after a storage failure', async () => {
  const images = create();
  doubles.ensure.mockRejectedValueOnce(new Error('Unsafe image directory'));
  await expect(doubles.pasteInput!.sink.saveInlineImage({ data: Buffer.from('png'), mimeType: 'image/png' })).rejects.toThrow();
  expect(doubles.save).not.toHaveBeenCalled();
  expect(doubles.prepare).not.toHaveBeenCalled();
  await Promise.all([
    doubles.pasteInput!.sink.saveInlineImage({ data: Buffer.from('png'), mimeType: 'image/png' }),
    doubles.pasteInput!.sink.pasteClipboardImage(new AbortController().signal),
  ]);
  expect(doubles.createStore).toHaveBeenCalledExactlyOnceWith('/repo');
  await images.stop();
  expect(doubles.cleanup).toHaveBeenCalledOnce();
});

it('keeps each save associated with its acquired store when assignment roots change and cleans up both stores', async () => {
  const first = deferred<StoredImageAttachment>();
  doubles.root.mockResolvedValueOnce('/first').mockResolvedValueOnce('/second');
  doubles.createStore.mockImplementation((root: string): ImageAttachmentStore => {
    const source = { ...stored, tempPath: root + '/image-1.png' };
    return { saveImage: async () => root === '/first' ? first.promise : source,
      listAttachments: () => [source], cleanup: vi.fn(), seal: doubles.seal };
  });
  const images = create();
  const firstSave = doubles.pasteInput!.sink.saveInlineImage({ data: Buffer.from('png'), mimeType: 'image/png' });
  await vi.waitFor(() => expect(doubles.createStore).toHaveBeenCalledWith('/first'));
  await doubles.pasteInput!.sink.saveInlineImage({ data: Buffer.from('png'), mimeType: 'image/png' });
  expect(doubles.prepare).toHaveBeenCalledExactlyOnceWith('/second/image-1.png');
  first.resolve({ ...stored, tempPath: '/first/image-1.png' });
  await firstSave;
  expect(doubles.prepare.mock.calls).toEqual([['/second/image-1.png'], ['/first/image-1.png']]);
  await images.stop();
  expect(doubles.seal).toHaveBeenCalledTimes(2);
  expect(doubles.cleanup).toHaveBeenCalledTimes(2);
});

it('defers input until tracked image preparation completes', async () => {
  const images = create(); let finish!: () => void;
  const completion = new Promise<void>((resolve) => { finish = resolve; });
  doubles.pasteInput!.track({ controller: new AbortController(), completion });
  const action = vi.fn(); images.defer(action);
  expect(images.hasPending()).toBe(true); expect(action).not.toHaveBeenCalled();
  finish(); await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
  expect(images.hasPending()).toBe(false);
});

it('seals and aborts tracked work before cleaning up, and ignores late insertions after stop', async () => {
  const images = create();
  await doubles.pasteInput!.sink.saveInlineImage({ data: Buffer.from('png'), mimeType: 'image/png' });
  let finish!: () => void;
  const controller = new AbortController(); const completion = new Promise<void>((resolve) => { finish = resolve; });
  doubles.pasteInput!.track({ controller, completion });
  const stopping = images.stop();
  expect(controller.signal.aborted).toBe(true); expect(doubles.seal).toHaveBeenCalledOnce();
  expect(doubles.cleanup).not.toHaveBeenCalled();
  finish(); await stopping;
  expect(doubles.cleanup).toHaveBeenCalledOnce();
  doubles.pasteInput!.insertAtCaret('late image'); doubles.pasteInput!.setNotice('late error');
  expect(doubles.insert).not.toHaveBeenCalled(); expect(doubles.notice).not.toHaveBeenCalled();
});
