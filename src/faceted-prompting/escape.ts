/**
 * Template injection prevention.
 *
 * Escapes curly braces in dynamic content so they are not
 * interpreted as template variables by the template engine.
 *
 * This module has ZERO dependencies on TAKT internals.
 */

/**
 * Replace ASCII curly braces with full-width equivalents
 * to prevent template variable injection in user-supplied content.
 */
export function escapeTemplateChars(str: string): string {
  return str.replace(/\{/g, '\uff5b').replace(/\}/g, '\uff5d');
}
