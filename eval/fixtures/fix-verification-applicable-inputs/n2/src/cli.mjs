import { listPage } from './pagination.mjs';
import { pathToFileURL } from 'node:url';

export function runCli(args, items) {
  const page = Number.parseInt(args[0], 10);
  return listPage(items, page, 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(runCli(process.argv.slice(2), ['one', 'two', 'three', 'four', 'five']));
}
