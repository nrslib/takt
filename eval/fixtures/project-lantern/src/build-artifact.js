import { loadInput } from './load-input.js';
import { renderDocument } from './render-document.js';
import { settings } from './settings.js';
import { writeIndex } from './write-index.js';

export function buildArtifact(projectRoot, currentSettings = settings) {
  const input = loadInput(projectRoot, currentSettings.source);
  const document = renderDocument(input, currentSettings.documentLabel);
  const sections = [...currentSettings.sections].sort((left, right) => left.order - right.order);
  const indexFile = writeIndex(projectRoot, currentSettings.indexPath, document.content);
  return { document, sections, indexFile };
}
