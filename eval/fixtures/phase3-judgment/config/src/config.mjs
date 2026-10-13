export function loadConfig(contents) {
  const defaults = { timeoutMs: 3000, retries: 2, region: 'ap-northeast-1' };
  const configured = JSON.parse(contents);
  return {
    ...defaults,
    ...configured,
  };
}
