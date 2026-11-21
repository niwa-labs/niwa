/**
 * The catalog: profiles of the common tools, as data.
 *
 * Each names the program and the places the tool keeps its configuration and its caches under the
 * user's home. A box that takes a profile gets those places; a box that does not take it finds them
 * closed, but for what the profile reads (its program, its configuration) when the box takes the
 * toolchains: a tool runs there, and what it writes stays closed. The catalog is small on purpose:
 * a host or a plugin adds the tools it needs with `sandbox({ profiles })`.
 */

import type { BoxProfile } from "./profile.ts";

export type { BoxProfile, ProfileContext, ProfilePaths } from "./profile.ts";

/**
 * git: the program and the user's configuration, its ignores and attributes. The credentials git's
 * store keeps are written by it, so they stay git's: a box that does not take git does not read them.
 */
export const git: BoxProfile = ({ home, env, bin }) => {
  const config = `${env["XDG_CONFIG_HOME"] ?? `${home}/.config`}/git`;
  return {
    read: [...bin("git"), `${home}/.gitconfig`, `${config}/config`, `${config}/ignore`, `${config}/attributes`],
    write: [`${home}/.git-credentials`, `${config}/credentials`],
  };
};

/** node: the runtime. */
export const node: BoxProfile = ({ bin }) => ({ read: bin("node") });

/** bun: the runtime, its configuration and its install cache. */
export const bun: BoxProfile = ({ home, env, bin }) => ({
  read: [...bin("bun"), `${home}/.bunfig.toml`],
  write: [env["BUN_INSTALL_CACHE_DIR"] ?? `${env["BUN_INSTALL"] ?? `${home}/.bun`}/install/cache`],
});

/**
 * npm: the program, the runtime it runs on, the cache, and the user's configuration, which npm
 * writes (`npm login`, `npm config set`) and which may hold a registry's token: a box that does not
 * take npm does not read it, toolchains or not.
 */
export const npm: BoxProfile = ({ home, env, bin }) => ({
  read: [...bin("npm"), ...bin("node")],
  write: [env["npm_config_cache"] ?? env["NPM_CONFIG_CACHE"] ?? `${home}/.npm`, env["NPM_CONFIG_USERCONFIG"] ?? `${home}/.npmrc`],
});

/** cargo: the programs, the toolchains rustup installed, and the registry and git caches. */
export const cargo: BoxProfile = ({ home, env, bin }) => {
  const cargoHome = env["CARGO_HOME"] ?? `${home}/.cargo`;
  return {
    read: [...bin("cargo"), ...bin("rustc"), `${cargoHome}/config.toml`, env["RUSTUP_HOME"] ?? `${home}/.rustup`],
    write: [`${cargoHome}/registry`, `${cargoHome}/git`],
  };
};

/** uv: the program, its configuration, the Pythons it installs and its cache. */
export const uv: BoxProfile = ({ home, env, bin }) => ({
  read: [...bin("uv"), `${env["XDG_CONFIG_HOME"] ?? `${home}/.config`}/uv`],
  write: [env["UV_CACHE_DIR"] ?? `${env["XDG_CACHE_HOME"] ?? `${home}/.cache`}/uv`, env["UV_PYTHON_INSTALL_DIR"] ?? `${env["XDG_DATA_HOME"] ?? `${home}/.local/share`}/uv`],
});

/** Every profile of the catalog, by its name. */
export const catalog = { git, node, bun, npm, cargo, uv } as const satisfies Readonly<Record<string, BoxProfile>>;
