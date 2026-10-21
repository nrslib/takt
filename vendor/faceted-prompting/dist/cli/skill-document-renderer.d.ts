import type { ComposeDefinition } from '../types.js';
import type { SkillDocumentInput } from './skill-types.js';
export declare function renderSkillFrontmatter(definition: ComposeDefinition): string;
export declare function hasYamlFrontmatter(content: string): boolean;
export declare function renderSkillDocument(input: SkillDocumentInput): string;
