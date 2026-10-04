export function evaluateMonitor(monitor, count) {
  return {
    decision: count >= monitor.limit ? 'stop' : 'continue',
    instruction: monitor.instruction.replace('{count}', String(count)),
  };
}
