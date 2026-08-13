export function buildRetryMenu({ resumeValue, failedLeafValue, firstLeafValue }) {
  const options = [];
  if (resumeValue !== undefined) {
    options.push({ value: resumeValue, kind: 'resume', preservesCheckpoint: true });
  }
  if (failedLeafValue !== undefined) {
    options.push({ value: failedLeafValue, kind: 'restart', preservesCheckpoint: false });
  }
  if (firstLeafValue !== undefined && firstLeafValue !== failedLeafValue) {
    options.push({ value: firstLeafValue, kind: 'restart', preservesCheckpoint: false });
  }

  return {
    options,
    defaultValue: resumeValue ?? failedLeafValue ?? firstLeafValue,
  };
}
