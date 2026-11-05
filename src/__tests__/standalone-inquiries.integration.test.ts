import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { listPendingInquiries } from '../infra/goals/pending-inquiries.js';
import { StandaloneInquiryStore, type InquiryOwner } from '../infra/goals/standalone-inquiries.js';

it.each(['workspace', 'repository'] as const)('keeps normal questions and their answers within their %s owner', async (kind) => {
  const directory = process.env.TAKT_CONFIG_DIR!;
  const owners: InquiryOwner[] = [];
  for (const [index, name] of ['first', 'second'].entries()) {
    if (kind === 'workspace') {
      const workspaceId = `750e8400-e29b-41d4-a716-44665544000${index + 1}`;
      const path = join(directory, 'workspaces', workspaceId);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'workspace.json'), JSON.stringify({ id: workspaceId, name, repositoryDirectories: [] }));
      owners.push({ kind, workspaceId });
    } else {
      const repositoryDirectory = join(directory, name);
      await mkdir(repositoryDirectory, { recursive: true });
      owners.push({ kind, repositoryDirectory });
    }
  }
  const first = new StandaloneInquiryStore(directory, owners[0]!);
  const second = new StandaloneInquiryStore(directory, owners[1]!);
  const question = await first.create({ body: 'Choose a destination', options: ['A', 'B'] });
  const other = await second.create({ body: 'Choose another destination' });
  expect(await first.listPending()).toEqual([question]);
  expect(await second.listPending()).toEqual([other]);
  const pending = await listPendingInquiries(directory, { ...owners[0]!, repositoryDirectories: [] });
  expect(pending.errors).toEqual([]);
  expect(pending.inquiries.map(({ question }) => question.id)).toEqual([question.id]);
  await first.answer(question.id, { text: 'A' }, 'slack');
  expect((await new StandaloneInquiryStore(directory, owners[0]!).get(question.id)).answer).toMatchObject({ text: 'A', source: 'slack' });
  expect(await second.listPending()).toEqual([other]);
  await expect(second.get(question.id)).rejects.toThrow();
});
