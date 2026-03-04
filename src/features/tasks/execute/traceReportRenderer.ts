import type {
  TraceMovement,
  TracePhase,
  TraceReportParams,
} from './traceReportTypes.js';

interface MovementBlock {
  kind: 'movement';
  movement: TraceMovement;
}

interface LoopBlock {
  kind: 'loop';
  movements: TraceMovement[];
}

type RenderBlock = MovementBlock | LoopBlock;

export function assertTraceParams(params: TraceReportParams): void {
  if (!params.tracePath) throw new Error('tracePath is required');
  if (!params.pieceName) throw new Error('pieceName is required');
  if (!params.task) throw new Error('task is required');
  if (!params.runSlug) throw new Error('runSlug is required');
  if (!params.endTime) throw new Error('endTime is required');
  if (!Number.isInteger(params.iterations) || params.iterations < 0) {
    throw new Error(`iterations must be a non-negative integer: ${params.iterations}`);
  }
}

function assertTraceMovement(movement: TraceMovement, index: number): void {
  if (!movement.step) throw new Error(`trace movement[${index}] missing step`);
  if (!movement.persona) throw new Error(`trace movement[${index}] missing persona`);
  if (!Number.isInteger(movement.iteration) || movement.iteration <= 0) {
    throw new Error(`trace movement[${index}] has invalid iteration: ${movement.iteration}`);
  }
  if (!movement.startedAt) throw new Error(`trace movement[${index}] missing startedAt`);
}

function hasPhaseError(phase: TracePhase): boolean {
  if (phase.status === 'error' || Boolean(phase.error)) {
    return true;
  }
  return (phase.judgeStages ?? []).some((stage) => stage.status === 'error');
}

function movementMarker(
  movement: TraceMovement,
  runStatus: TraceReportParams['status'],
  isLastMovement: boolean,
): string {
  if (movement.result?.status === 'error' || movement.result?.error) {
    return '❌';
  }
  if (runStatus === 'aborted' && !movement.result && isLastMovement) {
    return '❌';
  }
  if (movement.phases.some(hasPhaseError)) {
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

function renderMovementSection(
  movement: TraceMovement,
  params: TraceReportParams,
  isLastMovement: boolean,
): string[] {
  const marker = movementMarker(movement, params.status, isLastMovement);
  const markerSuffix = marker ? ` ${marker}` : '';
  const lines: string[] = [
    `## Iteration ${movement.iteration}: ${movement.step} (persona: ${movement.persona})${markerSuffix} - ${movement.startedAt}`,
    '',
  ];

  if (movement.instruction) {
    lines.push(
      `- Movement Instruction: ${movement.instruction.length} chars`,
      '<details><summary>Instruction</summary>',
      '',
      movement.instruction,
      '',
      '</details>',
      '',
    );
  }

  const phases = [...movement.phases].sort((a, b) => {
    const byStart = a.startedAt.localeCompare(b.startedAt);
    if (byStart !== 0) {
      return byStart;
    }
    return a.phase - b.phase;
  });

  for (const phase of phases) {
    lines.push(...renderPhaseSection(phase, params.status));
  }

  if (movement.result) {
    lines.push(
      `- Movement Status: ${movement.result.status}`,
      `- Movement Response: ${movement.result.content.length} chars`,
    );
    if (movement.result.matchMethod) {
      lines.push(`- Match Method: ${movement.result.matchMethod}`);
    }
    if (movement.result.matchedRuleIndex != null) {
      lines.push(`- Matched Rule Index: ${movement.result.matchedRuleIndex}`);
    }
    if (movement.result.error) {
      lines.push(`- Error: ${movement.result.error}`);
    }
    lines.push('<details><summary>Movement Response</summary>', '', movement.result.content, '', '</details>');
  } else {
    lines.push(`- Movement Status: ${movement.completedAt ? 'aborted' : 'in_progress'}`);
  }

  lines.push('', '---', '');
  return lines;
}

function buildRenderBlocks(sorted: TraceMovement[]): RenderBlock[] {
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
          movements: sorted.slice(index, end),
        });
        index = end;
        continue;
      }
    }
    blocks.push({ kind: 'movement', movement: sorted[index]! });
    index += 1;
  }
  return blocks;
}

function renderLoopBlock(block: LoopBlock, params: TraceReportParams): string[] {
  const first = block.movements[0]!;
  const second = block.movements[1]!;
  const last = block.movements[block.movements.length - 1]!;
  const cycleCount = Math.floor(block.movements.length / 2);
  const lines: string[] = [
    `## Iteration ${first.iteration}-${last.iteration}: ${first.step} ↔ ${second.step} loop (${cycleCount} cycles) ⚠️`,
    '',
    `<details><summary>Loop details (${block.movements.length} movements)</summary>`,
    '',
  ];

  block.movements.forEach((movement, movementIndex) => {
    const movementLines = renderMovementSection(
      movement,
      params,
      movementIndex === block.movements.length - 1,
    );
    lines.push(...movementLines.map((line) => (line ? `  ${line}` : line)));
  });

  lines.push('</details>', '', '---', '');
  return lines;
}

export function renderTraceReportMarkdown(
  params: TraceReportParams,
  traceStartedAt: string,
  movements: TraceMovement[],
): string {
  assertTraceParams(params);
  if (!traceStartedAt) {
    throw new Error('traceStartedAt is required');
  }

  const statusLabel = params.status === 'completed' ? '✅ completed' : '❌ aborted';
  const lines: string[] = [
    `# Execution Trace: ${params.pieceName}`,
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

  const sorted = [...movements].sort((a, b) => {
    const byStart = a.startedAt.localeCompare(b.startedAt);
    if (byStart !== 0) {
      return byStart;
    }
    return a.iteration - b.iteration;
  });
  sorted.forEach((movement, index) => assertTraceMovement(movement, index));

  const blocks = buildRenderBlocks(sorted);
  blocks.forEach((block, blockIndex) => {
    if (block.kind === 'loop') {
      lines.push(...renderLoopBlock(block, params));
      return;
    }
    lines.push(...renderMovementSection(block.movement, params, blockIndex === blocks.length - 1));
  });

  return lines.join('\n');
}
