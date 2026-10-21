import fs from 'node:fs';
import { init, add, sync } from './bookmarks.mjs';
const [command, value, ...args] = process.argv.slice(2);
const root = process.cwd();
switch (command) {
  case 'init': init(root); break;
  case 'add': console.log(JSON.stringify(add(root, value, args))); break;
  case 'sync': {
    if (args[0] !== '--jobs') throw new Error('Specify --jobs N');
    await sync(root, JSON.parse(fs.readFileSync(value, 'utf8')), Number(args[1]));
    break;
  }
  default: throw new Error('Unknown command');
}
