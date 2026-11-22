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
  the same tarballs' `package/index.js` metadata. Only reviewed grammar and
  theme payloads enter the browser bundle. The built report includes the
  relevant license sections, plus separate complete grants for the pinned
  [YAML](https://github.com/textmate/yaml.tmbundle/blob/e54ceae3b719506dba7e481a77cea4a8b576ae46/README.mdown)
  and [TOML](https://github.com/textmate/toml.tmbundle/blob/e82b64c1e86396220786846201e9aa3f0a2d9ca2/README.mdown)
  bundles and the relevant sections from [VS Code's downstream notices](https://github.com/microsoft/vscode/blob/af600487b1e94374d9f48f57cbf2cad24656b07f/ThirdPartyNotices.txt).
  Pierre Highlights uses its own tokenizer and the Pierre light and dark themes.
- The same lockfile pins [vscode-oniguruma 1.7.0](https://registry.npmjs.org/vscode-oniguruma/-/vscode-oniguruma-1.7.0.tgz).
  Its WebAssembly binary is embedded in Shiki's Oniguruma engine. The two
  `vscode-oniguruma` files come from that exact npm tarball.
- `apache-2.0.txt` is the [Apache Software Foundation's full license text](https://www.apache.org/licenses/LICENSE-2.0.txt).
  It accompanies package-level notices that use the Apache 2.0 boilerplate.

Refresh these files, the Shiki version check and the reviewed catalog when
updating Shiki. The build emits just the relevant texts alongside the app.
