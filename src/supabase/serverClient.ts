type SupabaseSelectQuery = {
  table: string;
  select: string;
  filters?: string[];
  order?: string[];
  limit?: number;
  single?: "single" | "maybeSingle";
};

type SupabaseInsertQuery = {
  table: string;
  values: Record<string, unknown>;
};

type SupabaseUpdateQuery = {
  table: string;
  values: Record<string, unknown>;
  filters: string[];
};

type SupabaseUpsertQuery = {
  table: string;
  values: Record<string, unknown>;
  onConflict: string;
};

type SupabaseDeleteQuery = {
  table: string;
  filters: string[];
};

type SupabaseRestResponse = {
  response: Response;
  text: string;
};

const SUPABASE_RETRY_DELAYS_MS = [250, 1000, 2500] as const;

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function buildBaseHeaders(): Record<string, string> {
  const serviceRoleKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

function buildRestUrl(path: string, queryParams: URLSearchParams): string {
  const supabaseUrl = readEnv("NEXT_PUBLIC_SUPABASE_URL");
  const query = queryParams.toString();
  return `${supabaseUrl}/rest/v1/${path}${query.length > 0 ? `?${query}` : ""}`;
}

function buildQueryParams(filters?: string[], order?: string[], limit?: number): URLSearchParams {
  const params = new URLSearchParams();

  for (const filter of filters ?? []) {
    const [key, value] = filter.split("=", 2);
    if (!key || value === undefined) {
      continue;
    }
    params.set(key, value);
  }

  for (const orderClause of order ?? []) {
    params.append("order", orderClause);
  }

  if (typeof limit === "number") {
    params.set("limit", String(limit));
  }

  return params;
}

function isRetryableSupabaseResponse(status: number, text: string): boolean {
  if (status === 503 || status === 504 || status === 522) {
    return true;
  }

  try {
    const payload = JSON.parse(text) as { code?: string };
    return payload.code === "PGRST002" || payload.code === "57014";
  } catch {
    const normalized = text.toLowerCase();
    return text.includes("PGRST002")
      || text.includes("57014")
      || normalized.includes("schema cache")
      || normalized.includes("statement timeout")
      || normalized.includes("upstream request timeout")
      || normalized.includes("connection timed out");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchSupabaseRest(url: string, init: RequestInit): Promise<SupabaseRestResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, init);
    const text = await response.text();
    if (
      response.ok
      || !isRetryableSupabaseResponse(response.status, text)
      || attempt >= SUPABASE_RETRY_DELAYS_MS.length
    ) {
      return { response, text };
    }

    await sleep(SUPABASE_RETRY_DELAYS_MS[attempt] ?? 0);
  }
}

export async function supabaseInsertAndSelectOne<T>(query: SupabaseInsertQuery): Promise<T> {
  const params = new URLSearchParams();
  const { response, text } = await fetchSupabaseRest(buildRestUrl(query.table, params), {
    method: "POST",
    headers: {
      ...buildBaseHeaders(),
      Prefer: "return=representation",
    },
    body: JSON.stringify(query.values),
  });
  if (!response.ok) {
    throw new Error(`Supabase insert failed (${response.status}): ${text}`);
  }
  const payload = text.length > 0 ? (JSON.parse(text) as T[]) : null;
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error(`Supabase insert returned no rows for table ${query.table}.`);
  }
  return payload[0] as T;
}

export async function supabaseUpsertAndSelectOne<T>(query: SupabaseUpsertQuery): Promise<T> {
  const params = new URLSearchParams();
  params.set("on_conflict", query.onConflict);

  const { response, text } = await fetchSupabaseRest(buildRestUrl(query.table, params), {
    method: "POST",
    headers: {
      ...buildBaseHeaders(),
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(query.values),
  });
  if (!response.ok) {
    throw new Error(`Supabase upsert failed (${response.status}): ${text}`);
  }
  const payload = text.length > 0 ? (JSON.parse(text) as T[]) : null;
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error(`Supabase upsert returned no rows for table ${query.table}.`);
  }
  return payload[0] as T;
}

export async function supabaseUpdateAndSelectOne<T>(query: SupabaseUpdateQuery): Promise<T> {
  const params = buildQueryParams(query.filters);
  const { response, text } = await fetchSupabaseRest(buildRestUrl(query.table, params), {
    method: "PATCH",
    headers: {
      ...buildBaseHeaders(),
      Prefer: "return=representation",
    },
    body: JSON.stringify(query.values),
  });
  if (!response.ok) {
    throw new Error(`Supabase update failed (${response.status}): ${text}`);
  }
  const payload = text.length > 0 ? (JSON.parse(text) as T[]) : null;
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error(`Supabase update returned no rows for table ${query.table}.`);
  }
  return payload[0] as T;
}

export async function supabaseDelete(query: SupabaseDeleteQuery): Promise<void> {
  const params = buildQueryParams(query.filters);
  const { response, text } = await fetchSupabaseRest(buildRestUrl(query.table, params), {
    method: "DELETE",
    headers: {
      ...buildBaseHeaders(),
      Prefer: "return=minimal",
    },
  });

  if (!response.ok) {
    throw new Error(`Supabase delete failed (${response.status}): ${text}`);
  }
}

export async function supabaseSelect<T>(query: SupabaseSelectQuery): Promise<T[]> {
  const params = buildQueryParams(query.filters, query.order, query.limit);
  params.set("select", query.select);

  const headers = buildBaseHeaders();
  if (query.single === "single") {
    headers.Accept = "application/vnd.pgrst.object+json";
  }

  const { response, text } = await fetchSupabaseRest(buildRestUrl(query.table, params), {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    if (query.single === "maybeSingle" && response.status === 406) {
      return [];
    }
    throw new Error(`Supabase select failed (${response.status}): ${text}`);
  }

  const data = text.length > 0 ? JSON.parse(text) : null;
  if (!Array.isArray(data)) {
    return data ? [data as T] : [];
  }
  return data as T[];
}
