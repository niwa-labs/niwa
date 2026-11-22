# Notices for bundled assets

Vite reads package licenses from installed JavaScript dependencies. These
copies cover files that upstream bundles inside those dependencies or
licenses that upstream references by URL.

- Shiki 4.6.0 bundles TextMate grammars and themes. The source release's
  [lockfile](https://github.com/shikijs/shiki/blob/v4.6.0/pnpm-lock.yaml)
  pins [tm-grammars 1.32.22](https://registry.npmjs.org/tm-grammars/-/tm-grammars-1.32.22.tgz)
  and [tm-themes 1.12.12](https://registry.npmjs.org/tm-themes/-/tm-themes-1.12.12.tgz).
  Each `.NOTICE` file is the corresponding npm tarball's `package/NOTICE`.
  The pinned source locations in `textmate-source-revisions.txt` come from
  the same tarballs' `package/index.js` metadata.
- The same lockfile pins [vscode-oniguruma 1.7.0](https://registry.npmjs.org/vscode-oniguruma/-/vscode-oniguruma-1.7.0.tgz).
  Its WebAssembly binary is embedded in Shiki's Oniguruma engine. The two
  `vscode-oniguruma` files come from that exact npm tarball.
- `apache-2.0.txt` is the [Apache Software Foundation's full license text](https://www.apache.org/licenses/LICENSE-2.0.txt).
  It accompanies package-level notices that use the Apache 2.0 boilerplate.

Refresh these files and the Shiki version check in the build plugin when
updating Shiki. The build emits just the relevant texts alongside the app.
