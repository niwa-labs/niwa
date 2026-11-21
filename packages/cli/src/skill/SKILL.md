---
name: niwa
description: >-
  Use niwa, the owner's local agent host, for work that reaches beyond this session: start, resume,
  message, read or search sessions of other coding agents (Claude Code, Codex, pi, mcode, ...), ask
  the owner a question and get a typed answer, create and report on tracked tasks, write and run
  durable workflow scripts. Activate when niwa MCP tools are present (session_start, message_send,
  task_create, request_ask, workflow_start, ...) and the work needs one; when the user mentions
  niwa, its host or cockpit, or an id like run-, req-, task-, wf-, s-, msg-, sub-; or when your
  prompt says niwa started you. Do not activate for this harness's own subagents, todo lists or
  workflow tools, or for work you can finish alone in this session.
---

# niwa

niwa is the owner's local host: one background process that owns a journal and exposes typed
actions named `<group>.<action>`. Through it you reach other agents' sessions, the owner, tracked
tasks and durable workflow scripts.

This file ships inside niwa (`niwa skill` prints the current text). It names things; the host
defines them. Where this file and the host disagree, the host is right.

## Reach it

- **MCP.** If tools such as `session_start` or `task_create` are in your tool list, use them. A tool
  name is the action name with `.` and `-` written as `_` (`session.open-questions` is
  `session_open_questions`).
- **CLI otherwise.** `niwa <group>.<action> --field value ...`, for example
  `niwa task.get --id task-3f9a21`. A field that is an object or a list takes JSON
  (`--visible '{"actions":["task.*"]}'`), or give the whole input at once with `--input '{...}'`.
  `--json` goes before the command and asks for the machine form: `niwa --json harness.list`.
- **Is the host up:** `niwa status`.
- You see the actions that whoever started you made visible. That set is your mandate. Do not route
  around it through another surface.

Below, actions are written `group.action`; translate to your surface.

## First moves

Once per session, before the first real call:

1. `niwa status` - the host is up, and which plugins it runs.
2. `niwa help` lists every action of the host and its fields. On MCP the tool list is the same thing. For the full input schema of an action:
   `niwa --json niwa.describe`. Never guess a field name; read it there.
3. `harness.list`, then `harness.get --name <name>` - the harness instances you may start sessions
   on (names look like `claude-sonnet`, `codex-luna`), with their kind and the options block they
   take.
4. Before any workflow work: `workflow.guide`.

## Use niwa, or do it yourself

Use niwa when the work:
- needs another harness or model (an independent review, a second opinion, parallel work);
- needs the owner's decision;
- must be visible to the owner or outlive your session (a task);
- is a multi-step procedure that must survive a restart or be repeated (a workflow);
- needs what other sessions already did (session search and read).

Do it yourself when your own tools finish it in this session. A quick nested lookup belongs to your
harness's own subagents. Your private todo list is not a niwa task.

## Recipes

### Hand work to another agent's session

1. Pick an instance name from `harness.list`.
2. `session.start` with `harness` set to that name and a `prompt`. The prompt must stand alone: the
   new session knows nothing of yours. Give the goal, the files, the constraints and the shape of
   the answer you want. Pass `cwd` (the working directory); `model`, `effort` and `mode`
   (`ask`, `auto`, `full`) when you need other than the instance's. In `visible.actions` list only
   the actions it needs.
3. `session.start` returns the session id `s-...` and a receipt (delivered, queued or started). A
   receipt is not the answer. Read the session (`session.read`) for the reply.
4. To continue, `session.send` or `session.resume` the same `s-...`. A new session loses the
   context.
5. If that session needs a permission or asks a question, the request comes to you as its starter.
   `request.open` lists what waits; answer with `request.answer`. An unanswered request leaves the
   session waiting.

`session.list`, `session.search` and `session.read` also cover sessions that niwa did not start.
`session.list` answers one page, the most recently active first; when `nextCursor` is present, pass it as
`cursor` (with the same filters) for the next page, or narrow by `harness` or `cwd`.
(`session.start.<instance>` actions exist too: they are what a workflow's `agent()` calls, a start
that waits for the answer. For handing work over, use `session.start`.)

### Ask the owner

`request.ask` with `to: {"kind":"owner"}`, a `question` (a short name with no spaces) and an
`input` whose `kind` is one of `confirm`, `choice`, `multi`, `text`, `form`, with a `title`.

