const API_BASE = '/api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('monitour_token');
  const isFormData = options.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((options.headers as Record<string, string>) ?? {}),
  };

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    localStorage.removeItem('monitour_token');
    localStorage.removeItem('monitour_user');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    }),
  patch: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T,>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** POST that returns a file (e.g. agent package zip) and triggers a browser download. */
  download: async (path: string, body: unknown, filename: string): Promise<void> => {
    const token = localStorage.getItem('monitour_token');
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    saveBlob(await res.blob(), filename);
  },
  /** GET that returns a file and triggers a browser download. */
  downloadGet: async (path: string, filename: string): Promise<void> => {
    const token = localStorage.getItem('monitour_token');
    const res = await fetch(`${API_BASE}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    saveBlob(await res.blob(), filename);
  },
  /**
   * Multipart upload with upload-progress callbacks (fetch can't report
   * upload progress — XHR is required for the progress event).
   */
  upload: <T,>(path: string, formData: FormData, onProgress?: (percent: number) => void): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const token = localStorage.getItem('monitour_token');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}${path}`);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          onProgress?.(Math.min(100, Math.round((e.loaded / e.total) * 100)));
        }
      };

      xhr.onload = () => {
        let data: { error?: string } & Record<string, unknown> = {};
        try {
          data = JSON.parse(xhr.responseText) as typeof data;
        } catch {
          // non-JSON body — fall through to status handling
        }
        if (xhr.status === 401) {
          localStorage.removeItem('monitour_token');
          localStorage.removeItem('monitour_user');
          window.location.href = '/login';
          reject(new Error('Unauthorized'));
          return;
        }
        if (xhr.status >= 400) {
          reject(new Error(data.error || `Request failed: ${xhr.status}`));
          return;
        }
        resolve(data as T);
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.onabort = () => reject(new Error('Upload aborted'));

      xhr.send(formData);
    });
  },
};

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
