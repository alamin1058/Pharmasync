import { ProblemDetails } from '../shared/types';

let inMemoryToken: string | null = null;

export function setAuthToken(token: string | null): void {
  inMemoryToken = token;
}

export function getAuthToken(): string | null {
  return inMemoryToken;
}

export class ApiError extends Error {
  status: number;
  title: string;
  errors?: Record<string, string>;
  traceId?: string;

  constructor(problem: ProblemDetails) {
    super(problem.detail || problem.title || 'Request failed');
    this.status = problem.status;
    this.title = problem.title;
    this.errors = problem.errors;
    this.traceId = problem.traceId;
  }
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...options.headers,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (inMemoryToken) {
    headers['Authorization'] = `Bearer ${inMemoryToken}`;
  }

  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json') || contentType.includes('application/problem+json');
  const data = isJson ? await response.json() : null;

  if (!response.ok) {
    if (data && typeof data === 'object' && 'detail' in data) {
      throw new ApiError(data as ProblemDetails);
    }
    throw new ApiError({
      type: 'about:blank',
      title: response.statusText || 'Error',
      status: response.status,
      detail: `HTTP ${response.status}: ${response.statusText}`,
    });
  }

  return data as T;
}
