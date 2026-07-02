/**
 * Parse a request's JSON body without letting a malformed payload throw. An
 * uncaught `req.json()` rejection surfaces as an opaque 500, when the client
 * really sent a bad request — so a parse failure returns a 400 `Response` the
 * handler returns as-is. An optional `validate` predicate runs against the
 * parsed body; failing it is a 400 too. The body is cast to `T` on the caller's
 * say-so (the bare `as` casts did the same), but now only after a successful
 * parse, and after `validate` when one is supplied.
 *
 * Usage:
 *   const body = await readJsonBody<MyShape>(req, isObject);
 *   if (body instanceof Response) return body;
 */
export async function readJsonBody<T>(
  req: Request,
  validate?: (body: unknown) => boolean,
): Promise<T | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', {status: 400});
  }
  if (validate && !validate(body)) {
    return new Response('Invalid request body', {status: 400});
  }
  return body as T;
}

/** A non-null, non-array JSON object — what every route body here expects. */
export function isObject(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

/** Whether `v` is an array of strings (a common request-body field). */
export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Guard for the common `{files: string[]}` body. Extra fields (e.g. `dryRun`,
 *  `toPeer`) are allowed; the caller validates those itself. */
export function hasStringFiles(body: unknown): boolean {
  return isObject(body) && isStringArray(body.files);
}

/** Like `hasStringFiles`, but `files` may also be absent — for routes that
 *  treat a missing selection as "none" (`new Set(files ?? [])`). Rejects a
 *  present-but-non-array `files`, which would otherwise throw at the `Set`. */
export function hasOptionalStringFiles(body: unknown): boolean {
  return (
    isObject(body) && (body.files === undefined || isStringArray(body.files))
  );
}
