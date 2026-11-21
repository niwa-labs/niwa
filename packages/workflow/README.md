# @niwa-labs/workflow

Durable workflows: the runner, the static check, the registry and store, branch scopes, and candidate versions.

A workflow is a script that niwa runs in a disposable process and answers call by call, so a run
survives the death of the host and resumes from its journal. Registered versions keep a copy of
their source under the home. Plugins hand it scripts of their own through the `BUILTIN_WORKFLOW`
offer.

The module reads the record types and the offers of the plugins installed before it, so install
`timers` and every plugin that offers a built-in workflow ahead of `workflow()`.

The `./records` entry exports the records, the action references and the pure readers of runs,
installations and versions, for plugins that read workflows without importing the module itself.
