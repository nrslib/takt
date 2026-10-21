import type { ComposeDefinition, FacetSet } from '../types.js';
import type { ResolvedDefinitionSections, SkillDocumentInput } from './skill-types.js';
export { hasYamlFrontmatter, renderSkillDocument, renderSkillFrontmatter } from './skill-document-renderer.js';
export declare function ensureSafeDefinitionName(name: string): string;
export declare function resolveDefinitionSections(params: {
    definition: ComposeDefinition;
    definitionDir: string;
    facetsRoot?: string;
    facetsRoots?: readonly string[];
    facetedRoots?: readonly string[];
}): ResolvedDefinitionSections;
export declare function listCompositionDefinitions(compositionsDirs: string | readonly string[]): Record<string, string>;
export declare function buildFacetSet(params: {
    definitionDir: string;
    facetsRoot?: string;
    facetsRoots?: readonly string[];
    facetedRoots?: readonly string[];
    definition: ComposeDefinition;
}): FacetSet;
export declare function buildFacetSetFromResolvedSections(resolved: ResolvedDefinitionSections): FacetSet;
export declare function buildSkillSections(params: {
    definition: ComposeDefinition;
    definitionDir: string;
    facetsRoot?: string;
    facetsRoots?: readonly string[];
    facetedRoots?: readonly string[];
}): Omit<SkillDocumentInput, 'mode'>;
export declare function resolveDefinitionPathFromSource(source: string, compositionsDir: string): string;
