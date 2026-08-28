import { loadInput } from './load-input.js';
import { renderDocument } from './render-document.js';
import { settings } from './settings.js';
import { writeIndex } from './write-index.js';

export function buildArtifact(projectRoot) {
  const input = loadInput(projectRoot, settings.source);
  const document = renderDocument(input, settings.documentPath);
  const sections = [...settings.sections].sort((left, right) => left.order - right.order);
  const indexFile = writeIndex(projectRoot, settings.indexPath, document.content);
  return { document, sections, indexFile };
}
