/**
 * Text slugification utility
 *
 * Converts text into URL/filename-safe slugs.
 * Supports ASCII alphanumerics and CJK characters.
 */

/**
 * Convert text into a slug for use in filenames, paths, and branch names.
 * Preserves CJK characters (U+3000-9FFF, FF00-FFEF).
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u3000-\u9fff\uff00-\uffef]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}
