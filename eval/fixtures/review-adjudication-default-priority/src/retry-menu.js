export function chooseDefault({ resumeValue, failedLeafValue, firstLeafValue }) {
  return resumeValue ?? failedLeafValue ?? firstLeafValue;
}
