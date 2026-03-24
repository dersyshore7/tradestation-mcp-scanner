export type VercelRequestLike = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
};

export type VercelResponseLike = {
  status: (code: number) => VercelResponseLike;
  json: (body: unknown) => void;
  setHeader?: (name: string, value: string) => void;
};

function toSerializableJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function sendJson(res: VercelResponseLike, statusCode: number, body: unknown): void {
  res.setHeader?.("content-type", "application/json; charset=utf-8");
  res.status(statusCode).json(toSerializableJsonValue(body));
}

export function sendError(res: VercelResponseLike, statusCode: number, message: string): void {
  sendJson(res, statusCode, {
    error: true,
    message,
  });
}
