/**
 * How a box gets its access: profiles taken by name, paths asked for, and the plan they resolve to.
 *
 * A caller lists what its box should have: `"project"` (the working directory, writable),
 * `"toolchains"` (the PATH, Homebrew and the catalog's programs, readable), a profile by its name,
 * or a path (`{ read }`, `{ write }`) or a host (`{ net }`). `allow` adds to the host's default and
 * `only` replaces it. The host's sandbox (`sandbox({ profiles })`) knows every profile: the catalog,
 * the host's own, and the profile of each harness installation.
 *
 * The plan holds three things. The paths the box may use, each with where it came from, are
 * guaranteed to be reachable. The closed paths are guaranteed not to be: every path a profile names
 * is closed to every box that did not take that profile, and so is the closed list (the user's keys
 * and niwa's own secrets) unless a path in it is asked for by name. The rest is the sandbox's own:
 * srt reads everything else, nono nothing else. A sandbox that cannot hold the plan refuses it.
 *
 * Widening a box beyond the host's default takes a rule of the caller's grant: `box.use@<profile>`,
 * `box.read@<path>`, `box.write@<path>`, `box.net@<host>`. The plan names the rules it needs; the
 * caller holds them against the grant, since the sandbox knows nothing of grants.
 */

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { covers, homeExpanded, linkPlace, programPaths, realPlace, resolveProfile } from "./profile.ts";
import type { BoxProfile, ResolvedProfile } from "./profile.ts";
import { catalog } from "./profiles.ts";
import { BoxRefused } from "./sandbox.ts";
import type { BoxPolicy, BoxRefusal, Sandbox, SandboxManifest } from "./sandbox.ts";
import { EnvNameSchema, boxSpec } from "./spec.ts";
import type { BoxSpec } from "./spec.ts";
import type { BoxSandboxName } from "./launch.ts";

/**
 * The names of the profiles a box may take. The catalog's are here; a host or a plugin that adds a
 * profile adds its name by declaration merging, so a request is checked as it is written:
 *
 * ```ts
 * declare module "@niwa-labs/sandbox" { interface BoxProfiles { pnpm: true } }
 * ```
 */
export interface BoxProfiles {
  git: true;
  node: true;
  bun: true;
  npm: true;
  cargo: true;
  uv: true;
}

/** The name of a profile a box may take. */
export type ProfileName = keyof BoxProfiles & string;

/** One thing a box asks for. */
export type AccessItem =
  | "project"
  | "toolchains"
  | ProfileName
  | { readonly read: string }
  | { readonly write: string }
  | { readonly net: string };

/** What a box asks for: `allow` adds to the host's default, `only` replaces it. */
export type BoxAccess =
  | { readonly allow?: readonly AccessItem[]; readonly only?: undefined }
  | { readonly only: readonly AccessItem[]; readonly allow?: undefined };

/** An item as it travels: a name is any text until the host's profiles have checked it. */
export const AccessItemSchema = z.union([
  z.string().min(1),
  z.strictObject({ read: z.string().min(1) }),
  z.strictObject({ write: z.string().min(1) }),
  z.strictObject({ net: z.string().regex(/^\S+$/, "a host must be non-empty and contain no whitespace") }),
]);
export type AccessItemInput = z.output<typeof AccessItemSchema>;

/** A request as it travels: `allow` or `only`, not both. */
export const BoxAccessSchema = z
  .strictObject({ allow: z.array(AccessItemSchema).optional(), only: z.array(AccessItemSchema).optional() })
  .refine((access) => access.allow === undefined || access.only === undefined, "a box takes allow or only, not both");
export type BoxAccessInput = z.output<typeof BoxAccessSchema>;

/** Where a path, a host or an item of a box came from. */
export type Origin = string;

export interface PathNeed {
  readonly path: string;
  readonly mode: "read" | "write";
  readonly from: Origin;
}

export interface Skipped {
  readonly place: string;
  readonly from: Origin;
  readonly why: string;
}

