import fs from 'node:fs';
import path from 'node:path';

export function init(root) {
  fs.writeFileSync(path.join(root, 'bookmarks.json'), '[]\n');
}

export function add(root, url, tags) {
  const file = path.join(root, 'bookmarks.json');
  const bookmarks = JSON.parse(fs.readFileSync(file, 'utf8'));
  bookmarks.push({ url, tags });
  fs.writeFileSync(file, JSON.stringify(bookmarks));
  return bookmarks;
}

export async function sync(root, urls, jobs) {
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error('jobs must be a positive integer');
  for (let offset = 0; offset < urls.length; offset += jobs) {
    await Promise.all(urls.slice(offset, offset + jobs).map(async url => {
      const file = path.join(root, 'bookmarks.json');
      const bookmarks = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      bookmarks.push({ url, tags: [] });
      await fs.promises.writeFile(file, JSON.stringify(bookmarks));
    }));
  }
}
