import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const root = process.env.MERGE_TEST_ROOT;
const routes = JSON.parse(process.env.MERGE_TEST_ROUTES);
function handleGitRequest(request, response) {
  const url = new URL(request.url, 'https://localhost');
  const route = routes.find((candidate) => url.pathname.startsWith(`/${candidate.path}/`));
  const credential = route?.credential;
  if (process.env.MERGE_TEST_REQUEST_LOG) appendFileSync(process.env.MERGE_TEST_REQUEST_LOG, JSON.stringify({
    path: url.pathname, hasAuthorization: request.headers.authorization !== undefined, authenticated: Boolean(credential)
      && request.headers.authorization === `Basic ${Buffer.from(credential).toString('base64')}`,
  }) + '\n');
  if (!credential || request.headers.authorization !== `Basic ${Buffer.from(credential).toString('base64')}`) {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="merge-test"' });
    response.end('Authentication rejected');
    return;
  }
  const backend = spawn('git', ['http-backend'], { env: {
    ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers['content-type'] ?? '',
    REMOTE_USER: 'merge-test',
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  let headers = Buffer.alloc(0);
  let sentHeaders = false;
  backend.stdout.on('data', (chunk) => {
    if (sentHeaders) { response.write(chunk); return; }
    headers = Buffer.concat([headers, chunk]);
    const end = headers.indexOf('\r\n\r\n');
    if (end === -1) return;
    let status = 200;
    const values = {};
    for (const line of headers.subarray(0, end).toString().split('\r\n')) {
      const separator = line.indexOf(':');
      const name = line.slice(0, separator);
      const value = line.slice(separator + 1).trim();
      if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
      else values[name] = value;
    }
    response.writeHead(status, values);
    sentHeaders = true;
    response.write(headers.subarray(end + 4));
  });
  backend.on('error', () => { response.writeHead(500); response.end(); });
  backend.on('close', () => response.end());
  backend.stderr.resume();
  request.pipe(backend.stdin);
}
const server = createServer({
  key: readFileSync(`${root}/key.pem`),
  cert: readFileSync(`${root}/cert.pem`),
}, handleGitRequest);
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`);
});
