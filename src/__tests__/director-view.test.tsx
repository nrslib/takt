import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { DirectorView } from '../features/director/DirectorView.js';
import { ManagerClientDouble } from './helpers/manager-tui-fixtures.js';
import { getLabel } from '../shared/i18n/index.js';
import { measureWidth } from '../shared/utils/grapheme.js';
import { stripAnsi } from '../shared/utils/text.js';
import { randomUUID } from 'node:crypto';

afterEach(cleanup);
it('shows a remote message once and avoids repeating its own accepted message', async () => {
  const client = new ManagerClientDouble();
  const app = render(createElement(DirectorView, { client, lang: 'en', onExit: vi.fn() }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('director.costNotice', 'en')));
  const remote = { kind: 'user_message' as const, operationId: randomUUID(), message: 'Remote request' };
  client.output(remote); client.output(remote);
  await vi.waitFor(() => expect(app.lastFrame()!.split(remote.message)).toHaveLength(2));
  app.stdin.write('Local request');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Local request'));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(client.commands()).toHaveLength(1));
  const operationId = await client.operation();
  client.output({ kind: 'user_message', operationId, message: 'Local request' });
  await vi.waitFor(() => {
    expect(app.lastFrame()!.split('Local request')).toHaveLength(2);
    expect(app.lastFrame()!.split(remote.message)).toHaveLength(2);
  });
});
it.each(['ja', 'en'] as const)('shows startup notices at 80 columns and detaches without cancelling in %s', async (lang) => {
  const client = new ManagerClientDouble();
  const exit = vi.fn();
  const app = render(createElement(DirectorView, { client, lang, onExit: exit }));
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('director.costNotice', lang)));
  Object.defineProperty(app.stdout, 'columns', { configurable: true, get: () => 80 });
  app.stdout.emit('resize');
  await vi.waitFor(() => expect(app.lastFrame()).toContain(getLabel('director.costNotice', lang)));
  expect(app.lastFrame()!.replace(/\s+/gu, ' ')).toContain(getLabel('director.experimentalNotice', lang));
  await vi.waitFor(() => {
    for (const line of stripAnsi(app.lastFrame()!).split('\n')) expect(measureWidth(line)).toBeLessThanOrEqual(80);
  });
  app.stdin.write('status');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('status'));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(client.commands()).toEqual([{ kind: 'message', text: 'status' }]));
  client.output({ kind: 'notice', id: 'notice', message: 'decision required' });
  client.change({ items: [{ kind: 'display_event', event: { id: 'notice', message: 'decision required' } }] });
  await vi.waitFor(() => expect(app.frames.join('\n')).toContain('decision required'));
  app.stdin.write('\x03');
  await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
  expect(client.commands()).toEqual([{ kind: 'message', text: 'status' }]);
  app.unmount();
  expect(client.close).toHaveBeenCalled();
});
