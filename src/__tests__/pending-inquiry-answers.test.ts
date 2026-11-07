import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { publishPendingInquiryAnswers } from '../features/daemon/pendingInquiryAnswers.js';

let directory: string | undefined;
afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it('keeps a failed publication pending and clears it after a later accepted publication', async () => {
  directory = await mkdtemp(join(tmpdir(), 'takt-inquiry-outbox-'));
  const owner = { kind: 'workspace' as const, workspaceId: '750e8400-e29b-41d4-a716-446655440001' };
  const store = new StandaloneInquiryStore(directory, owner);
  const question = await store.create({ body: 'Which output format?' });
  await store.answerForPublication(question.id, { text: 'CSV' });
  const errors: unknown[] = [];
  const publish = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined);

  await publishPendingInquiryAnswers(directory, [owner], publish, (error) => errors.push(error));
  expect(errors).toHaveLength(1);
  expect((await store.get(question.id)).answerPublicationPending).toBe(true);

  await publishPendingInquiryAnswers(directory, [owner], publish, (error) => errors.push(error));
  expect(publish).toHaveBeenCalledTimes(2);
  expect((await store.get(question.id)).answerPublicationPending).toBeUndefined();
});
