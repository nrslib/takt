import type { ComposeDefinition } from '../types.js';
export type SkillMode = 'inline' | 'reference';
export interface FacetRefContent {
    readonly body: string;
    readonly path: string;
}
export interface SkillSection {
    readonly ref: string;
    readonly body: string;
    readonly path: string;
    readonly sourcePaths?: readonly string[];
}
export interface FileInstructionSection extends SkillSection {
    readonly sourcePaths: readonly string[];
}
export type InstructionSection = FileInstructionSection | {
    readonly ref: 'literal';
    readonly body: string;
};
export interface SkillDocumentInput {
    readonly definition: ComposeDefinition;
    readonly mode: SkillMode;
    readonly persona: SkillSection;
    readonly policies: readonly SkillSection[];
    readonly knowledge: readonly SkillSection[];
    readonly instructions: readonly InstructionSection[];
    readonly outputContracts: readonly SkillSection[];
}
export interface ResolvedDefinitionSections {
    readonly persona: SkillSection;
    readonly policies: readonly SkillSection[];
    readonly knowledge: readonly SkillSection[];
    readonly instructions: readonly InstructionSection[];
    readonly outputContracts: readonly SkillSection[];
}
