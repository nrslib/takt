import type {
  TraceStep,
  TracePhase,
  TraceReportParams,
} from './traceReportTypes.js';

interface StepBlock {
  kind: 'step';
  step: TraceStep;
}

interface LoopBlock {
  kind: 'loop';
  steps: TraceStep[];
}

type RenderBlock = StepBlock | LoopBlock;

export function assertTraceParams(params: TraceReportParams): void {
  if (!params.tracePath) throw new Error('tracePath is required');
  if (!params.workflowName) throw new Error('workflowName is required');
  if (!params.task) throw new Error('task is required');
  if (!params.runSlug) throw new Error('runSlug is required');
  if (!params.endTime) throw new Error('endTime is required');
  if (!Number.isInteger(params.iterations) || params.iterations < 0) {
    throw new Error(`iterations must be a non-negative integer: ${params.iterations}`);
  }
}

function assertTraceStep(step: TraceStep, index: number): void {
  if (!step.step) throw new Error(`trace step[${index}] missing step`);
  if (!step.persona) throw new Error(`trace step[${index}] missing persona`);
  if (!Number.isInteger(step.iteration) || step.iteration <= 0) {
    throw new Error(`trace step[${index}] has invalid iteration: ${step.iteration}`);
  }
  if (!step.startedAt) throw new Error(`trace step[${index}] missing startedAt`);
}

function hasPhaseError(phase: TracePhase): boolean {
  if (phase.status === 'error' || Boolean(phase.error)) {
    return true;
  }
  return (phase.judgeStages ?? []).some((stage) => stage.status === 'error');
}

function stepMarker(
  step: TraceStep,
  runStatus: TraceReportParams['status'],
  isLastStep: boolean,
): string {
  if (step.result?.status === 'error' || step.result?.error) {
    return '❌';
  }
  if (runStatus === 'aborted' && !step.result && isLastStep) {
    return '❌';
  }
  if (step.phases.some(hasPhaseError)) {
    return '⚠️';
  }
  return '';
}

function renderPhaseSection(
  phase: TracePhase,
  runStatus: TraceReportParams['status'],
): string[] {
  if (!phase.instruction) {
    throw new Error(`phase ${phase.phase} (${phase.phaseName}) missing instruction`);
  }
  if (!phase.status && runStatus === 'completed') {
    throw new Error(`phase ${phase.phase} (${phase.phaseName}) missing status`);
  }
  if (!phase.completedAt && runStatus === 'completed') {
    throw new Error(`phase ${phase.phase} (${phase.phaseName}) missing completedAt`);
  }

  const marker = hasPhaseError(phase) ? ' ⚠️' : '';
  const lines: string[] = [
    `### Phase ${phase.phase}: ${phase.phaseName}${marker}`,
    '',
    `- Started: ${phase.startedAt}`,
    ...(phase.completedAt ? [`- Completed: ${phase.completedAt}`] : []),
    `- System Prompt: ${phase.systemPrompt.length} chars`,
    '<details><summary>System Prompt</summary>',
    '',
    phase.systemPrompt,
    '',
    '</details>',
    '',
    `- User Instruction: ${phase.userInstruction.length} chars`,
    '<details><summary>User Instruction</summary>',
    '',
    phase.userInstruction,
    '',
    '</details>',
  ];

  if (phase.response != null) {
    lines.push(
      '',
      `- Response: ${phase.response.length} chars`,
      '<details><summary>Response</summary>',
      '',
      phase.response,
      '',
      '</details>',
    );
  }
  lines.push('', `- Status: ${phase.status ?? 'in_progress'}`);
  if (phase.error) {
    lines.push(`- Error: ${phase.error}`);
  }

  if (phase.phase === 3 && phase.judgeStages && phase.judgeStages.length > 0) {
    lines.push('', '#### Judgment Stages', '');
    for (const stage of phase.judgeStages) {
      const stageMarker = stage.status === 'error' ? ' ⚠️' : '';
      lines.push(
        `- Stage ${stage.stage} (${stage.method})${stageMarker}: status=${stage.status}, instruction=${stage.instruction.length} chars, response=${stage.response.length} chars`,
      );
      lines.push('<details><summary>Stage Instruction</summary>', '', stage.instruction, '', '</details>', '');
      lines.push('<details><summary>Stage Response</summary>', '', stage.response, '', '</details>', '');
    }
  }

  lines.push('');
  return lines;
}

