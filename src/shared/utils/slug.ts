/**
 * Text slugification utility
 *
 * Converts text into URL/filename-safe slugs.
 * Allowed characters: a-z, 0-9, hyphen. Max 30 characters.
 */

/**
 * Convert text into a slug for use in filenames, paths, and branch names.
 * Allowed: a-z 0-9 hyphen. Max 30 characters.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
}
