import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname } from 'node:path';

vi.mock('node:fs', () => ({ rmSync: vi.fn() }));
vi.mock('../shared/utils/private-file.js', () => ({ ensurePrivateDirectory: vi.fn(), writeNewPrivateFileWithMode: vi.fn() }));
vi.mock('../shared/ui/index.js', () => ({ warn: vi.fn() }));
vi.mock('../infra/github/image-download.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/github/image-download.js')>()),
  downloadGithubImage: vi.fn(),
}));

import { rmSync } from 'node:fs';
import { ensurePrivateDirectory, writeNewPrivateFileWithMode } from '../shared/utils/private-file.js';
import { warn } from '../shared/ui/index.js';
import { downloadGithubImage } from '../infra/github/image-download.js';
import { prepareGithubTaskImages, type PreparedGithubTaskImages } from '../features/tasks/githubImages.js';
import type { Issue } from '../infra/git/types.js';

const x = 'https://github.com/user-attachments/assets/x';
const y = 'https://github.com/user-attachments/assets/y';
const bytes = Buffer.from('89504e470d0a1a0a', 'hex');

function issue(body: string): Issue {
  return { number: 792, title: 'Images', body, labels: [], comments: [] };
}

describe('prepareGithubTaskImages resource ownership', () => {
  const results: PreparedGithubTaskImages[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(downloadGithubImage).mockResolvedValue({ bytes, extension: 'png' });
  });

  afterEach(() => {
    for (const result of results.splice(0)) result.cleanup();
  });

  it('retains saved files until the owner releases them and removes its exit handler', async () => {
    const listeners = process.listenerCount('exit');
    const result = await prepareGithubTaskImages('/project', { issue: issue(`![a](${x})`) });
    results.push(result);

    expect(result.attachments).toHaveLength(1);
    const attachment = result.attachments[0]!;
    expect(attachment).toMatchObject({ fileName: 'image-1.png', placeholder: '[Image #1]' });
    expect(ensurePrivateDirectory).toHaveBeenCalledWith(dirname(attachment.tempPath));
    expect(writeNewPrivateFileWithMode).toHaveBeenCalledWith(attachment.tempPath, bytes, 0o600);
    expect(rmSync).not.toHaveBeenCalled();
    expect(process.listenerCount('exit')).toBe(listeners + 1);

    result.cleanup();
    result.cleanup();

    expect(rmSync).toHaveBeenCalledExactlyOnceWith(dirname(attachment.tempPath), { recursive: true, force: true });
    expect(process.listenerCount('exit')).toBe(listeners);
  });

  it('does not consume a number or supplement a reference whose file cannot be saved', async () => {
    vi.mocked(writeNewPrivateFileWithMode).mockImplementationOnce(() => { throw new Error('disk full'); });
    const result = await prepareGithubTaskImages('/project', { issue: issue(`![a](${x})\n![b](${y})`) });
    results.push(result);

    expect(result.attachments.map(({ fileName, placeholder }) => ({ fileName, placeholder })))
      .toEqual([{ fileName: 'image-1.png', placeholder: '[Image #1]' }]);
    expect(result.task.split('\n')).toContain(`![a](${x})`);
    expect(result.task.split('\n')).toContain(`![b](${y}) [Image #1]`);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never downloads metadata or external URLs and creates no temporary directory without successful images', async () => {
    const result = await prepareGithubTaskImages('/project', { issue: {
      ...issue('![external](https://example.com/image.png)'), title: `![title](${x})`, labels: [`![label](${y})`],
    } });
    results.push(result);

    expect(result.attachments).toEqual([]);
    expect(downloadGithubImage).not.toHaveBeenCalled();
    expect(ensurePrivateDirectory).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once for a failed URL without exposing its query or exception credentials', async () => {
    const signedUrl = `${x}?signature=private-signature`;
    vi.mocked(downloadGithubImage).mockRejectedValue(new Error('private-credential'));
    const result = await prepareGithubTaskImages('/project', { issue: issue(`![a](${signedUrl})\n![a](${signedUrl})`) });
    results.push(result);

    expect(downloadGithubImage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = vi.mocked(warn).mock.calls[0]![0];
    expect(warning).toContain(x);
    expect(warning).not.toContain('private-signature');
    expect(warning).not.toContain('private-credential');
    expect(result.attachments).toEqual([]);
  });

  it('cleans a directory even when its preparation fails after creating it', async () => {
    vi.mocked(ensurePrivateDirectory).mockImplementationOnce(() => { throw new Error('directory setup failed'); });
    const result = await prepareGithubTaskImages('/project', { issue: issue(`![a](${x})`) });
    results.push(result);

    expect(result.attachments).toEqual([]);
    expect(writeNewPrivateFileWithMode).not.toHaveBeenCalled();
    result.cleanup();
    expect(rmSync).toHaveBeenCalledExactlyOnceWith(vi.mocked(ensurePrivateDirectory).mock.calls[0]![0], { recursive: true, force: true });
  });
});
