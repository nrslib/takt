import { basename, join } from 'node:path';

function imagePathPattern(directory: string): RegExp {
  const prefix = directory.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp('(^|[\\s`\'"(\\[<:=])(' + prefix
    + '[/\\\\]image-[1-9]\\d*\\.(?:png|jpg|gif|webp))(?=$|[\\s`\'"\\)\\]>;,!?]|[.:](?=\\s|$))', 'gu');
}

export function selectWorkflowImagePaths(text: string, directory: string): string[] {
  return [...new Set([...text.matchAll(imagePathPattern(directory))].map((match) => match[2]!))];
}

export function normalizeWorkflowImagePaths(text: string, images: readonly { path: string; fileName: string }[]): string {
  let normalized = text;
  for (const image of images) {
    normalized = normalized.replace(imagePathPattern(image.path.slice(0, -basename(image.path).length - 1)), (match, prefix: string, path: string) => {
      if (path !== image.path) return match;
      const reference = join('attachments', image.fileName).replace(/\\/gu, '/');
      return prefix + (prefix.endsWith('`') ? reference : `\`${reference}\``);
    });
  }
  return normalized;
}
