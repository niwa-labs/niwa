/**
 * Page paths. A path is a pattern of literal segments and `$name` parameters, such as
 * `/runs/$runId`; its parameters are typed from the pattern itself.
 */

type Segments<P extends string> = P extends `${infer Head}/${infer Tail}` ? Head | Segments<Tail> : P;
type ParamOf<S extends string> = S extends `$${infer Name}` ? Name : never;

/** The parameters of a path pattern: `PathParams<"/runs/$runId">` is `{ runId: string }`. */
export type PathParams<P extends string> = { [K in ParamOf<Segments<P>>]: string };

/** The query of a page address, as strings. */
export type SearchParams = Readonly<Record<string, string>>;

const SEGMENT = /^(?:\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9._~-]+)$/;

/** Why a path pattern is not valid, or undefined when it is. */
export function pathProblem(pattern: string): string | undefined {
  if (!pattern.startsWith("/")) return `a page path must start with "/": ${pattern}`;
  if (pattern === "/") return undefined;
  if (pattern.endsWith("/")) return `a page path must not end with "/": ${pattern}`;
  const names = new Set<string>();
  for (const segment of pattern.slice(1).split("/")) {
    if (!SEGMENT.test(segment)) return `a page path has an invalid segment "${segment}": ${pattern}`;
    if (segment.startsWith("$")) {
      if (names.has(segment)) return `a page path repeats the parameter ${segment}: ${pattern}`;
      names.add(segment);
    }
  }
  return undefined;
}

/**
 * The shape of a pattern with parameter names erased and letters lowered: two patterns that a
 * router matching without regard to case would confuse share it.
 */
export function pathShape(pattern: string): string {
  return pattern.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "$").toLowerCase();
}

/** The address of a page: the pattern with its parameters filled in, and an optional query. */
export function pathFor<P extends string>(pattern: P, params: PathParams<P>, search?: Record<string, string | undefined>): string {
  const values = params as Record<string, string>;
  const path = pattern.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === "") throw new TypeError(`the path ${pattern} needs the parameter ${name}`);
    return encodeURIComponent(value);
  });
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search ?? {})) if (value !== undefined) query.set(key, value);
  const text = query.toString();
  return text === "" ? path : `${path}?${text}`;
}

/** The parameters of a path if it matches the pattern, or undefined. */
export function matchPath<P extends string>(pattern: P, path: string): PathParams<P> | undefined {
  const want = pattern === "/" ? [] : pattern.slice(1).split("/");
  const bare = path.split(/[?#]/, 1)[0] ?? "";
  const have = bare === "/" ? [] : bare.replace(/\/+$/, "").slice(1).split("/");
  if (want.length !== have.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    const w = want[i]!;
    const h = have[i]!;
    if (w.startsWith("$")) {
      if (h === "") return undefined;
      try {
        params[w.slice(1)] = decodeURIComponent(h);
      } catch {
        return undefined;
      }
    } else if (w !== h) {
      return undefined;
    }
  }
  return params as PathParams<P>;
}
