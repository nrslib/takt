export interface Preview {
  path: string;
  sourceUrl: string;
}

export interface ImportedDocument {
  body: string;
  previews: Preview[];
  warnings: string[];
}

export interface ImportServices {
  loadBody(id: string): Promise<string>;
  listPreviewUrls(body: string): string[];
  downloadPreview(url: string): Promise<Preview>;
}

export interface TaskStore {
  save(input: { body: string; previews: Preview[]; warnings: string[] }): Promise<void>;
}
