import { readDocument } from './reader.mjs';
export async function serve(fs) {
  const settings = JSON.parse(await fs.readFile('.state/selection.json', 'utf8'));
  return readDocument(settings, fs);
}
