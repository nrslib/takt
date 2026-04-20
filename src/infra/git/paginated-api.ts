import { execFileSync } from 'node:child_process';

const PAGINATION_HARD_CAP = 100;
const LINK_NEXT_PATTERN = /<([^>]+)>;\s*rel="next"/i;

interface IncludedHttpResponse {
  body: string;
  headers: Record<string, string>;
}

function parseIncludedHttpResponse(raw: string, _context: string): IncludedHttpResponse {
  const separatorIndex = raw.search(/\r?\n\r?\n/);
  if (separatorIndex < 0) {
    return { body: raw, headers: {} };
  }

  const headerText = raw.slice(0, separatorIndex);
  const body = raw.slice(separatorIndex).replace(/^\r?\n\r?\n/, '');
  const headers: Record<string, string> = {};
  const headerLines = headerText.split(/\r?\n/).slice(1);

  for (const line of headerLines) {
    const separator = line.indexOf(':');
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[key] = value;
  }

  return { body, headers };
}

function extractNextEndpointFromLink(linkHeader: string, apiPrefix: string | undefined): string | undefined {
  const match = linkHeader.match(LINK_NEXT_PATTERN);
  if (!match?.[1]) {
    return undefined;
  }

  const nextUrl = new URL(match[1]);
  const endpoint = `${nextUrl.pathname}${nextUrl.search}`;
  if (apiPrefix === undefined) {
    return endpoint;
  }
  if (!endpoint.startsWith(apiPrefix)) {
    throw new Error(`Unexpected pagination link "${match[1]}"`);
  }
  return endpoint.slice(apiPrefix.length).replace(/^\//, '');
}

export function fetchPaginatedApi<T>(options: {
  command: 'gh' | 'glab';
  cwd: string;
  context: string;
  initialEndpoint: string;
  apiPrefix?: string;
  parsePage: (body: string, context: string) => T[];
}): T[] {
  const items: T[] = [];
  let endpoint = options.initialEndpoint;

  for (let page = 1; page <= PAGINATION_HARD_CAP; page += 1) {
    const raw = execFileSync(
      options.command,
      ['api', '--include', endpoint],
      { cwd: options.cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const response = parseIncludedHttpResponse(raw, options.context);
    items.push(...options.parsePage(response.body, options.context));

    const nextEndpoint = response.headers.link
      ? extractNextEndpointFromLink(response.headers.link, options.apiPrefix)
      : undefined;
    if (!nextEndpoint) {
      return items;
    }

    endpoint = nextEndpoint;
  }

  throw new Error(
    `Pagination limit exceeded while fetching ${options.context} (>${PAGINATION_HARD_CAP} pages)`,
  );
}
