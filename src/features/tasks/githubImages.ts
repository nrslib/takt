import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { formatIssueAsTask, formatPrReviewAsTask } from '../../infra/git/index.js';
import type { Issue, PrReviewData } from '../../infra/git/types.js';
import { downloadGithubImage, isGithubImageAttachmentUrl } from '../../infra/github/image-download.js';
import { warn } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { ensurePrivateDirectory, writeNewPrivateFileWithMode } from '../../shared/utils/private-file.js';
import type { TaskAttachment } from './attachments.js';
import { annotateGithubImageReferences, extractGithubImageReferences, type GithubImageReference } from './githubImageReferences.js';

type GithubTaskSource = { issue: Issue } | { prReview: PrReviewData };

export interface PreparedGithubTaskImages {
  readonly task: string;
  readonly attachments: TaskAttachment[];
  cleanup(): void;
}

function formatTask(source: GithubTaskSource, transformBody: (body: string) => string): string {
  return 'issue' in source
    ? formatIssueAsTask(source.issue, transformBody)
    : formatPrReviewAsTask(source.prReview, transformBody);
}

export async function prepareGithubTaskImages(cwd: string, source: GithubTaskSource): Promise<PreparedGithubTaskImages> {
  const bodies = new Map<string, GithubImageReference[]>();
  const originalTask = formatTask(source, (body) => {
    if (!bodies.has(body)) bodies.set(body, extractGithubImageReferences(body));
    return body;
  });
  const attachments: TaskAttachment[] = [];
  const placeholders = new Map<string, string>();
  const decided = new Set<string>();
  const directory = join(cwd, '.takt', 'tmp', 'github-images', randomUUID());
  let directoryCreated = false;
  const cleanup = (): void => {
    process.off('exit', cleanup);
    if (!directoryCreated) return;
    try {
      rmSync(directory, { recursive: true, force: true });
      directoryCreated = false;
    } catch {
      warn('Failed to clean up temporary GitHub images.');
    }
  };
  process.once('exit', cleanup);
  try {
    for (const references of bodies.values()) {
      for (const reference of references) {
        if (decided.has(reference.url)) continue;
        decided.add(reference.url);
        if (!isGithubImageAttachmentUrl(reference.url)) continue;
        try {
          const image = await downloadGithubImage(reference.url, cwd);
          directoryCreated = true;
          ensurePrivateDirectory(directory);
          const number = attachments.length + 1;
          const fileName = `image-${number}.${image.extension}`;
          const tempPath = join(directory, fileName);
          writeNewPrivateFileWithMode(tempPath, image.bytes, 0o600);
          const placeholder = `[Image #${number}]`;
          attachments.push({ placeholder, fileName, tempPath });
          placeholders.set(reference.url, placeholder);
        } catch {
          // Exceptions and query strings can contain credentials or signed storage URLs.
          const url = new URL(reference.url);
          warn(`Failed to download or save GitHub image ${sanitizeTerminalText(url.origin + url.pathname)}; skipping.`);
        }
      }
    }
    const task = attachments.length === 0 ? originalTask : formatTask(source, (body) => {
      const references = bodies.get(body);
      if (references === undefined) throw new Error('GitHub task body changed during image preparation');
      return annotateGithubImageReferences(body, references, placeholders);
    });
    return { task, attachments, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
