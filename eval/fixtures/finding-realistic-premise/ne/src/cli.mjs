import { init, newSnippet, complete, prune, importArchive } from './snippets.mjs';
const [command, value] = process.argv.slice(2);
const root = process.cwd();
switch (command) {
  case 'init': init(root); break;
  case 'new': console.log(JSON.stringify(newSnippet(root))); break;
  case 'done': complete(root, value); break;
  case 'prune': console.log(prune(root)); break;
  case 'import': console.log(importArchive(root, value)); break;
  default: throw new Error('Unknown command');
}
