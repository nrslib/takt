/**
 * Tests for slug-generator module
 */

import { describe, it, expect } from 'vitest';
import { slug, uniqueSlug, isValidSlug, type SlugOptions } from '../slug-generator.js';

describe('slug', () => {
  describe('basic functionality', () => {
    it('should convert simple string to slug', () => {
      expect(slug('Hello World')).toBe('hello-world');
    });

    it('should handle empty string', () => {
      expect(slug('')).toBe('--');
    });

    it('should handle single word', () => {
      expect(slug('hello')).toBe('hello');
    });

    it('should handle numbers', () => {
      expect(slug('Test 123')).toBe('test-123');
    });
  });

  describe('case conversion', () => {
    it('should convert to lowercase by default', () => {
      expect(slug('HELLO WORLD')).toBe('hello-world');
    });

    it('should preserve case when lower option is false', () => {
      expect(slug('Hello World', { lower: false })).toBe('Hello-World');
    });
  });

  describe('Unicode and special characters', () => {
    it('should handle accented characters', () => {
      expect(slug('Café Restaurant')).toBe('cafe-restaurant');
      expect(slug('naïve résumé')).toBe('naive-resume');
    });

    it('should handle German umlauts', () => {
      expect(slug('Müller & Söhne')).toBe('mueller-und-soehne');
    });

    it('should replace special symbols', () => {
      expect(slug('Hello & World')).toBe('hello-and-world');
      expect(slug('Email@domain.com')).toBe('email-at-domain-com');
      expect(slug('Price: $100')).toBe('price-dollar-100');
    });

    it('should handle parentheses and brackets', () => {
      expect(slug('Test (item)')).toBe('test-open-paren-close-paren');
      expect(slug('Array[index]')).toBe('array-open-bracket-close-bracket');
    });
  });

  describe('custom replacement character', () => {
    it('should use custom replacement', () => {
      expect(slug('Hello World', { replacement: '_' })).toBe('hello_world');
      expect(slug('Hello World', { replacement: '+' })).toBe('hello+world');
    });

    it('should handle multiple separators', () => {
      expect(slug('Hello   World', { replacement: '_' })).toBe('hello_world');
      expect(slug('Hello-World_Test', { replacement: '_' })).toBe('hello-world-test');
    });
  });

  describe('custom substitutions', () => {
    it('should apply custom character mappings', () => {
      const customMap = { '&': 'et', '@': 'chez' };
      expect(slug('Hello & World', { customSubstitutions: customMap })).toBe('hello-et-world');
      expect(slug('Email@domain', { customSubstitutions: customMap })).toBe('email-chezdomain');
    });
  });

  describe('length limiting', () => {
    it('should limit slug length', () => {
      expect(slug('This is a very long string', { maxLength: 10 })).toBe('this-is-a');
      expect(slug('Short', { maxLength: 2 })).toBe('sh');
    });

    it('should handle zero maxLength', () => {
      expect(slug('Hello', { maxLength: 0 })).toBe('--');
    });
  });

  describe('trim behavior', () => {
    it('should trim leading and trailing separators by default', () => {
      expect(slug('-Hello World-')).toBe('hello-world');
      expect(slug('__Hello__World__', { replacement: '_' })).toBe('hello_world');
    });

    it('should preserve separators when trim is false', () => {
      expect(slug('-Hello World-', { trim: false })).toBe('-hello-world-');
    });
  });

  describe('strict mode', () => {
    it('should remove non-alphanumeric characters in strict mode', () => {
      expect(slug('Hello*World#Test', { strict: true })).toBe('hello-world-test');
    });

    it('should preserve more characters when strict is false', () => {
      expect(slug('Hello*World#Test', { strict: false })).toBe('hello*world#test');
    });
  });

  describe('complex combinations', () => {
    it('should handle multiple Unicode characters and symbols', () => {
      expect(slug('Søren & Åse\'s Café @ Nordstrøm')).toBe('soren-und-ases-cafe-at-nordstrom');
    });

    it('should handle mixed content with custom options', () => {
      const options: SlugOptions = {
        replacement: '_',
        lower: false,
        maxLength: 20,
        customSubstitutions: { '&': 'and' },
        strict: true
      };
      expect(slug('Müller & Company GmbH', options)).toBe('Mueller_and_Compan');
    });
  });

  describe('edge cases', () => {
    it('should handle only special characters', () => {
      expect(slug('***!!!')).toBe('--');
    });

    it('should handle consecutive separators', () => {
      expect(slug('Hello---World')).toBe('hello-world');
      expect(slug('Hello___World', { replacement: '_' })).toBe('hello_world');
    });

    it('should handle mixed separator characters', () => {
      expect(slug('Hello-World_Test.space', { replacement: '-' })).toBe('hello-world-test-space');
    });
  });
});

