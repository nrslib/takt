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

  try {
    const destination = await chooseDestination();
    await store.save({
      body: `${destination}\n${document.body}`,
      previews: document.previews,
      warnings: document.warnings,
    });
  } finally {
    await releasePreviews(document.previews);
  }
}
