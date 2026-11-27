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
export declare function trimContextContent(content: string, maxChars: number): PreparedContextBlock;
/**
 * Standard notice appended to knowledge and policy blocks.
 */
export declare function renderConflictNotice(): string;
/**
 * Prepare a knowledge facet for inclusion in a prompt.
 *
 * Trims to maxChars, appends truncation notice and source path if available.
 */
export declare function prepareKnowledgeContent(content: string, maxChars: number, sourcePath?: string): string;
/**
 * Prepare a policy facet for inclusion in a prompt.
 *
 * Trims to maxChars, appends authoritative-source notice and source path if available.
 */
export declare function preparePolicyContent(content: string, maxChars: number, sourcePath?: string): string;
export {};
