const PUBLIC_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Cache-Bypass",
  "Access-Control-Max-Age": "86400",
};

// Keep the trusted origin in sync with ALLOWED_ORIGIN in next.config.mjs.
const ALLOWLISTED_PUBLIC_CORS_ORIGINS = new Set(["https://github.com"]);

export function withPublicCors<T extends Response>(response: T): T {
  for (const [name, value] of Object.entries(PUBLIC_CORS_HEADERS)) {
    response.headers.set(name, value);
  }

  return response;
}

export function withAllowlistedPublicCors<T extends Response>(
  response: T,
  origin: string | null
): T {
  const vary = response.headers
    .get("Vary")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];

  if (!vary.some((value) => value.toLowerCase() === "origin")) {
    vary.push("Origin");
  }
  response.headers.set("Vary", vary.join(", "));

  if (origin && ALLOWLISTED_PUBLIC_CORS_ORIGINS.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Cache-Bypass"
    );
    response.headers.set("Access-Control-Max-Age", "86400");
  }

  return response;
}

export function publicOptionsResponse(methods: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...PUBLIC_CORS_HEADERS,
      "Access-Control-Allow-Methods": methods,
      Allow: methods,
    },
  });
}

export function allowlistedPublicOptionsResponse(
  methods: string,
  origin: string | null
): Response {
  const response = new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": methods,
      Allow: methods,
    },
  });

  return withAllowlistedPublicCors(response, origin);
}