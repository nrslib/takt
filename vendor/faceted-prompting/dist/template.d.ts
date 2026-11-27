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
export declare function processConditionals(template: string, vars: Record<string, string | boolean>): string;
/**
 * Replace {{variableName}} placeholders with values from vars.
 * Undefined or false variables are replaced with empty string.
 * True is replaced with the string "true".
 */
export declare function substituteVariables(template: string, vars: Record<string, string | boolean>): string;
/**
 * Render a template string by processing conditionals then substituting variables.
 */
export declare function renderTemplate(template: string, vars: Record<string, string | boolean>): string;
