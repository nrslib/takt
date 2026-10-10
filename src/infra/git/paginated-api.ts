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

interface PaginatedApiOptions<T> {
  command: 'gh' | 'glab';
  cwd: string;
  context: string;
  initialEndpoint: string;
  apiPrefix?: string;
  allPages?: boolean;
  parsePage: (body: string, context: string) => T[];
}

export function fetchPaginatedApi<T>(options: PaginatedApiOptions<T> & { allPages: true }): Iterable<T>;
export function fetchPaginatedApi<T>(options: PaginatedApiOptions<T> & { allPages?: false }): T[];
export function fetchPaginatedApi<T>(options: PaginatedApiOptions<T>): Iterable<T>;
export function fetchPaginatedApi<T>(options: PaginatedApiOptions<T>): Iterable<T> {
  const items = fetchApiItems(options);
  return options.allPages === true ? items : Array.from(items);
}

function readPageNumber(endpoint: string): number {
  const page = Number(new URL(endpoint, 'https://api.github.com/').searchParams.get('page'));
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error(`Invalid pagination page in "${endpoint}"`);
  }
  return page;
}

function* fetchApiItems<T>(options: PaginatedApiOptions<T>): Generator<T> {
  let endpoint = options.initialEndpoint;
  let currentPage = options.allPages === true ? readPageNumber(endpoint) : undefined;

  for (let page = 1; options.allPages === true || page <= PAGINATION_HARD_CAP; page += 1) {
    const raw = execFileSync(
      options.command,
      ['api', '--include', endpoint],
      { cwd: options.cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const response = parseIncludedHttpResponse(raw, options.context);
    yield* options.parsePage(response.body, options.context);

    const nextEndpoint = response.headers.link
      ? extractNextEndpointFromLink(response.headers.link, options.apiPrefix)
      : undefined;
    if (!nextEndpoint) {
      return;
    }

    if (currentPage !== undefined) {
      const nextPage = readPageNumber(nextEndpoint);
      if (nextPage <= currentPage) {
        throw new Error(`Pagination cycle detected while fetching ${options.context}`);
      }
      currentPage = nextPage;
    }
    endpoint = nextEndpoint;
  }

  throw new Error(
    `Pagination limit exceeded while fetching ${options.context} (>${PAGINATION_HARD_CAP} pages)`,
  );
}
