const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "accept-ranges",
  "content-length",
  "content-range",
  "etag",
  "last-modified",
  "expires",
];

type ProxyContext = {
  request: Request;
  waitUntil?: (promise: Promise<any>) => void;
  apiBaseUrl: string;
};

function createCorsHeaders(init?: Headers, defaultCacheControl = "no-store"): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", defaultCacheControl);
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function jsonResponse(
  payload: Record<string, unknown>,
  status = 502,
  extraHeaders?: Headers,
): Response {
  const headers = createCorsHeaders(extraHeaders, "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  headers.set("X-Cache-Status", "BYPASS");
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
  return new Response(JSON.stringify(payload), { status, headers });
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname: string): boolean {
  return !!hostname && KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedKuwoHost(parsed.hostname)) return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.protocol = "http:";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl: string, request: Request): Promise<Response> {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", {
      status: 400,
      headers: createCorsHeaders(undefined, "no-store"),
    });
  }

  const headers = new Headers({
    "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
    "Referer": "https://www.kuwo.cn/",
  });
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) headers.set("Range", rangeHeader);

  let upstream: Response;
  try {
    upstream = await fetch(normalized.toString(), {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
    });
  } catch (error) {
    console.error("[Kuwo Proxy Error]", error);
    return jsonResponse({ error: "kuwo_upstream_unavailable" }, 502);
  }

  const responseHeaders = createCorsHeaders(upstream.headers, "public, max-age=3600");
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

function parseApiJson(text: string): { valid: boolean; value?: unknown; reason?: string } {
  if (!text || !text.trim()) return { valid: false, reason: "empty_response" };

  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "string" && /^error(?:\b|\s|:)/i.test(value.trim())) {
      return { valid: false, reason: "upstream_text_error" };
    }
    if (value === null || value === undefined) {
      return { valid: false, reason: "empty_json_value" };
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record.error) return { valid: false, reason: "upstream_error_field" };
      if (record.status === 0 || record.status === "0") {
        return { valid: false, reason: "upstream_error_status" };
      }
    }
    return { valid: true, value };
  } catch {
    return { valid: false, reason: "invalid_json" };
  }
}

function addCacheStatus(response: Response, status: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Cache-Status", status);
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function proxyApiRequest({ request, waitUntil, apiBaseUrl }: ProxyContext, url: URL): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const isGet = request.method === "GET";
  const bypassCache = url.searchParams.get("nocache") === "true";

  // s 和 nocache 不参与缓存键，避免随机签名制造重复缓存。
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("s");
  cacheUrl.searchParams.delete("nocache");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

  // 旧版本可能缓存过裸文本 error。命中缓存后必须先验证，不能盲信历史垃圾数据。
  if (isGet && !bypassCache) {
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        const cachedText = await cachedResponse.clone().text();
        const cachedJson = parseApiJson(cachedText);
        if (cachedResponse.status === 200 && cachedJson.valid) {
          console.log(`[Cache HIT] ${url.toString()}`);
          return addCacheStatus(cachedResponse, "HIT");
        }

        console.warn(`[Cache INVALID] Removing stale cache: ${url.toString()}`);
        await cache.delete(cacheKey);
      }
    } catch (error) {
      console.warn(`[Cache READ ERROR] ${url.toString()}`, error);
    }
  }

  const apiUrl = new URL(apiBaseUrl);
  url.searchParams.forEach((value, key) => {
    if (["target", "callback", "s", "nocache"].includes(key)) return;
    apiUrl.searchParams.set(key, value);
  });

  if (!apiUrl.searchParams.has("types")) {
    return jsonResponse({ error: "missing_types" }, 400);
  }

  let upstream: Response;
  try {
    upstream = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: {
        "User-Agent": "Meting/1.5.0",
        "Accept": "application/json",
      },
    });
  } catch (error) {
    console.error("[GD Studio Fetch Error]", error);
    return jsonResponse({ error: "upstream_fetch_failed" }, 502);
  }

  let responseText = "";
  try {
    responseText = await upstream.text();
  } catch (error) {
    console.error("[GD Studio Read Error]", error);
    return jsonResponse({ error: "upstream_read_failed", upstreamStatus: upstream.status }, 502);
  }

  const parsed = parseApiJson(responseText);
  if (!upstream.ok || !parsed.valid) {
    console.error("[GD Studio Invalid Response]", {
      status: upstream.status,
      reason: parsed.reason,
      preview: responseText.slice(0, 160),
    });
    return jsonResponse(
      {
        error: "music_api_upstream_error",
        reason: parsed.reason ?? "upstream_http_error",
        upstreamStatus: upstream.status,
      },
      502,
      upstream.headers,
    );
  }

  const headers = createCorsHeaders(upstream.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Cache-Status", "MISS");
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status");

  const isSearch = url.searchParams.get("types") === "search";
  const isEmptySearchResult = isSearch && Array.isArray(parsed.value) && parsed.value.length === 0;
  const shouldCache = isGet && upstream.status === 200 && !isEmptySearchResult && !bypassCache;

  headers.set(
    "Cache-Control",
    shouldCache ? "public, s-maxage=300, max-age=300" : "no-store, no-cache, must-revalidate",
  );

  const response = new Response(request.method === "HEAD" ? null : responseText, {
    status: 200,
    headers,
  });

  if (shouldCache) {
    const cacheResponse = new Response(responseText, {
      status: 200,
      headers: new Headers(headers),
    });
    const putPromise = cache.put(cacheKey, cacheResponse).catch((error) => {
      console.warn(`[Cache PUT ERROR] ${url.toString()}`, error);
    });
    if (waitUntil) waitUntil(putPromise);
    else await putPromise;
    console.log(`[Cache PUT] Saved to cache: ${url.toString()}`);
  }

  return response;
}

export async function onRequest({
  request,
  waitUntil,
  env,
}: {
  request: Request;
  waitUntil?: (promise: Promise<any>) => void;
  env: any;
}): Promise<Response> {
  if (request.method === "OPTIONS") return handleOptions();

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: createCorsHeaders(undefined, "no-store"),
    });
  }

  try {
    const apiBaseUrl =
      typeof env?.API_BASE_URL === "string" && env.API_BASE_URL.trim()
        ? env.API_BASE_URL.trim()
        : DEFAULT_API_BASE_URL;
    const url = new URL(request.url);
    const target = url.searchParams.get("target");

    if (target) return await proxyKuwoAudio(target, request);
    return await proxyApiRequest({ request, waitUntil, apiBaseUrl }, url);
  } catch (error) {
    console.error("[Lunatide Proxy Unhandled Error]", error);
    return jsonResponse({ error: "proxy_internal_error" }, 500);
  }
}
