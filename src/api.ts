let tokenProvider: () => Promise<string> = async () => "";
export const setTokenProvider = (provider: () => Promise<string>) => {
  tokenProvider = provider;
};
export async function api<T = any>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const token = await tokenProvider();
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw Object.assign(new Error(error.error ?? error.message ?? response.statusText), { status: response.status });
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export async function download(path: string, name: string) {
  const token = await tokenProvider();
  const r = await fetch(`/api${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!r.ok) throw new Error("Download failed");
  saveBlob(await r.blob(), name);
}
export function saveBlob(blob: Blob, name: string) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 5000);
}
export function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}
