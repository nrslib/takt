/**
 * Slug Generator - URL-friendly slug generator
 * 
 * Converts strings into URL-safe slugs for SEO-friendly URLs.
 * Features Unicode support, customizable options, and zero dependencies.
 */

/**
 * Options for slug generation
 */
export interface SlugOptions {
  /** Replacement character for spaces and separators (default: '-') */
  replacement?: string;
  /** Convert to lowercase (default: true) */
  lower?: boolean;
  /** Maximum length of the slug (default: no limit) */
  maxLength?: number;
  /** Custom character substitutions */
  customSubstitutions?: Record<string, string>;
  /** Remove characters outside basic Latin and numbers (default: true) */
  strict?: boolean;
  /** Trim leading and trailing whitespace/replacements (default: true) */
  trim?: boolean;
}

/**
 * Default character mappings for Unicode transliteration
 */
const DEFAULT_CHAR_MAP: Record<string, string> = {
  // Latin Extended-A
  'À': 'A', 'Á': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'Ae', 'Å': 'A', 'Æ': 'AE',
  'Ç': 'C', 'È': 'E', 'É': 'E', 'Ê': 'E', 'Ë': 'E', 'Ì': 'I', 'Í': 'I',
  'Î': 'I', 'Ï': 'I', 'Ð': 'D', 'Ñ': 'N', 'Ò': 'O', 'Ó': 'O', 'Ô': 'O',
  'Õ': 'O', 'Ö': 'Oe', 'Ø': 'O', 'Ù': 'U', 'Ú': 'U', 'Û': 'U', 'Ü': 'Ue',
  'Ý': 'Y', 'Þ': 'Th', 'ß': 'ss', 'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a',
  'ä': 'ae', 'å': 'a', 'æ': 'ae', 'ç': 'c', 'è': 'e', 'é': 'e', 'ê': 'e',
  'ë': 'e', 'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i', 'ð': 'd', 'ñ': 'n',
  'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'oe', 'ø': 'o', 'ù': 'u',
  'ú': 'u', 'û': 'u', 'ü': 'ue', 'ý': 'y', 'þ': 'th', 'ÿ': 'y',
  
  // Common symbols and punctuation
  '&': 'and', '@': 'at', '#': 'hash', '$': 'dollar', '%': 'percent',
  '*': 'star', '+': 'plus', '=': 'equals', '/': 'or', '\\': 'backslash',
  '|': 'pipe', '<': 'less', '>': 'greater', '"': 'quote', "'": 'quote',
  '(': 'open-paren', ')': 'close-paren', '[': 'open-bracket', ']': 'close-bracket',
  '{': 'open-brace', '}': 'close-brace', '?': 'question', '!': 'exclamation',
  '.': 'dot', ',': 'comma', ':': 'colon', ';': 'semicolon', '~': 'tilde',
  '^': 'caret', '`': 'backtick'
};

/**
 * Default options
 */
const DEFAULT_OPTIONS: Required<SlugOptions> = {
  replacement: '-',
  lower: true,
  maxLength: Infinity,
  customSubstitutions: {},
  strict: true,
  trim: true
};

/**
 * Generate URL-friendly slug from input string
 * 
 * @param input - String to convert to slug
 * @param options - Configuration options
 * @returns URL-friendly slug string
 * 
 * @example
 * ```typescript
 * slug('Hello World!') // 'hello-world'
 * slug('Café & Restaurant') // 'cafe-and-restaurant'
 * slug('Привет мир', { replacement: '_' }) // 'privet_mir'
 * ```
 */
export function slug(input: string, options: SlugOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  let result = input;

  // Apply character mappings (including custom ones)
  const charMap = { ...DEFAULT_CHAR_MAP, ...opts.customSubstitutions };
  result = result
    .normalize('NFD') // Split accented characters
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .split('')
    .map(char => charMap[char] || char)
    .join('');

  // Convert to lowercase if requested
  if (opts.lower) {
    result = result.toLowerCase();
  }

  // In strict mode, keep only alphanumeric, spaces, and replacement character
  if (opts.strict) {
    const allowedPattern = `[^a-z0-9\\s${opts.replacement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`;
    result = result.replace(new RegExp(allowedPattern, 'gi'), '');
  }

  // Replace spaces and multiple separators with single separator
  const separatorPattern = `[\\s${opts.replacement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+`;
  result = result.replace(new RegExp(separatorPattern, 'g'), opts.replacement);

  // Trim leading/trailing separators if requested
  if (opts.trim) {
    const trimPattern = `^${opts.replacement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}+|${opts.replacement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}+$`;
    result = result.replace(new RegExp(trimPattern, 'g'), '');
  }

  // Apply maximum length limit
  if (opts.maxLength && opts.maxLength > 0 && result.length > opts.maxLength) {
    result = result.substring(0, opts.maxLength);
  }

  // Handle edge case: empty result or zero maxLength
  if (!result || opts.maxLength === 0) {
    result = opts.replacement.repeat(2);
  }

  return result;
}

/**
 * Generate unique slug by appending numeric suffix if needed
 * 
 * @param input - String to convert to slug
 * @param isUnique - Function to check if slug is unique
 * @param options - Configuration options
 * @returns Unique slug string
 * 
 * @example
 * ```typescript
 * const existingSlugs = ['hello-world', 'hello-world-2'];
 * const uniqueSlug = await uniqueSlug('Hello World', 
 *   (s) => !existingSlugs.includes(s)
 * ); // 'hello-world-3'
 * ```
 */
export async function uniqueSlug(
  input: string, 
  isUnique: (slug: string) => Promise<boolean> | boolean,
  options: SlugOptions = {}
): Promise<string> {
  const baseSlug = slug(input, options);
  
  if (await isUnique(baseSlug)) {
    return baseSlug;
  }

  let counter = 2;
  while (counter <= 9999) {
    const candidateSlug = `${baseSlug}${options.replacement || '-'}${counter}`;
    if (await isUnique(candidateSlug)) {
      return candidateSlug;
    }
    counter++;
  }

  // Fallback: append timestamp
  const timestamp = Date.now();
  return `${baseSlug}${options.replacement || '-'}${timestamp}`;
}

/**
 * Check if a string is a valid slug format
 * 
 * @param candidate - String to validate
 * @param options - Configuration options to validate against
 * @returns True if string matches slug format
 * 
 * @example
 * ```typescript
 * isValidSlug('hello-world') // true
 * isValidSlug('Hello World') // false
 * isValidSlug('hello_world', { replacement: '_' }) // true
 * ```
 */
export function isValidSlug(candidate: string, options: SlugOptions = {}): boolean {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  if (!candidate || candidate.length === 0) {
    return false;
  }

  // Create validation regex based on options
  let allowedChars = `a-z0-9${opts.replacement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  if (!opts.lower) {
    allowedChars += 'A-Z'; // Include uppercase if not forcing lowercase
  }
  const validationRegex = new RegExp(`^[${allowedChars}]+$`);
  
  const testString = opts.lower ? candidate.toLowerCase() : candidate;
  
  const basicValidation = validationRegex.test(testString);
  const trimValidation = !opts.trim || (candidate[0] !== opts.replacement && candidate[candidate.length - 1] !== opts.replacement);
  
  return basicValidation && trimValidation;
}

// Export default function
export default slug;