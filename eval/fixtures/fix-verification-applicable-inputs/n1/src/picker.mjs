import { singleLine } from './single-line.mjs';
import { readGroups } from './registry.mjs';
import { launchGroup } from './launch.mjs';

export function choices(groups) {
  return groups.map(group => {
    const name = singleLine(group.name);
    const repeated = groups.some(other => other.id !== group.id
      && singleLine(other.name) === name
      && other.repositories.length === group.repositories.length
      && other.repositories.every((path, index) => path === group.repositories[index]));
    const title = repeated ? `${name} (${group.id})` : name;
    return {
      value: group.id,
      label: [title, ...group.repositories.map(path => `  ${path.slice(0, 30)}…`)].join('\n'),
    };
  });
}

export async function startSelected(file, id, launch = launchGroup) {
  const groups = await readGroups(file);
  const group = groups.find(item => item.id === id);
  if (!group) throw new Error('候補が見つかりません');
  return launch(group.id, group.repositories, `${file}.active.json`);
}
