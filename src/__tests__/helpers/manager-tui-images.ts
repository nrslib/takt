import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManagerView } from '../../features/manager/ManagerView.js';
import { readClipboardImage } from '../../features/interactive/clipboardImage.js';
import { MAX_INLINE_IMAGE_BYTES } from '../../features/interactive/inlineImagePaste.js';
import { getLabel } from '../../shared/i18n/index.js';
import { deferred } from './daemon-turn.js';
import { ManagerClientDouble, ENTER, promptFrame, waitFor } from './manager-tui-fixtures.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const imageId = '11111111-1111-4111-8111-111111111111';
const roots = new Set<string>();

class ImageClientDouble extends ManagerClientDouble {
  override prepareImage = vi.fn(async (_source: string) => ({
    id: imageId, placeholder: '[Image #1]', path: '/private/manager-images/image-1.png',
  }));
}

function mountImages() {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-manager-image-input-'));
  roots.add(cwd);
  const client = new ImageClientDouble();
  client.getImageDirectory.mockResolvedValue(cwd);
  const onExit = vi.fn();
  const app = render(createElement(ManagerView, { cwd, lang: 'en', client,
    assignment: { kind: 'repository', repositoryDirectory: cwd, repositoryDirectories: [cwd] },
    initialDiagnostics: [], onExit }));
  return { app, client, onExit, cwd };
}

function osc(data: Buffer, declaredSize = data.length): string {
  return `1337;File=inline=1;size=${declaredSize}:${data.toString('base64')}\x07`;
}

async function typeMultilineDraft(context: ReturnType<typeof mountImages>): Promise<void> {
  context.app.stdin.write('\x1b[200~前\n後\x1b[201~');
  await waitFor(() => expect(promptFrame(context)).toContain('後'));
  context.app.stdin.write('\x01');
}

beforeEach(() => { vi.mocked(readClipboardImage).mockReset().mockResolvedValue({ mimeType: 'image/png', data: png }); });
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

it.each(['\x07', '\x1b\\'])('inserts one split OSC image ending in %j at the multiline draft caret and keeps trailing text', async (terminator) => {
  const context = mountImages();
  await typeMultilineDraft(context);
  const payload = osc(png).slice(0, -1);

  context.app.stdin.write('\x1b]');
  context.app.stdin.write(payload.slice(0, 30));
  context.app.stdin.write(payload.slice(30));
  if (terminator.startsWith('\x1b')) context.app.stdin.write('\x1b');
  context.app.stdin.write(terminator.slice(-1) + '末尾');
  await waitFor(() => expect(promptFrame(context)).toContain('[Image #1]末尾後'));
  context.app.stdin.write(ENTER);

  await waitFor(() => expect(context.client.commands()).toEqual([
    { kind: 'message', text: '前\n[Image #1]末尾後', imageAttachmentIds: [imageId] },
  ]));
  expect(context.client.prepareImage).toHaveBeenCalledOnce();
  expect(readClipboardImage).not.toHaveBeenCalled();
});

it('waits for clipboard image preparation before submitting the same draft exactly once', async () => {
  const context = mountImages();
  const preparation = deferred<{ id: string; placeholder: string; path: string }>();
  context.client.prepareImage.mockReturnValueOnce(preparation.promise);
  await typeMultilineDraft(context);

  try {
    context.app.stdin.write('\x16');
    await waitFor(() => expect(context.client.prepareImage).toHaveBeenCalledOnce());
    context.app.stdin.write(ENTER);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(context.client.submit).not.toHaveBeenCalled();
    preparation.resolve({ id: imageId, placeholder: '[Image #1]', path: '/private/manager-images/image-1.png' });

    await waitFor(() => expect(context.client.commands()).toEqual([
      { kind: 'message', text: '前\n[Image #1]後', imageAttachmentIds: [imageId] },
    ]));
    expect(readClipboardImage).toHaveBeenCalledOnce();
  } finally {
    preparation.resolve({ id: imageId, placeholder: '[Image #1]', path: '/private/manager-images/image-1.png' });
  }
});

