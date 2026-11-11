export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let tokenGetter: () => string = () => '';

export function setTokenGetter(fn: () => string) {
  tokenGetter = fn;
}

export async function api<T = unknown>(
  route: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'x-cc-remote-token': tokenGetter() };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(route, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      (json as { error?: string } | null)?.error ?? `Request failed (${response.status})`,
      response.status,
    );
  }
  return json as T;
}

export const get = <T>(route: string) => api<T>(route);
export const post = <T>(route: string, body?: unknown) => api<T>(route, { method: 'POST', body });