- The owner reads the question later and out of context. Put in the `title` and `detail` what is
  needed to answer, and say which option you recommend.
- Prefer `choice` with concrete options over free text.
- One request per decision. Put related fields in one `form`, not five requests.
- The call waits for the answer (the wait survives a host restart) and returns `{id, answer}`, the
  id being `req-...`. Give a `deadline` if you cannot wait for ever. If you cannot afford to block,
  ask from a workflow script (`ask.choice`, ...) and carry on meanwhile. `request.get` and
  `request.list` read a request later.
- Before asking, check that the answer is not already in the records, a session or the repository.
- No answer, a cancel or an expiry is neither yes nor no. Take the safe path, or stop and report.

### Tasks

A task is a contract: what to do, who asked, who is responsible, where to report, how it ended.

- **You assign:** `task.create`, with a `result` schema when you need a typed result. `task.result`
  waits for the end; `task.list` and `task.get` show where it stands.
- **You were assigned** (your prompt names `task-...`): `task.get` it, `task.report` at real
  milestones, and end with exactly one of `task.finish` (a result that fits the schema) or
  `task.fail` (the reason). `task.assigned` lists what you still owe. Never leave a task silent.

### Messages

`message.send` to an address (an agent, a session, a task, the owner) is for what needs no answer:
an update, a result. If you need an answer, that is a request. `message.list` and `message.get`
read them.

### Workflows

1. `workflow.guide` returns the language guide, the generated typings and the actions you may call.
   It is the reference; nothing here replaces it.
2. Write the script to a file.
3. Run `workflow.check --file <file>` until it is clean.
4. To run it once: `workflow.start --file <file>`. To keep it: `workflow.register --file <file>`
   gives `wf-...`, then `workflow.start --id wf-... --args ...`. Registering with the same `--id`
   adds a version.
5. Follow the run `run-...` with `workflow.inspect` or `workflow.wait`. History is in
   `workflow.runs` and `workflow.stats`.
6. A failure pauses the run: answer it with `workflow.resume --run <run> --choice retry|skip|cancel`.
   To change the script, edit the file and `workflow.revise --run <run> --file <file>`; finished
   steps keep their results. Do not start a fresh run to get past a pause.
7. `workflow.install` makes niwa start runs by itself on matching records (`sub-...`). Do it only
   when the owner asked for standing automation.

Rules that scripts break most often:
- Label every step whose result must survive an edit of the script.
- Declare the phases in the header, `phases: [{ title: "Review" }, { title: "Fix" }]`, and enter
  each by calling `phase("Review")` in the body. A phase belongs to the branch that entered it (a
  `parallel` branch may be in another phase); steps take no phase option.
- Use `now()` and `random()` (recorded reads), not `Date.now()` and `Math.random()`, and no direct
  I/O in the body; go through actions.
- Keep `uses` to the masks the script actually calls.
- Pass a `schema` to `agent()` whenever you branch on its answer.

## Ids

niwa issues every id as `<prefix>-<hex>`: `s-` session, `task-`, `req-`, `msg-`, `run-`, `wf-`,
`sub-` (an installed workflow). Never invent one. A `get` takes the id, or the start or the end of
it when that is unambiguous. Most entities have `list` and `get`. Quote ids when you report to the
owner or to another agent.

## Rin

Rin is the owner's main agent. If the host has her, `rin.*` actions are in the action list, and
their descriptions say what she takes (notes, commitments, judging). If they are absent, she is not
on this host.

## When it does not work

- **Host down** (`niwa status` fails, or MCP calls end in connection errors). Tell the owner. Do
  not start the host yourself. Continue with what you can do directly.
- **An action is missing from your tools.** Your starter did not make it visible. Ask the starter
  for it by name. Do not work around it.
- **Refused by the grant.** The refusal names the masks. It is an answer, not a glitch: do not
  retry, do not vary the call. Narrow `uses` or `visible` to what you hold, or ask for the right.
- **Outcome `unknown`.** The call was cut off and its effect may have happened. Check with `get` or
  `list` before repeating.
- **`input-invalid`.** The error lists the fields. Fix them from the schema, not by trial.
- **The harness refuses** a model, an effort, a mode or a resume. It cannot do that. Pick another
  instance from `harness.list`.