it('routes deferred Ctrl+T then Enter to the epic screen before a rerender', async () => {
  const context = mountImages();
  const preparation = deferred<{ id: string; placeholder: string; path: string }>();
  context.client.prepareImage.mockReturnValueOnce(preparation.promise);
  try {
    context.app.stdin.write('Draft');
    await waitFor(() => expect(promptFrame(context)).toContain('Draft'));
    context.app.stdin.write('\x16');
    await waitFor(() => expect(context.client.prepareImage).toHaveBeenCalledOnce());
    context.app.stdin.write('\x14');
    context.app.stdin.write(ENTER);
    preparation.resolve({ id: imageId, placeholder: '[Image #1]', path: '/private/manager-images/image-1.png' });
    await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.epics.workspaceRequired', 'en')));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(context.client.submit).not.toHaveBeenCalled();
  } finally {
    preparation.resolve({ id: imageId, placeholder: '[Image #1]', path: '/private/manager-images/image-1.png' });
  }
});

it('keeps a prepared image draft on the same mounted screen across disconnect and reconnect', async () => {
  const context = mountImages();
  const resumedId = '22222222-2222-4222-8222-222222222222';
  context.client.prepareImage.mockResolvedValueOnce({ id: imageId, placeholder: '[Image #1]', path: '/private/manager-images/image-1.png' });
  context.client.prepareImage.mockResolvedValueOnce({ id: resumedId, placeholder: '[Image #2]', path: '/private/manager-images/image-2.png' });
  context.app.stdin.write('Inspect ');
  await waitFor(() => expect(promptFrame(context)).toContain('Inspect '));
  context.app.stdin.write('\x16');
  await waitFor(() => expect(promptFrame(context)).toContain('Inspect [Image #1]'));

  context.client.change({ connection: 'disconnected' });
  await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('manager.conversation.disconnected', 'en')));
  expect(promptFrame(context)).toContain('Inspect [Image #1]');
  context.client.change({ connection: 'connected', readStatus: 'complete' });
  context.app.stdin.write(ENTER);

  await waitFor(() => expect(context.client.commands()).toEqual([
    { kind: 'message', text: 'Inspect [Image #2]', imageAttachmentIds: [resumedId] },
  ]));
  expect(context.client.prepareImage).toHaveBeenCalledTimes(2);
  expect(context.client.prepareImage.mock.calls[1]![0]).toBe(context.client.prepareImage.mock.calls[0]![0]);
});

it('keeps consecutive prepared image numbers and associates only referenced images with each submitted message', async () => {
  const context = mountImages();
  const secondId = '22222222-2222-4222-8222-222222222222';
  context.client.prepareImage.mockResolvedValueOnce({ id: imageId, placeholder: '[Image #1]', path: '/private/manager-images/image-1.png' });
  context.client.prepareImage.mockResolvedValueOnce({ id: secondId, placeholder: '[Image #2]', path: '/private/manager-images/image-2.png' });

  for (const placeholder of ['[Image #1]', '[Image #2]']) {
    context.app.stdin.write('\x16');
    await waitFor(() => expect(promptFrame(context)).toContain(placeholder));
    context.app.stdin.write(ENTER);
    await waitFor(() => expect(context.client.submit).toHaveBeenCalledTimes(placeholder === '[Image #1]' ? 1 : 2));
  }

  expect(context.client.commands()).toEqual([
    { kind: 'message', text: '[Image #1]', imageAttachmentIds: [imageId] },
    { kind: 'message', text: '[Image #2]', imageAttachmentIds: [secondId] },
  ]);
  expect(context.client.prepareImage).toHaveBeenCalledTimes(2);
});

it.each([
  ']1337;File=inline=1;size=4:iVBORw==\\末尾',
  ']1337;File=inline=1:AAAA',
  '> ]1337;File=inline=1:AAAA',
  '`]1337;File=inline=1:AAAA`',
  '~~~\n]1337;File=inline=1:AAAA\n~~~',
  '~~~\n]1337;File=inline=1:AAAA',
  '```\n]1337;File=inline=1:AAAA\n```',
  '```\n]1337;File=inline=1:AAAA',
])('keeps OSC-like literal text unchanged without preparing images: %j', async (text) => {
  const context = mountImages();
  await typeMultilineDraft(context);
  context.app.stdin.write('\x1b[200~' + text + '\x1b[201~');
  await waitFor(() => expect(promptFrame(context)).toContain(']1337;File='));
  context.app.stdin.write(ENTER);

  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'message', text: '前\n' + text + '後' }]));
  expect(context.client.prepareImage).not.toHaveBeenCalled();
  expect(readClipboardImage).not.toHaveBeenCalled();
});

