import { z } from "zod";

/**
 * Extracts model ids from the common OpenAI-compatible `/models` envelopes.
 * Relays are rarely byte-identical here, so accept the shapes operators
 * actually encounter instead of failing on a harmless wrapper difference.
 */
const catalogItemSchema = z.union([
  z.string(),
  z.object({ id: z.string() }).passthrough(),
  z.object({ name: z.string() }).passthrough(),
]);

const catalogSchema = z.union([
  z.object({ data: z.array(catalogItemSchema) }),
  z.object({ models: z.array(catalogItemSchema) }),
  z.array(catalogItemSchema),
]);

export interface ModelCatalogOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function fetchModelIds(options: ModelCatalogOptions): Promise<readonly string[]> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${baseUrl}/models`, {
      method: "GET",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      headers: {
        accept: "application/json",
        // Local runtimes such as Ollama expose `/models` without auth, so an
        // empty key means "send no Authorization header" rather than "fail".
        ...(options.apiKey.length > 0 ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("获取模型超时，请检查 API 地址或网络");
    }
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`无法连接模型接口：${cause}`);
  }
  if (!response.ok) {
    throw new Error(catalogErrorDetail(response.status));
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("模型接口返回的不是 JSON，可能是网关错误页");
  }
  const parsed = catalogSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("模型接口返回格式无法识别，请手动填写模型名称");
  }
  const items = Array.isArray(parsed.data)
    ? parsed.data
    : "data" in parsed.data
      ? parsed.data.data
      : parsed.data.models;
  const models = [...new Set(items.map(modelId).filter((id): id is string => id !== null))]
    .sort((left, right) => left.localeCompare(right));
  if (models.length === 0) {
    throw new Error("模型接口没有返回可用模型，请确认地址和 Key 的权限");
  }
  return models;
}

function modelId(item: string | { readonly id?: string; readonly name?: string }): string | null {
  const value = typeof item === "string" ? item : item.id ?? item.name ?? "";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function catalogErrorDetail(status: number): string {
  if (status === 401 || status === 403) {
    return `API Key 无效或没有读取模型的权限（HTTP ${status}）`;
  }
  if (status === 404) {
    return "该地址没有 /models 接口，请手动填写模型名称（HTTP 404）";
  }
  return `获取模型失败（HTTP ${status}）`;
}