describe('uniqueSlug', () => {
  describe('basic functionality', () => {
    it('should return original slug if unique', async () => {
      const isUnique = async (s: string) => s === 'hello-world';
      const result = await uniqueSlug('Hello World', isUnique);
      expect(result).toBe('hello-world');
    });

    it('should append number if not unique', async () => {
      const existingSlugs = ['hello-world'];
      const isUnique = async (s: string) => !existingSlugs.includes(s);
      const result = await uniqueSlug('Hello World', isUnique);
      expect(result).toBe('hello-world-2');
    });

    it('should increment number until unique', async () => {
      const existingSlugs = ['hello-world', 'hello-world-2', 'hello-world-3'];
      const isUnique = async (s: string) => !existingSlugs.includes(s);
      const result = await uniqueSlug('Hello World', isUnique);
      expect(result).toBe('hello-world-4');
    });
  });

  describe('synchronous uniqueness check', () => {
    it('should work with synchronous uniqueness function', async () => {
      const existingSlugs = ['test-slug'];
      const isUnique = (s: string) => !existingSlugs.includes(s);
      const result = await uniqueSlug('Test Slug', isUnique);
      expect(result).toBe('test-slug-2');
    });
  });

  describe('custom options', () => {
    it('should use custom replacement in unique slug', async () => {
      const existingSlugs = ['hello_world'];
      const isUnique = async (s: string) => !existingSlugs.includes(s);
      const result = await uniqueSlug('Hello World', isUnique, { replacement: '_' });
      expect(result).toBe('hello_world_2');
    });
  });

  describe('edge cases', () => {
    it('should fallback to timestamp after many attempts', async () => {
      const isUnique = async () => false; // Always returns false
      const result = await uniqueSlug('Test', isUnique);
      expect(result).toMatch(/^test-\d+$/);
    });
  });
});

describe('isValidSlug', () => {
  describe('validation with default options', () => {
    it('should validate correct slugs', () => {
      expect(isValidSlug('hello-world')).toBe(true);
      expect(isValidSlug('test123')).toBe(true);
      expect(isValidSlug('a')).toBe(true);
    });

    it('should reject invalid slugs', () => {
      expect(isValidSlug('Hello World')).toBe(false); // Contains spaces
      expect(isValidSlug('hello_world')).toBe(false); // Contains underscore
      expect(isValidSlug('hello*world')).toBe(false); // Contains asterisk
      expect(isValidSlug('')).toBe(false); // Empty string
    });
  });

  describe('validation with custom options', () => {
    it('should validate with custom replacement', () => {
      expect(isValidSlug('hello_world', { replacement: '_' })).toBe(true);
      expect(isValidSlug('hello-world', { replacement: '_' })).toBe(false);
    });

    it('should validate with case preservation', () => {
      expect(isValidSlug('Hello-World', { lower: false })).toBe(true);
      expect(isValidSlug('Hello-World', { lower: true })).toBe(false);
    });
  });

  describe('trim validation', () => {
    it('should reject slugs with leading/trailing separators when trim is true', () => {
      expect(isValidSlug('-hello-world', { trim: true })).toBe(false);
      expect(isValidSlug('hello-world-', { trim: true })).toBe(false);
    });

    it('should accept slugs with leading/trailing separators when trim is false', () => {
      expect(isValidSlug('-hello-world', { trim: false })).toBe(true);
      expect(isValidSlug('hello-world-', { trim: false })).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', () => {
      expect(isValidSlug('')).toBe(false);
    });

    it('should handle only separators', () => {
      expect(isValidSlug('--')).toBe(true); // technically valid pattern
      expect(isValidSlug('__', { replacement: '_' })).toBe(true);
    });
  });
});

describe('integration tests', () => {
  describe('real-world scenarios', () => {
    it('should handle blog post titles', () => {
      expect(slug('My First Blog Post!')).toBe('my-first-blog-post');
      expect(slug('How to Code in TypeScript: A Beginner\'s Guide')).toBe('how-to-code-in-typescript-a-beginners-guide');
    });

    it('should handle product names', () => {
      expect(slug('iPhone 15 Pro Max (256GB)')).toBe('iphone-15-pro-max-open-paren-256gb-close-paren');
      expect(slug('Samsung Galaxy S24 Ultra - 5G')).toBe('samsung-galaxy-s24-ultra-5g');
    });

    it('should handle foreign language content', () => {
      expect(slug('¡Hola! ¿Cómo estás?')).toBe('hola-como-estas');
      expect(slug('Привет, мир!')).toBe('privet-mir');
      expect(slug('こんにちは世界')).toBe('konnnitiha-sekai');
    });

    it('should handle technical content', () => {
      expect(slug('React.js vs Vue.js: Which is Better in 2024?')).toBe('react-dot-js-vs-vue-dot-js-which-is-better-in-2024');
      expect(slug('Node.js + Express + MongoDB = MEAN Stack')).toBe('node-dot-js-plus-express-plus-mongodb-equals-mean-stack');
    });
  });

  describe('performance considerations', () => {
    it('should handle very long strings efficiently', () => {
      const longString = 'This is a very long string that goes on and on '.repeat(100);
      const result = slug(longString, { maxLength: 50 });
      expect(result.length).toBeLessThanOrEqual(50);
      expect(result).toBe('this-is-a-very-long-string-that-goes-on-and');
    });
  });
});