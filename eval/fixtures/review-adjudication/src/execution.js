export function buildExecution(options) {
  if (options.channel !== 'local' && options.channel !== 'cloud') {
    throw new Error('Unsupported channel');
  }
  return { channel: options.channel };
}
