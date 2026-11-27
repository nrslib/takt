/**
 * faceted-prompting — Public API
 *
 * Re-exports all public types, interfaces, and functions.
 * Consumers should import from this module only.
 */
export type { FacetKind, FacetContent, FacetSet, ComposedPrompt, ComposedPromptPayload, ComposeDefinition, ComposeOptions, ComposeOrderEntry, CopyFiles, } from './types.js';
export { compose } from './compose.js';
export { composePromptPayload } from './prompt-payload.js';
export type { DataEngine } from './data-engine.js';
export { FileDataEngine, CompositeDataEngine } from './data-engine.js';
export { trimContextContent, renderConflictNotice, prepareKnowledgeContent, preparePolicyContent, } from './truncation.js';
export { renderTemplate } from './template.js';
export { escapeTemplateChars } from './escape.js';
export type { PieceSections } from './resolve.js';
export { isResourcePath, resolveFacetPath, resolveFacetByName, resolveResourcePath, resolveResourceContent, resolveRefToContent, resolveRefList, resolveSectionMap, extractPersonaDisplayName, resolvePersona, } from './resolve.js';
export type { ScopeRef } from './scope.js';
export { isScopeRef, parseScopeRef, resolveScopeRef, validateScopeOwner, validateScopeRepo, validateScopeFacetName, } from './scope.js';