it.each([
  ['unsupported format', osc(Buffer.from('not an image'))],
  ['oversized declaration', osc(png, MAX_INLINE_IMAGE_BYTES + 1)],
])('shows an error for %s without putting image payload or references into the draft', async (_reason, payload) => {
  const context = mountImages();
  context.app.stdin.write('本文');
  await waitFor(() => expect(promptFrame(context)).toContain('本文'));

  context.app.stdin.write('\x1b]');
  context.app.stdin.write(payload);
  await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('tui.errors.imagePasteFailed', 'en')));
  expect(promptFrame(context)).toContain('本文');
  context.app.stdin.write(ENTER);

  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'message', text: '本文' }]));
  expect(context.client.prepareImage).not.toHaveBeenCalled();
});

it('preserves the existing draft after a clipboard read failure without submitting a broken image reference', async () => {
  const context = mountImages();
  vi.mocked(readClipboardImage).mockRejectedValueOnce(new Error('Clipboard read failed'));
  context.app.stdin.write('本文');
  await waitFor(() => expect(promptFrame(context)).toContain('本文'));

  context.app.stdin.write('\x16');
  await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('tui.errors.imagePasteFailed', 'en')));
  expect(promptFrame(context)).toContain('本文');
  context.app.stdin.write(ENTER);

  await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'message', text: '本文' }]));
  expect(context.client.prepareImage).not.toHaveBeenCalled();
});

it.each(['clipboard', 'split OSC'] as const)('rejects symlinked temporary image ancestors before writing via %s and keeps the draft', async (gesture) => {
  for (const component of ['.takt', 'tmp', 'images']) {
    const context = mountImages();
    const target = component === '.takt' ? context.cwd : join(context.cwd, 'redirected');
    if (component !== '.takt') mkdirSync(target);
    const parent = component === '.takt' ? context.cwd : join(context.cwd, '.takt', ...(component === 'images' ? ['tmp'] : []));
    mkdirSync(parent, { recursive: true });
    symlinkSync(component === '.takt' ? '.' : target, join(parent, component), 'dir');
    const before = readdirSync(target, { recursive: true });
    context.app.stdin.write('確認');
    await waitFor(() => expect(promptFrame(context)).toContain('確認'));

    if (gesture === 'clipboard') context.app.stdin.write('\x16');
    else {
      const payload = osc(png);
      context.app.stdin.write('\x1b]'); context.app.stdin.write(payload.slice(0, 20)); context.app.stdin.write(payload.slice(20) + '末尾');
    }
    await waitFor(() => expect(context.app.lastFrame()).toContain(getLabel('tui.errors.imagePasteFailed', 'en')));
    expect(promptFrame(context)).toContain(gesture === 'clipboard' ? '確認' : '確認末尾');
    expect(readdirSync(target, { recursive: true })).toEqual(before);
    expect(context.client.prepareImage).not.toHaveBeenCalled();
    context.app.stdin.write(ENTER);
    await waitFor(() => expect(context.client.commands()).toEqual([{ kind: 'message', text: gesture === 'clipboard' ? '確認' : '確認末尾' }]));
    context.app.unmount();
  }
});

it('stores clipboard bytes with private directory and file permissions before preparing the image', async () => {
  const context = mountImages();
  context.app.stdin.write('\x16');
  await waitFor(() => expect(context.client.prepareImage).toHaveBeenCalledOnce());
  const source = context.client.prepareImage.mock.calls[0]![0];
  expect(statSync(source).mode & 0o777).toBe(0o600);
  for (const path of [join(context.cwd, '.takt'), join(context.cwd, '.takt', 'tmp'), join(context.cwd, '.takt', 'tmp', 'images')]) {
    expect(statSync(path).mode & 0o777).toBe(0o700);
  }
});

it('detaches on Ctrl+C while preparing an image and never submits a late completion', async () => {
  const context = mountImages();
  const preparation = deferred<{ id: string; placeholder: string; path: string }>();
  context.client.prepareImage.mockReturnValueOnce(preparation.promise);
  context.app.stdin.write('Unsent draft');
  await waitFor(() => expect(promptFrame(context)).toContain('Unsent draft'));
  try {
    context.app.stdin.write('\x16');
    await waitFor(() => expect(context.client.prepareImage).toHaveBeenCalledOnce());

    context.app.stdin.write('\x03');
    preparation.resolve({ id: imageId, placeholder: '[Image #1]', path: '/private/manager-images/image-1.png' });
    await waitFor(() => expect(context.onExit).toHaveBeenCalledOnce());
    context.app.unmount();

    expect(context.client.close).toHaveBeenCalledOnce();
    expect(context.client.submit).not.toHaveBeenCalled();
  } finally {
    preparation.resolve({ id: imageId, placeholder: '[Image #1]', path: '/private/manager-images/image-1.png' });
  }
});
