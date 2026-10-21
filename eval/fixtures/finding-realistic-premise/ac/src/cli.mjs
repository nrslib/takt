import { init, add, exportTo } from './bookmarks.mjs';
const [command, value, ...args] = process.argv.slice(2);
const root = process.cwd();
switch (command) {
  case 'init': init(root); break;
  case 'add': console.log(JSON.stringify(add(root, value, args))); break;
  case 'export': exportTo(root, value); break;
  default: throw new Error('Unknown command');
}