/** A box resolved: what it may use, what it may not, what was left out and the rules it needs. */
export interface BoxPlan {
  readonly cwd: string;
  /** The request after the host's default: every item and whether the host or the call gave it. */
  readonly request: { readonly mode: "allow" | "only"; readonly items: readonly { readonly item: AccessItemInput; readonly from: "host" | "call" }[] };
  /** Guaranteed reachable. */
  readonly paths: readonly PathNeed[];
  readonly net: readonly { readonly host: string; readonly from: Origin }[];
  /** Guaranteed closed. */
  readonly closed: readonly { readonly path: string; readonly from: Origin }[];
  readonly skipped: readonly Skipped[];
  /** The rules of a grant the call's widening needs, one per item beyond the host's default. */
  readonly rules: readonly string[];
  /** What keeps the plan from being a box, whatever the sandbox. */
  readonly refusals: readonly BoxRefusal[];
}

/** What a host's sandbox is made with. */
export interface SandboxOptions {
  /** The sandbox boxes run in. Default: each module's own (sessions srt, proc nono). */
  readonly adapter?: BoxSandboxName | Sandbox;
  /** Profiles besides the catalog's, by name. A name of the catalog given again replaces it. */
  readonly profiles?: { readonly [Name in ProfileName]?: BoxProfile } & Readonly<Record<string, BoxProfile>>;
  /** Places closed to every box besides the built-in list, unless a box asks for one by name. */
  readonly closed?: readonly string[];
}

/** What one box is resolved from. */
export interface PlanInput {
  /** The working directory of the box, absolute. */
  readonly cwd: string;
  /** The host's default for this kind of box. */
  readonly defaults: BoxAccess | BoxAccessInput;
  /** What the call asked for. */
  readonly request?: BoxAccess | BoxAccessInput | undefined;
  /** The installation whose profile the box takes as its own, whatever the request says. */
  readonly owner?: string;
  /** Places the box writes whatever the request says, with where each came from. */
  readonly writes?: readonly { readonly path: string; readonly from: Origin }[];
  /** Places closed to the box besides the profiles' and the built-in list (niwa's own). */
  readonly closed?: readonly { readonly path: string; readonly from: Origin }[];
  /** Whether the box may reach a network at all. A box that may not refuses every host asked of it. */
  readonly network: boolean;
  /**
   * Why `"project"` gives nothing, when it does not: a box whose working directory nobody chose
   * (the host's own) is not given it to write. The item is kept as skipped, with this reason.
   */
  readonly noProject?: string;
}

/** A host's sandbox: its profiles, the closed list, and the plans of its boxes. */
export interface SandboxHost {
  readonly adapter: BoxSandboxName | Sandbox | undefined;
  /** The names of the profiles a box may ask for. */
  names(): readonly string[];
  /**
   * Gives the profile of a harness installation. It is no name a box may ask for: the sessions of
   * the installation take it, and every other box finds its paths closed.
   */
  install(owner: string, profile: BoxProfile): void;
  /** Resolves one box on this machine. */
  plan(input: PlanInput): BoxPlan;
}

/** Places that hold the user's keys: closed to every box unless it asks for one by name. */
export const ALWAYS_CLOSED: readonly string[] = ["~/.ssh", "~/.aws", "~/.gnupg", "~/Library/Keychains"];

