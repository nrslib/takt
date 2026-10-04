const ARCHIVE_PREVIEW_ASSET = 'archive-preview.md';

export function renderArchivePreview(content) {
  return `${ARCHIVE_PREVIEW_ASSET}\n${content}`;
}
