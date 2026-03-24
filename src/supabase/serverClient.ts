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

export async function supabaseInsertAndSelectOne<T>(query: SupabaseInsertQuery): Promise<T> {
  const params = new URLSearchParams();
  const response = await fetch(buildRestUrl(query.table, params), {
    method: "POST",
    headers: {
      ...buildBaseHeaders(),
      Prefer: "return=representation",
    },
    body: JSON.stringify(query.values),
  });
  const text = await response.text();
  const payload = text.length > 0 ? (JSON.parse(text) as T[]) : null;
  if (!response.ok) {
    throw new Error(`Supabase insert failed (${response.status}): ${text}`);
  }
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error(`Supabase insert returned no rows for table ${query.table}.`);
  }
  return payload[0] as T;
}

export async function supabaseSelect<T>(query: SupabaseSelectQuery): Promise<T[]> {
  const params = new URLSearchParams();
  params.set("select", query.select);
  for (const filter of query.filters ?? []) {
    const [key, value] = filter.split("=", 2);
    if (!key || value === undefined) {
      continue;
    }
    params.set(key, value);
  }
  for (const order of query.order ?? []) {
    params.append("order", order);
  }
  if (typeof query.limit === "number") {
    params.set("limit", String(query.limit));
  }

  const headers = buildBaseHeaders();
  if (query.single === "single") {
    headers.Accept = "application/vnd.pgrst.object+json";
  }

  const response = await fetch(buildRestUrl(query.table, params), {
    method: "GET",
    headers,
  });
  const text = await response.text();

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
