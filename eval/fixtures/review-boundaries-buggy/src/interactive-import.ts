import { importDocument } from './import-document.js';
import type { ImportServices, Preview, TaskStore } from './types.js';

export async function importInteractively(
  id: string,
  services: ImportServices,
  store: TaskStore,
  chooseDestination: () => Promise<string>,
  releasePreviews: (previews: Preview[]) => Promise<void>,
): Promise<void> {
  const document = await importDocument(id, services);
  const destination = await chooseDestination();

  try {
    await store.save({
      body: `${destination}\n${document.body}`,
      previews: document.previews,
    });
  } finally {
    await releasePreviews(document.previews);
  }
}
