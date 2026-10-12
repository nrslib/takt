type PermissionBehavior = 'allow' | 'deny' | 'ask';
type PermissionDecisionClassification = 'user_temporary' | 'user_permanent' | 'user_reject';
type PermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
type PermissionRuleValue = { toolName: string; ruleContent?: string };

export type PermissionResult = {
  behavior: 'allow';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: PermissionUpdate[];
  toolUseID?: string;
  decisionClassification?: PermissionDecisionClassification;
} | {
  behavior: 'deny';
  message: string;
  interrupt?: boolean;
  toolUseID?: string;
  decisionClassification?: PermissionDecisionClassification;
};

export type PermissionUpdate = {
  type: 'addRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination;
} | {
  type: 'replaceRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination;
} | {
  type: 'removeRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination;
} | {
  type: 'setMode'; mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'; destination: PermissionUpdateDestination;
} | {
  type: 'addDirectories'; directories: string[]; destination: PermissionUpdateDestination;
} | {
  type: 'removeDirectories'; directories: string[]; destination: PermissionUpdateDestination;
};
