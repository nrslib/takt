import type { ImportedDocument, ImportServices } from './types.js';

export async function importDocument(
  id: string,
  services: ImportServices,
): Promise<ImportedDocument> {
  const body = await services.loadBody(id);
  const previews = [];

  for (const url of services.listPreviewUrls(body)) {
    previews.push(await services.downloadPreview(url));
  }

  return { body, previews, warnings: [] };
}
