import { resolveOptions } from './options.js';
import { buildRequest } from './request.js';
import { invokeProvider } from './provider.js';

export function execute(raw) {
  const options = resolveOptions(raw);
  const request = buildRequest(options);
  return invokeProvider(request);
}
