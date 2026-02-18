/**
 * Context truncation for knowledge and policy facets.
 *
 * When facet content exceeds a character limit, it is trimmed and
 * annotated with source-path metadata so the LLM can consult the
 * original file.
 *
 * This module has ZERO dependencies on TAKT internals.
 */

interface PreparedContextBlock {
  readonly content: string;
  readonly truncated: boolean;
}

/**
 * Trim content to a maximum character length, appending a
 * "...TRUNCATED..." marker when truncation occurs.
 */
export function trimContextContent(
  content: string,
  maxChars: number,
): PreparedContextBlock {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }
  return {
    content: `${content.slice(0, maxChars)}\n...TRUNCATED...`,
    truncated: true,
  };
}

/**
 * Standard notice appended to knowledge and policy blocks.
 */
export function renderConflictNotice(): string {
  return 'If prompt content conflicts with source files, source files take precedence.';
}

/**
 * Prepare a knowledge facet for inclusion in a prompt.
 *
 * Trims to maxChars, appends truncation notice and source path if available.
 */
export function prepareKnowledgeContent(
  content: string,
  maxChars: number,
  sourcePath?: string,
): string {
  const prepared = trimContextContent(content, maxChars);
  const lines: string[] = [prepared.content];
  if (prepared.truncated && sourcePath) {
    lines.push(
      '',
      `Knowledge is truncated. You MUST consult the source files before making decisions. Source: ${sourcePath}`,
    );
  }
  if (sourcePath) {
    lines.push('', `Knowledge Source: ${sourcePath}`);
  }
  lines.push('', renderConflictNotice());
  return lines.join('\n');
}

/**
 * Prepare a policy facet for inclusion in a prompt.
 *
 * Trims to maxChars, appends authoritative-source notice and source path if available.
 */
export function preparePolicyContent(
  content: string,
  maxChars: number,
  sourcePath?: string,
): string {
  const prepared = trimContextContent(content, maxChars);
  const lines: string[] = [prepared.content];
  if (prepared.truncated && sourcePath) {
    lines.push(
      '',
      `Policy is authoritative. If truncated, you MUST read the full policy file and follow it strictly. Source: ${sourcePath}`,
    );
  }
  if (sourcePath) {
    lines.push('', `Policy Source: ${sourcePath}`);
  }
  lines.push('', renderConflictNotice());
  return lines.join('\n');
}
