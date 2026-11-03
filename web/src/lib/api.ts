export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function request<T>(method: string, url: string, body?: any): Promise<T> {
  const opts: RequestInit = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    (opts.headers as any)['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error || msg; } catch { /* ignore */ }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as unknown as T;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return undefined as unknown as T;
}

export const api = {
  get: <T,>(url: string) => request<T>('GET', url),
  post: <T,>(url: string, body?: any) => request<T>('POST', url, body),
  put: <T,>(url: string, body?: any) => request<T>('PUT', url, body),
  patch: <T,>(url: string, body?: any) => request<T>('PATCH', url, body),
  del: <T,>(url: string, body?: any) => request<T>('DELETE', url, body),
};
