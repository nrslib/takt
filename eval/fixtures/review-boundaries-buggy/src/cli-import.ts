import { importDocument } from './import-document.js';
import type { ImportServices, TaskStore } from './types.js';

export async function importFromCli(
  id: string,
  services: ImportServices,
  store: TaskStore,
): Promise<void> {
  const document = await importDocument(id, services);
  await store.save({
    body: document.body,
    previews: document.previews,
  });
}
