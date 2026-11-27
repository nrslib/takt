import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { registerGroup } from './registration.mjs';
import { readGroups } from './registry.mjs';
import { choices, startSelected } from './picker.mjs';

export async function main(args, file) {
  if (args[0] === 'register') {
    return registerGroup(file, args[1], args.slice(2));
  }
  if (args[0] !== 'select') throw new Error('register または select を指定してください');
  const items = choices(await readGroups(file));
  if (items.length === 0) throw new Error('登録済みの組がありません');
  items.forEach((item, index) => stdout.write(`${index + 1}. ${item.label}\n`));
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await terminal.question('番号: ');
    return await selectAndStart(file, answer);
  } finally {
    terminal.close();
  }
}

export async function selectAndStart(file, answer) {
  if (!/^[1-9][0-9]*$/.test(answer)) throw new Error('番号が不正です');
  const items = choices(await readGroups(file));
  const item = items[Number(answer) - 1];
  if (!item) throw new Error('番号が不正です');
  return startSelected(file, item.value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await main(process.argv.slice(2), '.groups.json'));
}
