import { WorkflowConfigRawSchema } from '../../../core/models/index.js';

export type RawWorkflow = ReturnType<typeof WorkflowConfigRawSchema.parse>;

export type BuilderScopeKind = 'project' | 'global' | 'builtins';
export type BuilderTargetMode = 'create' | 'modify' | 'unspecified';

export interface BuilderScopeRoot {
  lang?: 'en' | 'ja';
  rootDir: string;
}

export interface ResolvedBuilderScope {
  kind: BuilderScopeKind;
  projectDir: string;
  roots: BuilderScopeRoot[];
  writeMode: 'single-language' | 'dual-language';
}

export interface BuilderWorkflowChoice {
  name: string;
  path: string;
  lang?: 'en' | 'ja';
}

export type BuilderTarget =
  | { mode: 'create' }
  | { mode: 'modify'; workflowPath: string }
  | { mode: 'unspecified' };

export interface BuilderPromptContext {
  scopeSummary: string;
  assetInventory: string;
  targetContext: string;
  relatedGraph: string;
}

export interface RelatedWorkflowCandidate {
  relation: 'shared_facet' | 'workflow_call_child' | 'workflow_call_parent' | 'similar_name';
  workflowPath: string;
  reason: string;
}

export interface FileSnapshot {
  content: Buffer;
}

export interface FileChange {
  filePath: string;
  before?: FileSnapshot;
  after?: FileSnapshot;
}

export interface BuilderFileChangeSummary {
  filePath: string;
  deleted: boolean;
  created?: boolean;
  content?: string;
}

export interface BuilderFileRollbackChange {
  filePath: string;
  beforeContent?: Buffer;
}

export interface BuilderManifestChange {
  path: string;
  content: string;
}

export interface BuilderChangeManifest {
  summary: string;
  changes: BuilderManifestChange[];
}

export interface BuilderChangeApproval {
  target: BuilderTarget;
  targetFacetPaths: string[];
  approvedWorkflowPaths: string[];
  approvedWorkflowFacetPaths: string[];
  approvedFacetPaths: string[];
}
