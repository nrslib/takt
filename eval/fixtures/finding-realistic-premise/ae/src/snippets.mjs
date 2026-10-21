import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function stateFile(root) {
  return path.join(root, '.snip', 'state.json');
}

export function init(root) {
  fs.mkdirSync(path.join(root, '.snip', 'work'), { recursive: true });
  fs.writeFileSync(path.join(root, '.snip', '.gitignore'), '*\n');
  fs.writeFileSync(stateFile(root), '[]\n');
}

export function newSnippet(root) {
  const id = randomUUID();
  const directory = path.resolve(root, '.snip', 'work', id);
  fs.mkdirSync(directory);
  const entries = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
  entries.push({ id, directory, completed: false });
  fs.writeFileSync(stateFile(root), JSON.stringify(entries));
  return { id, directory };
}

export function complete(root, id) {
  const entries = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
  const entry = entries.find(item => item.id === id);
  if (!entry) throw new Error('Snippet not found');
  entry.completed = true;
  fs.writeFileSync(stateFile(root), JSON.stringify(entries));
}

export function prune(root) {
  const entries = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
  for (const entry of entries.filter(item => item.completed)) {
    fs.rmSync(entry.directory, { recursive: true, force: true });
  }
  const remaining = entries.filter(item => !item.completed);
  fs.writeFileSync(stateFile(root), JSON.stringify(remaining));
  return remaining.length;
}

export function importArchive(root, archive) {
  const entries = JSON.parse(fs.readFileSync(archive, 'utf8'));
  const destination = path.join(root, '.snip', 'imports');
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const file = path.join(destination, entry.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.content);
  }
  return entries.length;
}
