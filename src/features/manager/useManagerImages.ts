import { useEffect, useRef } from 'react';
import { ensureImageDirectory } from '../../infra/conversations/imageAttachments.js';
import type { ConversationIpcClient } from './conversationIpcClient.js';
import { createClipboardImagePasteHandler, createImagePasteHandler, createSessionImageAttachmentStore,
  cleanupImageAttachmentStore, type ImageAttachmentStore } from '../interactive/imageAttachments.js';
import { awaitPendingWork, drainPendingWork, useImagePaste, type PendingWork } from '../tui/useImagePaste.js';
import { resolveReferencedImageAttachments } from '../../shared/utils/imageAttachmentReferences.js';
import type { ManagerImageAttachmentReference, StoredImageAttachment } from '../../shared/types/image-attachments.js';

export function useManagerImages(input: {
  lang: 'ja' | 'en'; enabled: boolean;
  client: Pick<ConversationIpcClient, 'prepareImage' | 'getImageDirectory'>;
  insert(text: string): void; notice(message: string | null): void;
}) {
  const stores = useRef(new Map<string, Promise<ImageAttachmentStore>>());
  const ownedStores = useRef(new Set<ImageAttachmentStore>());
  const latest = useRef(input);
  latest.current = input;
  const stopped = useRef(false);
  const stopping = useRef<Promise<void> | undefined>(undefined);
  const pending = useRef(new Set<PendingWork>());
  const images = useRef(new Map<string, { image: ManagerImageAttachmentReference; source: StoredImageAttachment }>());
  const getStore = async (client: typeof input.client): Promise<ImageAttachmentStore> => {
    const root = await client.getImageDirectory();
    if (stopped.current) throw new Error('Image input stopped');
    let initializing = stores.current.get(root);
    if (initializing === undefined) {
      initializing = ensureImageDirectory(root, ['.takt', 'tmp', 'images']).then(() => {
        if (stopped.current) throw new Error('Image input stopped');
        const store = createSessionImageAttachmentStore(root);
        ownedStores.current.add(store);
        return store;
      });
      stores.current.set(root, initializing);
      void initializing.catch(() => { stores.current.delete(root); });
    } else {
      await ensureImageDirectory(root, ['.takt', 'tmp', 'images']);
    }
    const store = await initializing;
    if (stopped.current) throw new Error('Image input stopped');
    return store;
  };
  const prepare = async (store: ImageAttachmentStore, client: typeof input.client, placeholder: string): Promise<string> => {
    const source = store.listAttachments().find((image) => image.placeholder === placeholder);
    if (source === undefined) throw new Error('Missing pasted image');
    const image = await client.prepareImage(source.tempPath);
    if (!stopped.current) images.current.set(image.placeholder, { image, source });
    return image.placeholder;
  };
  const sealImages = (): void => { for (const store of ownedStores.current) store.seal(); };
  const paste = useImagePaste({ lang: input.lang, rejectInvalidImages: true,
    sink: {
      async pasteClipboardImage(signal) {
        const client = latest.current.client;
        const store = await getStore(client);
        return prepare(store, client, await createClipboardImagePasteHandler(store)(signal));
      },
      async saveInlineImage(image) {
        const client = latest.current.client;
        const store = await getStore(client);
        return prepare(store, client, await createImagePasteHandler(store)(image));
      },
      sealImages,
    },
    insertAtCaret: (text) => { if (!stopped.current && latest.current.enabled) latest.current.insert(text); },
    setNotice: (message) => { if (!stopped.current) latest.current.notice(message); },
    track(work) {
      pending.current.add(work);
      void work.completion.finally(() => pending.current.delete(work));
    },
    isStopped: () => stopped.current || !latest.current.enabled,
  });
  const stop = (): Promise<void> => {
    stopped.current = true;
    sealImages();
    stopping.current ??= drainPendingWork(pending.current).then(async () => {
      await Promise.allSettled([...stores.current.values()]);
      for (const store of ownedStores.current) cleanupImageAttachmentStore(store);
      ownedStores.current.clear();
      stores.current.clear();
    });
    return stopping.current;
  };
  useEffect(() => () => { void stop(); }, []);
  return {
    paste,
    hasPending: () => pending.current.size > 0,
    defer(action: () => void) {
      void awaitPendingWork(pending.current).then(() => { if (!stopped.current) action(); });
    },
    ids(text: string): string[] {
      const referenced = resolveReferencedImageAttachments(text, [...images.current.values()].map(({ image, source }) => ({ ...source, placeholder: image.placeholder })));
      return referenced.map(({ placeholder }) => images.current.get(placeholder)!.image.id);
    },
    stop,
  };
}