function renderStepSection(
  step: TraceStep,
  params: TraceReportParams,
  isLastStep: boolean,
): string[] {
  const marker = stepMarker(step, params.status, isLastStep);
  const markerSuffix = marker ? ` ${marker}` : '';
  const lines: string[] = [
    `## Iteration ${step.iteration}: ${step.step} (persona: ${step.persona})${markerSuffix} - ${step.startedAt}`,
    '',
  ];

  if (step.instruction) {
    lines.push(
      `- Step Instruction: ${step.instruction.length} chars`,
      '<details><summary>Instruction</summary>',
      '',
      step.instruction,
      '',
      '</details>',
      '',
    );
  }

  const phases = [...step.phases].sort((a, b) => {
    const byStart = a.startedAt.localeCompare(b.startedAt);
    if (byStart !== 0) {
      return byStart;
    }
    return a.phase - b.phase;
  });

  for (const phase of phases) {
    lines.push(...renderPhaseSection(phase, params.status));
  }

  if (step.result) {
    lines.push(
      `- Step Status: ${step.result.status}`,
      `- Step Response: ${step.result.content.length} chars`,
    );
    if (step.result.matchMethod) {
      lines.push(`- Match Method: ${step.result.matchMethod}`);
    }
    if (step.result.matchedRuleIndex != null) {
      lines.push(`- Matched Rule Index: ${step.result.matchedRuleIndex}`);
    }
    if (step.result.error) {
      lines.push(`- Error: ${step.result.error}`);
    }
    lines.push('<details><summary>Step Response</summary>', '', step.result.content, '', '</details>');
  } else {
    lines.push(`- Step Status: ${step.completedAt ? 'aborted' : 'in_progress'}`);
  }

  lines.push('', '---', '');
  return lines;
}

function buildRenderBlocks(sorted: TraceStep[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let index = 0;
  while (index < sorted.length) {
    if (index + 3 < sorted.length) {
      const first = sorted[index]!;
      const second = sorted[index + 1]!;
      const third = sorted[index + 2]!;
      const fourth = sorted[index + 3]!;
      const isAlternatingLoop =
        first.step !== second.step
        && first.step === third.step
        && second.step === fourth.step;
      if (isAlternatingLoop) {
        const a = first.step;
        const b = second.step;
        let end = index + 4;
        while (end < sorted.length) {
          const expected = (end - index) % 2 === 0 ? a : b;
          if (sorted[end]!.step !== expected) {
            break;
          }
          end += 1;
        }
        blocks.push({
          kind: 'loop',
          steps: sorted.slice(index, end),
        });
        index = end;
        continue;
      }
    }
    blocks.push({ kind: 'step', step: sorted[index]! });
    index += 1;
  }
  return blocks;
}

function renderLoopBlock(block: LoopBlock, params: TraceReportParams): string[] {
  const first = block.steps[0]!;
  const second = block.steps[1]!;
  const last = block.steps[block.steps.length - 1]!;
  const cycleCount = Math.floor(block.steps.length / 2);
  const lines: string[] = [
    `## Iteration ${first.iteration}-${last.iteration}: ${first.step} ↔ ${second.step} loop (${cycleCount} cycles) ⚠️`,
    '',
    `<details><summary>Loop details (${block.steps.length} steps)</summary>`,
    '',
  ];

  block.steps.forEach((step, stepIndex) => {
    const stepLines = renderStepSection(
      step,
      params,
      stepIndex === block.steps.length - 1,
    );
    lines.push(...stepLines.map((line) => (line ? `  ${line}` : line)));
  });

  lines.push('</details>', '', '---', '');
  return lines;
}

export function renderTraceReportMarkdown(
  params: TraceReportParams,
  traceStartedAt: string,
  steps: TraceStep[],
): string {
  assertTraceParams(params);
  if (!traceStartedAt) {
    throw new Error('traceStartedAt is required');
  }

  const statusLabel = params.status === 'completed' ? '✅ completed' : '❌ aborted';
  const lines: string[] = [
    `# Execution Trace: ${params.workflowName}`,
    '',
    `- Task: ${params.task}`,
    `- Run: ${params.runSlug}`,
    `- Started: ${traceStartedAt}`,
    `- Ended: ${params.endTime}`,
    `- Status: ${statusLabel}`,
    `- Iterations: ${params.iterations}`,
    ...(params.reason ? [`- Reason: ${params.reason}`] : []),
    '',
    '---',
    '',
  ];

  const sorted = [...steps].sort((a, b) => {
    const byStart = a.startedAt.localeCompare(b.startedAt);
    if (byStart !== 0) {
      return byStart;
    }
    return a.iteration - b.iteration;
  });
  sorted.forEach((step, index) => assertTraceStep(step, index));

  const blocks = buildRenderBlocks(sorted);
  blocks.forEach((block, blockIndex) => {
    if (block.kind === 'loop') {
      lines.push(...renderLoopBlock(block, params));
      return;
    }
    lines.push(...renderStepSection(block.step, params, blockIndex === blocks.length - 1));
  });

  return lines.join('\n');
}
