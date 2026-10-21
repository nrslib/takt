/**
 * faceted-prompting — Public API
 *
 * Re-exports all public types, interfaces, and functions.
 * Consumers should import from this module only.
 */
// Compose
export { compose } from './compose.js';
export { composePromptPayload } from './prompt-payload.js';
export { FileDataEngine, CompositeDataEngine } from './data-engine.js';
// Truncation
export { trimContextContent, renderConflictNotice, prepareKnowledgeContent, preparePolicyContent, } from './truncation.js';
// Template engine
export { renderTemplate } from './template.js';
// Escape
export { escapeTemplateChars } from './escape.js';
export { isResourcePath, resolveFacetPath, resolveFacetByName, resolveResourcePath, resolveResourceContent, resolveRefToContent, resolveRefList, resolveSectionMap, extractPersonaDisplayName, resolvePersona, } from './resolve.js';
export { isScopeRef, parseScopeRef, resolveScopeRef, validateScopeOwner, validateScopeRepo, validateScopeFacetName, } from './scope.js';
