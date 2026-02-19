/**
 * Minimal template engine for Markdown prompt templates.
 *
 * Supports:
 * - {{#if variable}}...{{else}}...{{/if}} conditional blocks (no nesting)
 * - {{variableName}} substitution
 *
 * This module has ZERO dependencies on TAKT internals.
 */

/**
 * Process {{#if variable}}...{{else}}...{{/if}} conditional blocks.
 *
 * A variable is truthy when it is a non-empty string or boolean true.
 * Nesting is NOT supported.
 */
export function processConditionals(
  template: string,
  vars: Record<string, string | boolean>,
): string {
  return template.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, varName: string, body: string): string => {
      const value = vars[varName];
      const isTruthy = value !== undefined && value !== false && value !== '';

      const elseIndex = body.indexOf('{{else}}');
      if (isTruthy) {
        return elseIndex >= 0 ? body.slice(0, elseIndex) : body;
      }
      return elseIndex >= 0 ? body.slice(elseIndex + '{{else}}'.length) : '';
    },
  );
}

/**
 * Replace {{variableName}} placeholders with values from vars.
 * Undefined or false variables are replaced with empty string.
 * True is replaced with the string "true".
 */
export function substituteVariables(
  template: string,
  vars: Record<string, string | boolean>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_match, varName: string) => {
      const value = vars[varName];
      if (value === undefined || value === false) return '';
      if (value === true) return 'true';
      return value;
    },
  );
}

/**
 * Render a template string by processing conditionals then substituting variables.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | boolean>,
): string {
  const afterConditionals = processConditionals(template, vars);
  return substituteVariables(afterConditionals, vars);
}
