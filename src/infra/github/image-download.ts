import { execFileSync } from 'node:child_process';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const IMAGE_HOSTS = new Set(['user-images.githubusercontent.com', 'private-user-images.githubusercontent.com']);

export interface DownloadedGithubImage {
  readonly bytes: Buffer;
  readonly extension: 'png' | 'jpg' | 'gif' | 'webp';
}

function safeHttpsUrl(value: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : undefined;
}

export function isGithubImageAttachmentUrl(value: string): boolean {
  const url = safeHttpsUrl(value);
  if (!url) return false;
  if (IMAGE_HOSTS.has(url.hostname)) return url.pathname !== '/';
  return url.hostname === 'github.com'
    && (/^\/user-attachments\/assets\/[^/]+(?:\/[^/]+)*$/.test(url.pathname)
      || /^\/[^/]+\/[^/]+\/assets\/[^/]+\/[^/]+(?:\/[^/]+)*$/.test(url.pathname));
}

function isAllowedRedirectUrl(value: string): boolean {
  const url = safeHttpsUrl(value);
  if (!url) return false;
  return isGithubImageAttachmentUrl(value)
    || /^github-production-(?:user-asset|repository-file|release-asset)-[a-z\d]+\.s3(?:[.-][a-z\d-]+)?\.amazonaws\.com$/.test(url.hostname)
    || url.hostname === 'github-cloud.s3.amazonaws.com';
}

function readGhCredential(cwd: string): string | undefined {
  try {
    const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    // Public attachments can be fetched anonymously when gh has no usable credential.
    return undefined;
  }
}

function imageExtension(contentType: string): DownloadedGithubImage['extension'] {
  switch (contentType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    default: throw new Error('Unsupported GitHub image Content-Type');
  }
}

function hasImageSignature(bytes: Buffer, extension: DownloadedGithubImage['extension']): boolean {
  switch (extension) {
    case 'png': return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    case 'jpg': return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'gif': return bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a';
    case 'webp': return bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
}

async function readBoundedImage(response: Response): Promise<DownloadedGithubImage> {
  let extension: DownloadedGithubImage['extension'];
  try {
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    extension = imageExtension(mime ?? '');
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_IMAGE_BYTES) {
      throw new Error('GitHub image exceeds the 10 MiB size limit');
    }
  } catch (error) {
    await response.body?.cancel();
    throw error;
  }
  if (!response.body) throw new Error('GitHub image response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error('GitHub image exceeds the 10 MiB size limit');
      chunks.push(value);
    }
  } finally {
    try {
      if (!complete) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = Buffer.concat(chunks, size);
  if (!hasImageSignature(bytes, extension)) throw new Error('GitHub image Content-Type and magic bytes do not match');
  return { bytes, extension };
}

export async function downloadGithubImage(url: string, cwd: string): Promise<DownloadedGithubImage> {
  if (!isGithubImageAttachmentUrl(url)) throw new Error('URL is not a GitHub image attachment');
  const originalOrigin = new URL(url).origin;
  const credential = readGhCredential(cwd);
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let currentUrl = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const headers: Record<string, string> = { Accept: 'image/png, image/jpeg, image/gif, image/webp' };
    if (credential !== undefined && new URL(currentUrl).origin === originalOrigin) {
      headers.Authorization = `token ${credential}`;
    }
    let response: Response;
    try {
      response = await fetch(currentUrl, { headers, redirect: 'manual', signal });
    } catch {
      throw new Error('GitHub image request failed');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (location === null) throw new Error('GitHub image redirect has no location');
      let destination: string;
      try {
        destination = new URL(location, currentUrl).href;
      } catch {
        throw new Error('GitHub image redirect has an invalid location');
      }
      if (!isAllowedRedirectUrl(destination)) throw new Error('GitHub image redirect destination is not allowed');
      currentUrl = destination;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub image request returned HTTP ${response.status}`);
    }
    return readBoundedImage(response);
  }
  throw new Error('GitHub image has too many redirects');
}
