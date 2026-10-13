import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerGroup } from '../src/registration.mjs';
import { readGroups } from '../src/registry.mjs';
import { choices } from '../src/picker.mjs';

const root = await mkdtemp(join(tmpdir(), 'group-picker-observation-'));
try {
  const file = join(root, 'groups.json');
  for (const name of ['payment-api', 'payment-worker']) {
    const repository = join(root, 'projects/customer-services', name);
    await mkdir(join(repository, '.git'), { recursive: true });
    await registerGroup(file, '開発', [repository]);
  }
  const groups = await readGroups(file);
  const items = choices(groups);
  console.log(JSON.stringify(groups.map((group, index) => ({
    id: group.id, path: group.repositories[0], label: items[index].label,
  })), null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
