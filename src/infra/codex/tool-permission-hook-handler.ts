import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
import {
  CODEX_TOOL_PERMISSION_ENDPOINT_ENV, CODEX_TOOL_PERMISSION_TOKEN_ENV,
  CODEX_TOOL_PERMISSION_HANDLER_TIMEOUT_MS, codexToolPermissionDenial,
  parseCodexToolPermissionInput, parseCodexToolPermissionOutput,
} from './tool-permission-hook-protocol.js';

async function run() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CODEX_TOOL_PERMISSION_HANDLER_TIMEOUT_MS);
  let onAbort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('PreToolUse handler timed out'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const operation = async () => {
      let input = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) input += String(chunk);
      const raw: unknown = JSON.parse(input);
      parseCodexToolPermissionInput(raw);
      const endpoint = process.env[CODEX_TOOL_PERMISSION_ENDPOINT_ENV];
      const token = process.env[CODEX_TOOL_PERMISSION_TOKEN_ENV];
      if (endpoint === undefined || !token) throw new Error('Missing permission endpoint');
      const url = new URL(endpoint);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
        throw new Error('Invalid permission endpoint');
      }
      return await new Promise<ReturnType<typeof parseCodexToolPermissionOutput>>((resolve, reject) => {
        const outgoing = request(url, {
          method: 'POST', signal: controller.signal,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { body += chunk; });
          response.on('error', reject);
          response.on('end', () => {
            try {
              if (response.statusCode !== 200) throw new Error('Permission request rejected');
              resolve(parseCodexToolPermissionOutput(JSON.parse(body) as unknown));
            } catch (error) { reject(error); }
          });
        });
        outgoing.on('error', reject);
        outgoing.end(JSON.stringify(raw));
      });
    };
    return await Promise.race([operation(), interrupted]);
  } catch {
    return codexToolPermissionDenial(controller.signal.aborted
      ? 'Tool permission hook timed out' : 'Tool permission hook request failed or returned invalid data');
  } finally {
    clearTimeout(timeout);
    if (onAbort !== undefined) controller.signal.removeEventListener('abort', onAbort);
    controller.abort();
    process.stdin.destroy();
  }
}

try {
  writeFileSync(1, `${JSON.stringify(await run())}\n`);
} catch {
  // Codex continues on other nonzero statuses; status 2 is the emergency denial path.
  process.exitCode = 2;
  writeFileSync(2, 'Tool permission hook could not return a decision; execution denied\n');
}
