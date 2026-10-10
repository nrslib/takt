import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFileSync } = vi.hoisted(() => ({ mockExecFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mockExecFileSync }));

import { downloadGithubImage, isGithubImageAttachmentUrl } from '../infra/github/image-download.js';

const url = 'https://github.com/user-attachments/assets/image';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const limit = 10 * 1024 * 1024;
const mockFetch = vi.fn<typeof fetch>();

function imageResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(new Uint8Array(bytes), { headers: { 'content-type': contentType } });
}

describe('downloadGithubImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockExecFileSync.mockReturnValue('test-credential\n');
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { mime: 'image/png', bytes: png, extension: 'png' },
    { mime: 'image/jpeg', bytes: Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex'), extension: 'jpg' },
    { mime: 'image/gif', bytes: Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b', 'hex'), extension: 'gif' },
    { mime: 'image/webp', bytes: Buffer.from('524946461a000000574542505650384c0e0000002f000000000710fd8ffe0722a2ff01', 'hex'), extension: 'webp' },
  ])('accepts matching MIME and magic bytes for $mime', async ({ mime, bytes, extension }) => {
    mockFetch.mockResolvedValueOnce(imageResponse(bytes, mime));

    const result = await downloadGithubImage(url, '/project');

    expect(result).toEqual({ bytes, extension });
  });

  it.each([
    url,
    'https://github.com/owner/repo/assets/123/image',
    'https://user-images.githubusercontent.com/123/image.png',
    'https://private-user-images.githubusercontent.com/123/image.png',
  ])('downloads a supported GitHub attachment URL: %s', async (attachmentUrl) => {
    mockFetch.mockResolvedValueOnce(imageResponse(png, 'image/png'));

    await expect(downloadGithubImage(attachmentUrl, '/project')).resolves.toEqual({ bytes: png, extension: 'png' });
    expect(mockFetch.mock.calls[0]?.[0]).toBe(attachmentUrl);
  });

  it.each([
    'https://example.com/a.png',
    'https://github.com.evil.example/user-attachments/assets/x',
    'https://evilgithubusercontent.com/x.png',
    'https://github.com/owner/repo/blob/main/a.png',
    'http://github.com/user-attachments/assets/x',
    'https://github.com@evil.example/user-attachments/assets/x',
  ])('does not request a URL outside GitHub attachments: %s', async (attachmentUrl) => {
    await expect(downloadGithubImage(attachmentUrl, '/project')).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('uses the authenticated gh credential on the first request', async () => {
    mockFetch.mockResolvedValueOnce(imageResponse(png, 'image/png'));

    await downloadGithubImage(url, '/project');

    expect(mockExecFileSync).toHaveBeenCalledWith('gh', ['auth', 'token', '--hostname', 'github.com'], expect.objectContaining({ cwd: '/project' }));
    const headers = new Headers(mockFetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toMatch(/^(?:token|Bearer) test-credential$/);
  });

  it('uses anonymous retrieval when gh has no credential for a public attachment', async () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('not authenticated'); });
    mockFetch.mockResolvedValueOnce(imageResponse(png, 'image/png'));

    await expect(downloadGithubImage(url, '/project')).resolves.toEqual({ bytes: png, extension: 'png' });
    expect(new Headers(mockFetch.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
  });

  it('follows an allowed storage redirect without forwarding the gh credential', async () => {
    const storageUrl = 'https://github-production-user-asset-6210df.s3.amazonaws.com/image?signature=test';
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: storageUrl } }));
    mockFetch.mockResolvedValueOnce(imageResponse(png, 'image/png'));

    await expect(downloadGithubImage(url, '/project')).resolves.toEqual({ bytes: png, extension: 'png' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]?.[0]).toBe(storageUrl);
    expect(new Headers(mockFetch.mock.calls[1]?.[1]?.headers).has('authorization')).toBe(false);
  });

  it.each(['https://example.com/image', 'http://user-images.githubusercontent.com/image'])('rejects an unsafe redirect before requesting it: %s', async (location) => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));

    await expect(downloadGithubImage(url, '/project')).rejects.toThrow();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('bounds repeated redirects', async () => {
    mockFetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: url } }));

    await expect(downloadGithubImage(url, '/project')).rejects.toThrow();
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it.each([
    { mime: 'text/html', bytes: Buffer.from('<html>login</html>') },
    { mime: 'image/jpeg', bytes: png },
    { mime: 'image/png', bytes: Buffer.from('not an image') },
    { mime: 'image/svg+xml', bytes: Buffer.from('<svg></svg>') },
  ])('rejects invalid image content for $mime', async ({ mime, bytes }) => {
    mockFetch.mockResolvedValueOnce(imageResponse(bytes, mime));

    await expect(downloadGithubImage(url, '/project')).rejects.toThrow();
  });

  it('rejects excessive Content-Length before consuming the response body', async () => {
    const response = imageResponse(png, 'image/png');
    response.headers.set('content-length', String(limit + 1));
    const read = vi.spyOn(response.body!, 'getReader');
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
    mockFetch.mockResolvedValueOnce(response);

    await expect(downloadGithubImage(url, '/project')).rejects.toThrow();

    expect(read).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it.each([undefined, '1'])('limits streaming bytes despite Content-Length %s', async (contentLength) => {
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(png);
        else if (pulls === 2) controller.enqueue(new Uint8Array(limit));
        else if (pulls === 3) controller.enqueue(new Uint8Array(1));
        else controller.close();
      },
      cancel,
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers: { 'content-type': 'image/png' } });
    if (contentLength !== undefined) response.headers.set('content-length', contentLength);
    mockFetch.mockResolvedValueOnce(response);

    await expect(downloadGithubImage(url, '/project')).rejects.toThrow();

    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('accepts an image at the size limit', async () => {
    const bytes = Buffer.alloc(limit);
    png.copy(bytes);
    mockFetch.mockResolvedValueOnce(imageResponse(bytes, 'image/png'));

    await expect(downloadGithubImage(url, '/project')).resolves.toEqual({ bytes, extension: 'png' });
  });

  it.each([401, 404])('reports HTTP %s as an image failure', async (status) => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status }));

    await expect(downloadGithubImage(url, '/project')).rejects.toThrow();
  });

  it('reports network errors as an image failure', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('network unavailable'));

    await expect(downloadGithubImage(url, '/project')).rejects.toThrow();
  });

  it('does not consume a non-image response body', async () => {
    const response = imageResponse(png, 'text/html');
    const read = vi.spyOn(response.body!, 'getReader');
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
    mockFetch.mockResolvedValueOnce(response);

    await expect(downloadGithubImage(url, '/project')).rejects.toThrow();

    expect(read).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

describe('isGithubImageAttachmentUrl', () => {
  it.each([
    ['https://github.com/user-attachments/assets/a', true],
    ['https://github.com/owner/repo/assets/123/a', true],
    ['https://user-images.githubusercontent.com/123/a.png', true],
    ['https://github.com/user-attachments/assets/', false],
    ['https://github.com/user-attachments/assets/a?signature=test', true],
    ['https://token@github.com/user-attachments/assets/a', false],
    ['https://github.com:8443/user-attachments/assets/a', false],
    ['https://github.com/owner/repo/blob/main/a.png', false],
  ])('classifies attachment URL %s as %s', (value, allowed) => {
    expect(isGithubImageAttachmentUrl(value)).toBe(allowed);
  });
});
