import { dirname, relative } from 'node:path';

type WorkflowScaffoldFile = {
  path: string;
  content: string;
};

type WorkflowScaffoldBaseOptions = {
  description?: string;
  name: string;
  stepCount: number;
  workflowPath: string;
};

type MinimalWorkflowScaffoldOptions = WorkflowScaffoldBaseOptions & {
  template: 'minimal';
};

type FacetedWorkflowScaffoldOptions = WorkflowScaffoldBaseOptions & {
  instructionDir: string;
  personaDir: string;
  template: 'faceted';
};

type WorkflowScaffoldOptions = MinimalWorkflowScaffoldOptions | FacetedWorkflowScaffoldOptions;

function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function relativeYamlPath(fromPath: string, toPath: string): string {
  return toPosixPath(relative(dirname(fromPath), toPath));
}

function buildWorkflowHeader(name: string, description: string | undefined, stepCount: number): string[] {
  const lines = [`name: ${name}`];
  if (description) {
    lines.push(`description: ${JSON.stringify(description)}`);
  }
  lines.push(`max_steps: ${Math.max(stepCount, 10)}`);
  lines.push('initial_step: step1');
  return lines;
}

function buildMinimalSteps(stepCount: number): string[] {
  const lines = ['steps:'];
  for (let index = 1; index <= stepCount; index++) {
    const stepName = `step${index}`;
    const next = index === stepCount ? 'COMPLETE' : `step${index + 1}`;
    lines.push(`  - name: ${stepName}`);
    lines.push('    rules:');
    lines.push('      - condition: Step complete');
    lines.push(`        next: ${next}`);
  }
  return lines;
}

function buildFacetedWorkflow(
  workflowPath: string,
  personaDir: string,
  instructionDir: string,
  stepCount: number,
): string[] {
  const lines = ['personas:'];
  lines.push(`  default: ${relativeYamlPath(workflowPath, `${personaDir}/default.md`)}`);
  lines.push('instructions:');
  for (let index = 1; index <= stepCount; index++) {
    const stepName = `step${index}`;
    lines.push(`  ${stepName}: ${relativeYamlPath(workflowPath, `${instructionDir}/${stepName}.md`)}`);
  }
  lines.push('steps:');
  for (let index = 1; index <= stepCount; index++) {
    const stepName = `step${index}`;
    const next = index === stepCount ? 'COMPLETE' : `step${index + 1}`;
    lines.push(`  - name: ${stepName}`);
    lines.push('    persona: default');
    lines.push(`    instruction: ${stepName}`);
    lines.push('    rules:');
    lines.push('      - condition: Step complete');
    lines.push(`        next: ${next}`);
  }
  return lines;
}

function buildPersonaContent(workflowName: string): string {
  return `You are the agent for the "${workflowName}" workflow.\nExecute each step carefully and report clear progress.\n`;
}

function buildInstructionContent(stepName: string): string {
  return `Complete ${stepName} for the user's request.\nKeep the output concise and action-oriented.\n`;
}

export function createWorkflowScaffold(options: WorkflowScaffoldOptions): WorkflowScaffoldFile[] {
  const files: WorkflowScaffoldFile[] = [];
  const header = buildWorkflowHeader(options.name, options.description, options.stepCount);
  const body = options.template === 'minimal'
    ? buildMinimalSteps(options.stepCount)
    : buildFacetedWorkflow(
      options.workflowPath,
      options.personaDir!,
      options.instructionDir!,
      options.stepCount,
    );

  files.push({
    path: options.workflowPath,
    content: [...header, ...body, ''].join('\n'),
  });

  if (options.template === 'faceted') {
    files.push({
      path: `${options.personaDir}/default.md`,
      content: buildPersonaContent(options.name),
    });
    for (let index = 1; index <= options.stepCount; index++) {
      const stepName = `step${index}`;
      files.push({
        path: `${options.instructionDir}/${stepName}.md`,
        content: buildInstructionContent(stepName),
      });
    }
  }

  return files;
}
