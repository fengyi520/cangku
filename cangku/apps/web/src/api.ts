export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

function csrfToken() {
  const match = document.cookie.split("; ").find((cookie) => cookie.startsWith("cangku_csrf="));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : "";
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = options.method?.toUpperCase() ?? "GET";
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("x-csrf-token", csrfToken());
  const response = await fetch(`/api/v1${path}`, { ...options, headers, credentials: "include" });
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    const message = details?.message ? (Array.isArray(details.message) ? details.message.join("；") : String(details.message)) : `请求失败（${response.status}）`;
    throw new ApiError(response.status, message, details);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function jsonBody(value: unknown) {
  return JSON.stringify(value);
}

export function downloadExport(id: string) {
  window.location.assign(`/api/v1/exports/${id}/download`);
}
