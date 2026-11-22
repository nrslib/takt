import { expect, it, vi } from 'vitest';
import { createSlackInquiryDelivery } from '../features/manager/slackInquiryDelivery.js';
import { SlackInquiryBindings } from '../infra/slack/inquiryBindings.js';
import type { SlackClient } from '../infra/slack/client.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import type { SlackInquiryBinding } from '../infra/slack/inquiryBindings.js';
vi.mock('../infra/slack/inquiryBindings.js', async original => ({
  ...await original<typeof import('../infra/slack/inquiryBindings.js')>(),
  SlackInquiryBindings: class {
    private binding?: SlackInquiryBinding;
    async question(channelId: string, target: SlackInquiryBinding['target'], questionId: string) {
      return this.binding?.channelId === channelId && this.binding.questionId === questionId
        && JSON.stringify(this.binding.target) === JSON.stringify(target) ? this.binding : undefined;
    }
    async save(binding: SlackInquiryBinding) { this.binding = binding; }
    async find(channelId: string, parentTs: string) {
      return this.binding?.channelId === channelId && this.binding.parentTs === parentTs ? this.binding : undefined;
    }
  },
}));

it('keeps one saved thread through updates and retries a failed update on the same delivery instance', async () => {
  const bindings = new SlackInquiryBindings(getGlobalConfigDir(), '/repository');
  const client: SlackClient = { start: vi.fn(), postMessage: vi.fn().mockResolvedValue({ kind: 'delivered', parentTs: '1.000001' }),
    updateMessage: vi.fn().mockResolvedValue({ kind: 'delivered' }), postThreadMessage: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  const delivery = createSlackInquiryDelivery({ bindings, client, channelId: 'C0123', language: 'en' });
  const target = { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/repository' };
  const question = createInquiry({ body: 'Format?', options: ['CSV'] });
  expect(await delivery.deliver(target, { ...question, recipient: 'director' }, () => true)).toEqual({ kind: 'delivered' });
  expect(client.postMessage).not.toHaveBeenCalled();
  await delivery.deliver(target, question, () => true);
  expect(await bindings.question('C0123', target, question.id)).toMatchObject({ parentTs: '1.000001' });
  vi.mocked(client.updateMessage).mockResolvedValueOnce({ kind: 'unavailable', reason: 'network' });
  expect((await delivery.deliver(target, { ...question, recipient: 'director' }, () => true)).kind).toBe('unavailable');
  expect((await delivery.deliver(target, { ...question, recipient: 'director' }, () => true)).kind).toBe('delivered');
  expect(client.updateMessage).toHaveBeenLastCalledWith({ channelId: 'C0123', parentTs: '1.000001' }, expect.stringContaining('director'), []);
  await delivery.deliver(target, question, () => true);
  expect(client.postMessage).toHaveBeenCalledOnce();
  expect(client.updateMessage).toHaveBeenLastCalledWith({ channelId: 'C0123', parentTs: '1.000001' }, expect.stringContaining('Format?'), expect.any(Array));
  await delivery.close();
});
