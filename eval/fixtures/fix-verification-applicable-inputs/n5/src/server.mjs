import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { handleAdminRequest } from './admin.mjs';

export function createAdminServer(file) {
  return createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const fields = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      const path = new URL(request.url, 'http://localhost').pathname;
      const html = await handleAdminRequest(file, request.method, path, fields);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('要求を処理できませんでした');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAdminServer('invoices.json').listen(8080, '127.0.0.1');
}
