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

export function exportTo(root, target) {
  const data = fs.readFileSync(path.join(root, 'bookmarks.json'));
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, target);
}
