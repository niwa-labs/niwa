# @niwa-labs/tasks

Tracked tasks: a task is a contract (what to do, who asked, who is responsible, where to report) and the records that say how it went. A task is created with `task.create`, reported on with `task.report`, and ended once with `task.finish` or `task.fail`; `task.result` gives the outcome and waits for it. The assignment, the updates and the outcome travel as messages, sent through the messages module.

The root entry holds the plugin, the executor and the strategy contract; `@niwa-labs/tasks/records` holds the records, the typed action references and the functions that fold the state of a task from the journal, which other plugins may import.
