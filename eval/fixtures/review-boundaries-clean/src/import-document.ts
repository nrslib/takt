import type { ImportedDocument, ImportServices, Preview } from './types.js';

export async function importDocument(
  id: string,
  services: ImportServices,
): Promise<ImportedDocument> {
  const body = await services.loadBody(id);
  const previews: Preview[] = [];
  const warnings: string[] = [];

  for (const url of services.listPreviewUrls(body)) {
    try {
      previews.push(await services.downloadPreview(url));
    } catch {
      warnings.push(`Preview download failed: ${url}`);
    }
  }

  return { body, previews, warnings };
}
