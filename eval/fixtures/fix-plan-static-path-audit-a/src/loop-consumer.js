export function judgeLoop(config, input) {
  const monitor = config.loop_monitor;
  const cycleCount = input.cycleCount;
  const reachedThreshold = cycleCount >= monitor.threshold;
  const instruction = monitor.judge.instruction
    .replace('{cycle_count}', String(cycleCount));

  return {
    cycle: monitor.cycle,
    cycleCount,
    threshold: monitor.threshold,
    instruction,
    decision: reachedThreshold ? 'terminal' : 'continue',
    terminal: reachedThreshold ? 'judge decision' : 'requeue cycle',
  };
}
