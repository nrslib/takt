import { dirname } from 'node:path';
import type {
  FindingContractConfig,
  WorkflowCallArgValue,
  WorkflowConfig,
} from '../../../core/models/index.js';
import type { FindingManagerAuthority } from '../../../core/models/finding-types.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { validateWorkflowCallRulesAgainstChildReturns } from './workflowCallContracts.js';
import { getWorkflowSourcePath } from './workflowSourceMetadata.js';
import { getWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';
import { withWorkflowConfigErrorPath as withWorkflowStepErrorPath } from '../../../core/workflow/workflow-config-error.js';
import { findWorkflowStepLocation } from '../../../core/workflow/workflow-step-location.js';
import { annotateWorkflowConfigFragmentError } from './workflowRawParser.js';
import { collectWorkflowCallSteps } from './workflowParallelTraversal.js';
import {
  validateFindingContractSyntheticProviderModels,
  type FindingContractSyntheticProviderValidationOptions,
} from '../../../core/workflow/engine/WorkflowValidator.js';
import {
  getWorkflowCallOverrideErrorPath,
  resolveWorkflowCallChildProviderContext,
} from '../../../core/workflow/workflow-call-provider-context.js';

interface WorkflowCallValidationLookupOptions {
  basePath?: string;
  callableArgs?: Record<string, WorkflowCallArgValue>;
  lookupCwd: string;
  parentTrustInfo?: WorkflowTrustInfo;
  skipWorkflowCallContractValidation?: boolean;
}

interface ValidateWorkflowCallContractsDeps {
  isWorkflowPath: (identifier: string) => boolean;
  loadWorkflowByIdentifierForWorkflowCall: (
    identifier: string,
    projectCwd: string,
    options: WorkflowCallValidationLookupOptions,
  ) => WorkflowConfig | null;
}

interface WorkflowCallContractValidationOptions {
  allowPathBasedCalls?: boolean;
  lookupCwd?: string;
  providerValidationOptions?: FindingContractSyntheticProviderValidationOptions;
}

interface WorkflowCallContractValidationTraversal {
  active: Set<string>;
  completed: Set<string>;
}

interface FindingContractTraversalContext {
  available: boolean;
  effectiveContract?: FindingContractConfig;
  effectiveManagerAuthority: FindingManagerAuthority;
  providerValidationOptions?: FindingContractSyntheticProviderValidationOptions;
}

function getWorkflowCallInvocationIdentity(
  call: string,
  args: Record<string, WorkflowCallArgValue> | undefined,
): string {
  return canonicalJson({ call, args: args ?? {} });
}

function getProviderValidationIdentity(
  options: FindingContractSyntheticProviderValidationOptions,
): string {
  return canonicalJson(JSON.parse(JSON.stringify(options)) as unknown);
}

function getWorkflowCallValidationKey(
  workflow: WorkflowConfig,
  lookupCwd: string,
  findingContractContext: FindingContractTraversalContext,
  invocationIdentity: string,
): string {
  const sourcePath = getWorkflowSourcePath(workflow);
  const workflowKey = sourcePath ?? `${lookupCwd}:${workflow.name}`;
  return canonicalJson({
    findingContractAvailable: findingContractContext.available,
    ...(findingContractContext.effectiveContract === undefined
      ? {}
      : { effectiveContract: findingContractContext.effectiveContract }),
    effectiveManagerAuthority: findingContractContext.effectiveManagerAuthority,
    ...(findingContractContext.providerValidationOptions === undefined
      ? {}
      : {
          providerValidationIdentity: getProviderValidationIdentity(
            findingContractContext.providerValidationOptions,
          ),
        }),
    invocation: invocationIdentity,
    workflow: workflowKey,
  });
}

function validateWorkflowCallContractsRecursive(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
  traversal: WorkflowCallContractValidationTraversal,
  deps: ValidateWorkflowCallContractsDeps,
  allowPathBasedCalls: boolean,
  findingContractContext: FindingContractTraversalContext,
  invocationIdentity: string,
): void {
  const validationKey = getWorkflowCallValidationKey(
    workflow,
    lookupCwd,
    findingContractContext,
    invocationIdentity,
  );
  if (traversal.completed.has(validationKey)) {
    return;
  }
  if (traversal.active.has(validationKey)) {
    throw new Error(
      `Configuration error: recursive workflow_call cycle detected at workflow "${workflow.name}"`,
    );
  }
  traversal.active.add(validationKey);

  try {
    const parentSourcePath = getWorkflowSourcePath(workflow);
    const basePath = parentSourcePath ? dirname(parentSourcePath) : lookupCwd;
    const parentTrustInfo = getWorkflowTrustInfo(workflow, projectCwd);

    for (const step of collectWorkflowCallSteps(workflow.steps)) {
      const stepPath = findWorkflowStepLocation(workflow, step);
      if (!allowPathBasedCalls && deps.isWorkflowPath(step.call)) {
        continue;
      }

      const childWorkflow = deps.loadWorkflowByIdentifierForWorkflowCall(step.call, projectCwd, {
        basePath,
        lookupCwd,
        callableArgs: step.args,
        parentTrustInfo,
        skipWorkflowCallContractValidation: true,
      });

      if (!childWorkflow) {
        continue;
      }

      const parentProvidesFindingContract = findingContractContext.available
        || workflow.findingContract !== undefined
        || workflow.subworkflow?.requiresFindingContract === true;
      if (childWorkflow.subworkflow?.requiresFindingContract === true && !parentProvidesFindingContract) {
        const error = new Error(
          `Configuration error: workflow_call step "${step.name}" calls workflow "${childWorkflow.name}", `
          + 'which requires a finding_contract inherited from its caller, but the calling workflow does not provide one',
        );
        throw annotateWorkflowConfigFragmentError(
          stepPath ? withWorkflowStepErrorPath(error, [...stepPath, 'call']) : error,
          workflow,
        );
      }

      const childInheritedContract = findingContractContext.effectiveContract;
      const childEffectiveContract = childInheritedContract ?? childWorkflow.findingContract;
      const childManagerAuthority = childInheritedContract === undefined
        ? 'standard'
        : step.findingContractAuthority ?? 'standard';
      const parentProviderValidationOptions = findingContractContext.providerValidationOptions;
      const childProviderValidationOptions = parentProviderValidationOptions === undefined
        ? undefined
        : {
            ...resolveWorkflowCallChildProviderContext(
              childWorkflow,
              step,
              parentProviderValidationOptions,
            ),
            providerRoutingTagConflictPolicy:
              parentProviderValidationOptions.providerRoutingTagConflictPolicy,
          };
      if (childProviderValidationOptions !== undefined) {
        try {
          validateFindingContractSyntheticProviderModels(childWorkflow, {
            ...childProviderValidationOptions,
            ...(childInheritedContract === undefined
              ? {}
              : {
                  inheritedFindingContract: {
                    contract: childInheritedContract,
                    managerAuthority: childManagerAuthority,
                  },
                }),
          });
        } catch (error) {
          const overridePath = getWorkflowCallOverrideErrorPath(step, error);
          if (overridePath !== undefined && stepPath !== undefined) {
            throw annotateWorkflowConfigFragmentError(
              withWorkflowStepErrorPath(error, [...stepPath, ...overridePath]),
              workflow,
            );
          }
          throw annotateWorkflowConfigFragmentError(error, childWorkflow);
        }
      }

      validateWorkflowCallContractsRecursive(
        childWorkflow,
        projectCwd,
        lookupCwd,
        traversal,
        deps,
        allowPathBasedCalls,
        {
          available: parentProvidesFindingContract || childWorkflow.findingContract !== undefined,
          ...(childEffectiveContract === undefined ? {} : { effectiveContract: childEffectiveContract }),
          effectiveManagerAuthority: childManagerAuthority,
          providerValidationOptions: childProviderValidationOptions,
        },
        getWorkflowCallInvocationIdentity(step.call, step.args),
      );
      try {
        validateWorkflowCallRulesAgainstChildReturns(step, childWorkflow, stepPath);
      } catch (error) {
        throw annotateWorkflowConfigFragmentError(error, workflow);
      }
    }
    traversal.completed.add(validationKey);
  } finally {
    traversal.active.delete(validationKey);
  }
}

export function validateWorkflowCallContracts(
  workflow: WorkflowConfig,
  projectCwd: string,
  deps: ValidateWorkflowCallContractsDeps,
  options?: WorkflowCallContractValidationOptions,
): void {
  validateWorkflowCallContractsRecursive(
    workflow,
    projectCwd,
    options?.lookupCwd ?? projectCwd,
    { active: new Set<string>(), completed: new Set<string>() },
    deps,
    options?.allowPathBasedCalls !== false,
    {
      available: workflow.findingContract !== undefined,
      ...(workflow.findingContract === undefined
        ? {}
        : { effectiveContract: workflow.findingContract }),
      effectiveManagerAuthority: 'standard',
      providerValidationOptions: options?.providerValidationOptions,
    },
    canonicalJson({ root: true }),
  );
}
