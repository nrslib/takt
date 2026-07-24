import { importDocument } from './import-document.js';
import type { ImportServices, Preview, TaskStore } from './types.js';

export async function enqueueImportedDocument(
  id: string,
  services: ImportServices,
  store: TaskStore,
  releasePreviews: (previews: Preview[]) => Promise<void>,
): Promise<void> {
  const document = await importDocument(id, services);
  try {
    await store.save({
      body: document.body,
      previews: document.previews,
      warnings: document.warnings,
    });
  } finally {
    await releasePreviews(document.previews);
  }
}
