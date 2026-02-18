/**
 * Report directory name generation.
 */

import { slugify } from './slug.js';

export function generateReportDir(task: string): string {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)
    .replace(/(\d{8})(\d{6})/, '$1-$2');

  const summary = slugify(task.slice(0, 80)) || 'task';

  return `${timestamp}-${summary}`;
}
