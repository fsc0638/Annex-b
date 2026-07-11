// Thin fetch wrapper for the engine's REST API (ADR-002 D2/D5:
// GET/PUT /api/v1/world/map, PUT /api/v1/world/layout,
// PATCH /api/v1/agents/:id). Every mutating endpoint replies either with
// the requested payload (2xx, typically a full world_snapshot) or the
// engine's unified error envelope `{"error":{"code","message"}}` (400
// bad JSON / 404 not found / 422 validation / 503 world not loaded, see
// engine/crates/api-server/src/error.rs). apiJson normalizes both cases
// so callers can `catch` an `Error` and render `.message` directly
// (server-authored zh-TW text when available).

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

/** Thrown by `apiJson` for both transport failures and non-2xx responses. */
export class ApiError extends Error {
  /** 0 for a network-level failure (fetch itself rejected). */
  status: number;
  /** Engine error code (`bad_request`/`not_found`/`validation_failed`/
   * `world_unavailable`), or a local code when the engine gave nothing. */
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

/**
 * Calls `${NEXT_PUBLIC_API_BASE_URL}${path}` and parses the JSON response.
 * `init` is passed straight to `fetch` (method/body/etc.); a JSON
 * `Content-Type` header is added unless already present.
 *
 * Resolves with the parsed body on 2xx. Throws `ApiError` on:
 * - a network-level failure (fetch rejected — engine unreachable),
 * - any non-2xx response (message = the engine's `error.message` when the
 *   body matches the unified envelope, else the HTTP status text),
 * - a 2xx response whose body isn't valid JSON.
 */
export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new ApiError(
      0,
      "network_error",
      err instanceof Error ? err.message : "無法連線到引擎 API"
    );
  }

  const text = await response.text();
  let body: unknown = undefined;
  let parseError: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      parseError = err;
    }
  }

  if (!response.ok) {
    const envelope = (parseError ? null : (body as ErrorEnvelope | null)) ?? null;
    throw new ApiError(
      response.status,
      envelope?.error?.code ?? "unknown_error",
      envelope?.error?.message ??
        `${response.status} ${response.statusText || "請求失敗"}`
    );
  }

  if (parseError) {
    throw new ApiError(response.status, "invalid_response", "伺服器回應非合法 JSON");
  }

  return body as T;
}
