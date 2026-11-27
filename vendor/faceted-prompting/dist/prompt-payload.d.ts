import type { ComposeDefinition, ComposedPromptPayload, ComposeOptions } from './types.js';
export declare function composePromptPayload(params: {
    definition: ComposeDefinition;
    definitionDir: string;
    facetsRoot?: string;
    facetsRoots?: readonly string[];
    facetedRoots?: readonly string[];
    composeOptions: ComposeOptions;
}): ComposedPromptPayload;
