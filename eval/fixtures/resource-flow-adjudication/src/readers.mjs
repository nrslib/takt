export async function preview(source) {
  const text = await source.readText();
  return text.slice(0, 80);
}

export async function deliver(source, sink) {
  const blocks = [];
  for await (const block of source.chunks()) blocks.push(block);
  for (const block of blocks) await sink.write(block);
}

export async function relay(source, sink) {
  for await (const block of source.chunks()) await sink.write(block);
}

export async function summarize(source) {
  let length = 0;
  for await (const block of source.chunks()) length += block.length;
  return length;
}

export async function readManifest(manifest) {
  return [...await manifest.readEntries()];
}