const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** A place as a rule's target names it: `%` and the hex code for what a target cannot hold. */
export function placeTarget(path: string): string {
  const escaped = (char: string): string =>
    [...new TextEncoder().encode(char)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  return path.replace(/[\s*@:{}%]/g, escaped);
}

/** The text of an item, as an error or a CLI writes it. */
export function itemText(item: AccessItemInput): string {
  if (typeof item === "string") return item;
  if ("read" in item) return `read:${item.read}`;
  if ("write" in item) return `write:${item.write}`;
  return `net:${item.net}`;
}

/** An item from the text a command line gives: `read:<path>`, `write:<path>`, `net:<host>`, or a name. */
export function itemOf(text: string): AccessItemInput {
  for (const mode of ["read", "write", "net"] as const) {
    if (text.startsWith(`${mode}:`)) return { [mode]: text.slice(mode.length + 1) } as AccessItemInput;
  }
  return text;
}

/** The directory Homebrew is installed in, where there is one. */
function homebrewPrefix(env: Readonly<Record<string, string | undefined>>): string[] {
  const given = env["HOMEBREW_PREFIX"];
  if (given !== undefined && isAbsolute(given)) return [given];
  return ["/opt/homebrew"].filter((place) => existsSync(join(place, "bin", "brew")));
}

/** The place a path of a request names: from the working directory when relative, `~` expanded, links resolved. */
function placeOf(path: string, cwd: string, home: string): string {
  const expanded = homeExpanded(path, home);
  return realPlace(isAbsolute(expanded) ? expanded : resolve(cwd, expanded), home);
}

/** Makes a host's sandbox: the catalog, the host's profiles, and the closed list. */
export function sandbox(options: SandboxOptions = {}): SandboxHost {
  const profiles = new Map<string, BoxProfile>(Object.entries(catalog));
  for (const [name, profile] of Object.entries(options.profiles ?? {})) {
    if (!PROFILE_NAME.test(name)) throw new TypeError(`a profile name is lower-case letters, digits, ".", "_" and "-": ${JSON.stringify(name)}`);
    if (profile !== undefined) profiles.set(name, profile);
  }
  const installations = new Map<string, BoxProfile>();
  const extraClosed = options.closed ?? [];

  return {
    adapter: options.adapter,
    names: () => [...profiles.keys()],
    install(owner, profile) {
      installations.set(owner, profile);
    },
    plan(input) {
      return planBox(input, { profiles, catalog: new Set(Object.keys(catalog)), installations, closed: extraClosed });
    },
  };
}

interface Registry {
  readonly profiles: ReadonlyMap<string, BoxProfile>;
  /** The names of the catalog's profiles, whose read side the toolchains take. */
  readonly catalog: ReadonlySet<string>;
  readonly installations: ReadonlyMap<string, BoxProfile>;
  readonly closed: readonly string[];
}

/** The items of a request with where each came from, after the host's default. */
function merged(defaults: BoxAccess | BoxAccessInput, request: BoxAccess | BoxAccessInput | undefined): BoxPlan["request"] {
  const host = (defaults.allow ?? defaults.only ?? []).map((item) => ({ item: item as AccessItemInput, from: "host" as const }));
  if (request?.only !== undefined) return { mode: "only", items: request.only.map((item) => ({ item: item as AccessItemInput, from: "call" as const })) };
  return { mode: "allow", items: [...host, ...(request?.allow ?? []).map((item) => ({ item: item as AccessItemInput, from: "call" as const }))] };
}

function planBox(input: PlanInput, registry: Registry): BoxPlan {
  const home = homedir();
  const env = process.env;
  // The places of the box are decided on real paths; the box itself runs where it was asked to.
  const cwd = realPlace(input.cwd, home);
  const given = resolve(homeExpanded(input.cwd, home));
  const request = merged(input.defaults, input.request);
  const refusals: BoxRefusal[] = [];
  const skipped: Skipped[] = [];
  const paths: PathNeed[] = [];
  const net: { host: string; from: Origin }[] = [];

  const resolved = new Map<string, ResolvedProfile>();
  const profileOf = (name: string, profile: BoxProfile): ResolvedProfile => {
    let found = resolved.get(name);
    if (found === undefined) {
      const given = resolveProfile(profile, name, { home, env });
      // A program keeps the name it is found by: a link stays a link beside its target.
      const place = (path: string) => (given.programs.includes(path) ? linkPlace(path, home) : realPlace(path, home));
      found = {
        read: [...new Set(given.read.map(place))],
        write: [...new Set(given.write.map(place))],
        net: given.net,
        programs: [...new Set(given.programs.map(place))],
      };
      resolved.set(name, found);
    }
    return found;
  };

  // Every profile, resolved once: the ones taken give their paths, the others close theirs.
  const known = registry.profiles;
  const unknown = (name: string) => `${name} is no profile; the known ones are ${[...known.keys()].sort().join(", ")}, "project" and "toolchains"`;
  const taken = new Set<string>();
  for (const { item } of request.items) {
    if (typeof item !== "string" || item === "project" || item === "toolchains") continue;
    if (known.has(item)) taken.add(item);
    else refusals.push({ code: "unknown-profile", message: unknown(item) });
  }
  const ownerOrigin = input.owner === undefined ? undefined : `harness:${input.owner}`;
  const takenPaths: string[] = [];
  const addProfile = (from: Origin, profile: ResolvedProfile) => {
    for (const path of profile.read) paths.push({ path, mode: "read", from });
    for (const path of profile.write) paths.push({ path, mode: "write", from });
    for (const path of profile.programs) if (!profile.read.includes(path)) paths.push({ path, mode: "read", from });
    for (const host of profile.net) {
      if (input.network) net.push({ host, from });
      else skipped.push({ place: host, from, why: "this box reaches no network" });
    }
    takenPaths.push(...profile.read, ...profile.write);
  };
  if (input.owner !== undefined && ownerOrigin !== undefined) {
    const own = registry.installations.get(input.owner);
    if (own !== undefined) addProfile(ownerOrigin, profileOf(ownerOrigin, own));
  }
  for (const name of taken) {
    const profile = known.get(name);
    if (profile !== undefined) addProfile(`profile:${name}`, profileOf(`profile:${name}`, profile));
  }

  // Closed: what every other profile names (but its programs), unless a profile taken names it too.
  const closed: { path: string; from: Origin }[] = [];
  const others: [string, BoxProfile][] = [
    ...[...known].filter(([name]) => !taken.has(name)).map(([name, profile]): [string, BoxProfile] => [`profile:${name}`, profile]),
    ...[...registry.installations].filter(([owner]) => owner !== input.owner).map(([owner, profile]): [string, BoxProfile] => [`harness:${owner}`, profile]),
  ];
  // The toolchains take what each profile of the catalog reads (its program, its configuration), never
  // what it writes: a tool runs, its caches and its credentials stay its own. A host's own profiles
  // are not theirs to open: what one reads may be a token.
  const withToolchains = request.items.some(({ item }) => item === "toolchains");
  for (const [from, profile] of others) {
    const of = profileOf(from, profile);
    const read = withToolchains && from.startsWith("profile:") && registry.catalog.has(from.slice("profile:".length)) ? [] : of.read;
    for (const path of [...read, ...of.write]) {
      if (of.programs.includes(path)) continue;
      if (takenPaths.some((mine) => covers(mine, path))) continue;
      closed.push({ path, from });
    }
  }
  // The closed list: open only where the box names a place in it, from the host's default or a call.
  const explicit = request.items.flatMap(({ item }) =>
    typeof item === "object" && !("net" in item) ? [placeOf("read" in item ? item.read : item.write, cwd, home)] : [],
  );
  const always = [
    ...[...ALWAYS_CLOSED, ...registry.closed].map((path) => ({ path: realPlace(path, home), from: "closed" })),
    ...(input.closed ?? []).map((one) => ({ path: realPlace(one.path, home), from: one.from })),
  ];
  for (const one of always) {
    if (explicit.some((place) => place === one.path)) continue;
    closed.push(one);
  }
  const closedAt = (place: string) => closed.find((one) => covers(one.path, place));

  // The items: what each gives, and whether the host's default already gave it.
  const defaults = request.mode === "allow" ? request.items.filter((one) => one.from === "host") : merged(input.defaults, undefined).items;
  const defaultPlaces = (mode: "read" | "write"): string[] =>
    defaults.flatMap(({ item }) => {
      if (item === "project") return [cwd];
      if (typeof item === "string") {
        const profile = known.get(item);
        if (profile === undefined) return [];
        const of = profileOf(`profile:${item}`, profile);
        return mode === "read" ? [...of.read, ...of.write, ...of.programs] : [...of.write];
      }
      if ("net" in item) return [];
      if ("write" in item) return [placeOf(item.write, cwd, home)];
      return mode === "read" ? [placeOf(item.read, cwd, home)] : [];
    });
  const defaultNames = new Set(defaults.flatMap(({ item }) => (typeof item === "string" ? [item] : [])));
  const defaultHosts = new Set(defaults.flatMap(({ item }) => (typeof item === "object" && "net" in item ? [item.net] : [])));
  const rules: string[] = [];
  const needs = (free: boolean, rule: string) => {
    if (!free && !rules.includes(rule)) rules.push(rule);
  };

  for (const { item, from } of request.items) {
    const fromCall = from === "call";
    if (item === "project") {
      if (input.noProject !== undefined) skipped.push({ place: cwd, from: "project", why: input.noProject });
      else paths.push({ path: cwd, mode: "write", from: "project" });
      if (fromCall) needs(defaultNames.has("project"), "box.use@project");
    } else if (item === "toolchains") {
      for (const [name, profile] of known) {
        if (!registry.catalog.has(name)) continue;
        const of = profileOf(`profile:${name}`, profile);
        for (const path of of.read) if (!of.write.some((written) => covers(written, path))) paths.push({ path, mode: "read", from: "toolchains" });
      }
      for (const place of toolchains(env, home, [...known.keys()])) {
        const inside = closedAt(place.path);
        const holds = closed.find((one) => covers(place.path, one.path));
        if (place.path === "/" || covers(place.path, home)) skipped.push({ place: place.path, from: "toolchains", why: "it holds the home directory" });
        else if (inside !== undefined) skipped.push({ place: place.path, from: "toolchains", why: `it lies in ${inside.path}, which is closed` });
        else if (holds !== undefined && !place.program) skipped.push({ place: place.path, from: "toolchains", why: `it holds ${holds.path}, which is closed` });
        else paths.push({ path: place.path, mode: "read", from: "toolchains" });
      }
      if (fromCall) needs(defaultNames.has("toolchains"), "box.use@toolchains");
    } else if (typeof item === "string") {
      if (fromCall && known.has(item)) needs(defaultNames.has(item), `box.use@${item}`);
    } else if ("net" in item) {
      if (!input.network) {
        refusals.push({ code: "no-network", message: `${item.net} cannot be reached: this box reaches no network` });
        continue;
      }
      net.push({ host: item.net, from });
      if (fromCall) needs(defaultHosts.has(item.net), `box.net@${item.net}`);
    } else {
      const mode = "write" in item ? "write" : "read";
      const place = placeOf("write" in item ? item.write : item.read, cwd, home);
      const inside = closedAt(place);
      if (inside !== undefined && (inside.from.startsWith("profile:") || inside.from.startsWith("harness:"))) {
        const owner = inside.from.slice(inside.from.indexOf(":") + 1);
        const how = inside.from.startsWith("profile:") ? `take the profile ${owner}` : `only the sessions of ${owner} see it`;
        refusals.push({ code: "closed", message: `${place} is a place of ${inside.from}: ${how}` });
        continue;
      }
      paths.push({ path: place, mode, from });
      // A place in the closed list is never the default's to give unless the default names it too.
      const entry = always.find((one) => covers(one.path, place));
      const given = defaultPlaces(mode).filter((one) => entry === undefined || covers(entry.path, one));
      const free = given.some((one) => covers(one, place));
      if (fromCall) needs(free, `box.${mode}@${placeTarget(place)}`);
    }
  }
  for (const write of input.writes ?? []) paths.push({ path: realPlace(write.path, home), mode: "write", from: write.from });
  // A box that writes its working directory may commit there: what git keeps of it outside, it gets.
  if (paths.some((need) => need.mode === "write" && covers(need.path, cwd))) {
    for (const need of repositoryOf(cwd)) if (!paths.some((one) => one.mode === "write" && covers(one.path, need.path))) paths.push(need);
  }

  return { cwd: given, request, paths: distinctNeeds(paths), net: distinctHosts(net), closed, skipped, rules, refusals };
}

/** The needs with each path once, writable when any need writes it, from the first that named it. */
function distinctNeeds(needs: readonly PathNeed[]): PathNeed[] {
  const out = new Map<string, PathNeed>();
  for (const need of needs) {
    const before = out.get(need.path);
    if (before === undefined) out.set(need.path, need);
    else if (before.mode === "read" && need.mode === "write") out.set(need.path, need);
  }
  return [...out.values()];
}

function distinctHosts(hosts: readonly { host: string; from: Origin }[]): { host: string; from: Origin }[] {
  const seen = new Set<string>();
  return hosts.filter((one) => (seen.has(one.host) ? false : (seen.add(one.host), true)));
}

/**
 * What git needs of the repository a directory is in, where it lies outside the directory: the
 * repository's own git directory to write (a worktree's lies in the main repository's), and of the
 * directory it shares with the main checkout the objects, the refs and their logs to write and the
 * rest (its configuration, its hooks) to read. Found on disk, without running git.
 */
export function repositoryOf(dir: string): PathNeed[] {
  for (let at = dir; ; at = dirname(at)) {
    const dot = join(at, ".git");
    let found: ReturnType<typeof lstatSync> | undefined;
    try {
      found = lstatSync(dot);
    } catch {
      found = undefined;
    }
    if (found !== undefined) {
      let gitDir = dot;
      if (found.isFile()) {
        const named = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
        if (named === undefined) return [];
        gitDir = realPlace(resolve(at, named));
      }
      const pointer = join(gitDir, "commondir");
      const common = existsSync(pointer) ? realPlace(resolve(gitDir, readFileSync(pointer, "utf8").trim())) : gitDir;
      const outside = (path: string) => !covers(dir, path);
      const needs: PathNeed[] = [];
      if (outside(gitDir)) needs.push({ path: gitDir, mode: "write", from: "repository" });
      if (common !== gitDir && outside(common)) {
        needs.push({ path: common, mode: "read", from: "repository" });
        for (const part of ["objects", "refs", "logs"]) needs.push({ path: join(common, part), mode: "write", from: "repository" });
      }
      return needs;
    }
    if (dirname(at) === at) return [];
  }
}

/** The places `toolchains` reads: the PATH, Homebrew, and the programs of every profile a box may ask for. */
function toolchains(env: Readonly<Record<string, string | undefined>>, home: string, names: readonly string[]): { path: string; program: boolean }[] {
  const dirs = [...(env["PATH"] ?? "").split(":"), ...homebrewPrefix(env)].filter((dir) => isAbsolute(dir));
  const out: { path: string; program: boolean }[] = [];
  const seen = new Set<string>();
  const add = (path: string, program: boolean) => {
    const real = program ? linkPlace(path, home) : realPlace(path, home);
    if (seen.has(real)) return;
    seen.add(real);
    out.push({ path: real, program });
  };
  for (const dir of dirs) if (exists(dir)) add(dir, false);
  for (const name of names) for (const path of programPaths(name, env)) add(path, true);
  return out;
}

function exists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The spec a plan makes, with what the box is started with besides. */
export function planSpec(plan: BoxPlan, extra: { readonly env?: Readonly<Record<string, string>>; readonly sockets?: readonly string[] } = {}): BoxSpec {
  return boxSpec({
    cwd: plan.cwd,
    read: plan.paths.filter((need) => need.mode === "read").map((need) => need.path),
    write: plan.paths.filter((need) => need.mode === "write").map((need) => need.path),
    closed: [...new Set(plan.closed.map((one) => one.path))],
    net: plan.net.map((one) => one.host),
    env: { ...extra.env },
    sockets: [...(extra.sockets ?? [])],
  });
}

/** The policy as a record holds it. */
export const BoxPolicySchema = z.object({
  write: z.array(z.string()),
  devices: z.array(z.string()),
  read: z.union([z.object({ only: z.array(z.string()) }), z.object({ except: z.array(z.string()) })]),
  net: z.array(z.string()),
});

/**
 * The manifest of a box, as it is recorded: the request with where each item came from, the paths
 * it resolved to and where each came from, what was closed and left out, the rules of the grant it
 * took, and the policy the sandbox reports it applies. The environment is its names, never a value.
 */
export const BoxManifestSchema = z.object({
  sandbox: z.string().min(1),
  /** The working directory of the box. */
  cwd: z.string().min(1),
  request: z.object({
    mode: z.enum(["allow", "only"]),
    items: z.array(z.object({ item: AccessItemSchema, from: z.enum(["host", "call"]) })),
  }),
  paths: z.array(z.object({ path: z.string(), mode: z.enum(["read", "write"]), from: z.string() })),
  net: z.array(z.object({ host: z.string(), from: z.string() })),
  closed: z.array(z.object({ path: z.string(), from: z.string() })),
  skipped: z.array(z.object({ place: z.string(), from: z.string(), why: z.string() })),
  rules: z.array(z.string()),
  policy: BoxPolicySchema,
  env: z.array(EnvNameSchema),
});
export type BoxManifest = z.output<typeof BoxManifestSchema>;

/** The manifest of a box from its plan, the grant's rules it took, and what the sandbox reports. */
export function boxManifest(plan: BoxPlan, rules: readonly string[], made: SandboxManifest): BoxManifest {
  const policy: BoxPolicy = made.policy ?? { write: [], devices: [], read: { except: [] }, net: [] };
  return {
    sandbox: made.sandbox,
    cwd: plan.cwd,
    request: { mode: plan.request.mode, items: plan.request.items.map((one) => ({ item: one.item, from: one.from })) },
    paths: [...plan.paths],
    net: [...plan.net],
    closed: [...plan.closed],
    skipped: [...plan.skipped],
    rules: [...rules],
    policy: {
      write: [...policy.write],
      devices: [...policy.devices],
      read: "only" in policy.read ? { only: [...policy.read.only] } : { except: [...policy.read.except] },
      net: [...policy.net],
    },
    env: Object.keys(made.env).map((name) => EnvNameSchema.parse(name)),
  };
}

/**
 * Admits a plan into a sandbox, or refuses it with every reason at once: what kept the plan from
 * being a box, each rule the grant lacks, and whatever the sandbox cannot hold. `held` answers, for
 * a rule the plan needs, the rule of the grant that covers it, or undefined.
 */
export function admit(
  plan: BoxPlan,
  sandbox: Sandbox,
  held: (rule: string) => string | undefined,
  extra: { readonly env?: Readonly<Record<string, string>>; readonly sockets?: readonly string[] } = {},
): { readonly spec: BoxSpec; readonly manifest: SandboxManifest; readonly rules: readonly string[] } {
  const reasons: BoxRefusal[] = [...plan.refusals];
  const used: string[] = [];
  for (const rule of plan.rules) {
    const by = held(rule);
    if (by === undefined) reasons.push({ code: "not-granted", message: `it is wider than the host's default and the grant has no ${rule}`, rule });
    else if (!used.includes(by)) used.push(by);
  }
  const spec = planSpec(plan, extra);
  let manifest: SandboxManifest | undefined;
  try {
    manifest = sandbox.manifest(spec);
  } catch (error) {
    if (!(error instanceof BoxRefused)) throw error;
    reasons.push(...error.reasons);
  }
  if (reasons.length > 0 || manifest === undefined) throw new BoxRefused(reasons, sandbox.name);
  return { spec, manifest, rules: used };
}
