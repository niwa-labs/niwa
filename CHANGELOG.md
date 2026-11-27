# Changelog

## 0.2.0 — 2026-11-27

- Limit an Ncode session to an exact list of built-in tools. An empty list
  removes them all. After every start and resume, Niwa reads back what the
  Ncode build allows and refuses the session if the build cannot enforce the
  list or still offers a tool you left out. A resumed session keeps its own
  list and cannot widen it. Under a list, only the MCP servers you hand to the
  session stay available. Upstream MiniMax Code keeps its default tool set and
  refuses explicit lists.
- Install a copy of Niwa that does not depend on a source checkout, and point
  the installed command at it. Switching back means activating an earlier copy.
  The host keeps running during the switch.
- Let authorized workflows start sessions outside a sandbox. The workflow
  needs an explicit grant, and Niwa checks the isolation of the workflow and
  its parent runs before it starts or restarts such a session.
- Sign in to Claude from the local macOS Keychain inside a sandbox, and pass
  credentials to sandboxed Claude sessions. When Claude fails to start, the
  failure now comes back with a reason.
- Narrow sandbox access. Socket and Git metadata access now covers only the
  session being launched. ZCode can reach its own storage. Pi is found through
  the search path set for it.
- Wait on several session turns at once, cancel a wait that is still pending,
  and read the result of each turn.
- Read Ncode session history that includes tool results Ncode stored outside
  the transcript.
- Cockpit timelines show the current attempt of each step and the activity of
  the sessions a run started. Transcripts show activity as it happens and load
  earlier messages when you scroll up.
- Keep a workflow run paused when the owner paused it while another step of the
  same run is still waiting.
- Explain in the workflow guide when phases are worth using.
- Publish GitHub releases from a version tag.

## 0.1.0 — 2026-11-22

- Use OpenCode v2 with Niwa. Browse its sessions and read their transcripts
  without writing to its history. Start and resume sessions in a Niwa box. They
  share history with the OpenCode installation and follow the box's network
  rules for provider traffic. Discovery checks that the installed version is v2.
  A guide shows how to point an installation at your own provider.
- Override the network allowlist of one harness installation. An omitted list
  inherits the defaults of its kind, and an empty list clears them. One
  installation can also be granted a loopback listener.
- Run Ncode in Niwa-only mode on builds that support it. Resumed sessions keep
  their isolation. Older Ncode builds and upstream MiniMax Code refuse the mode.
- Send requests to granted loopback addresses through the sandbox proxy, and
  keep input backpressure intact for boxed processes.
- Check and update the map of an upstream snapshot's Git ranges from a
  downstream package, with optional generation of script texts.
- Start Niwa from a Bun checkout in the quickstart, and read one combined
  overview of Niwa and Ncode.
- Move the boxed OpenCode bundle to another location without breaking it.

## 0.0.0 — 2026-11-22

First release of the platform.

- Run a local host that writes everything it does to one durable journal. The
  command line, the web Cockpit, the MCP server and the Telegram bot all talk
  to that host. A client can retry a call safely, and a restart picks up where
  the journal left off.
- Control access with grants. Each action declares its effect, and an
  irreversible action needs a rule that names it. The owner can narrow, pause
  or cancel what a run may do, and every refusal is recorded.
- Work with eight kinds of coding agent: Claude Code, the Claude Agent SDK,
  Codex, MiniMax Code, Ncode, OpenCode, pi and ZCode. Each kind declares what
  it can do and what its sandbox needs. One kind can have several
  installations, each with its own home, model and limits.
- Start, resume, ask, message, steer, interrupt and close sessions in any of
  those agents. Niwa tells a message that was never sent from one that may have
  gone through. Restrict a session to Niwa's tools or to an allowed list, hand
  it MCP servers, and watch its progress, pauses and end.
- Read any session's transcript in full, as a digest or as a brief, and search
  across sessions. Records include reasoning, checklists, permission decisions,
  images, inserted text and restarts, and long transcripts load in pages.
- Write workflows as durable TypeScript scripts. Check them, store versions,
  and run them with branches, child runs, deadlines and phase plans. Pause,
  extend, cancel, or recompute a single step. After a restart or a code change,
  a run resumes from the part that did not change. Large step results are kept
  as stored artifacts.
- Build on script libraries for groups, loops, races, judging and waiting;
  worktrees, code review, test-first work and debugging; and blind evaluations
  with rubric grading. Built-in workflows are promoted only after a trial suite
  passes.
- Schedule work with timers and durable sleeps that survive restarts and keep
  daily hours across clock changes.
- Route addressed messages to sessions, ask the owner typed questions with
  options or free text, and hand out tasks that report back with a result.
  Executors are held to the grant of the person who created the task.
- Give long-lived agents an address, an inbox and one main session, and attach
  a session started in a terminal to an agent.
- Confine every session in a box built from its installation's profile, with
  filesystem and network rules. Run commands inside or outside a box, keep
  their output as stored artifacts, and hold secrets back from it.
- Track Git repositories and worktrees, create and remove worktrees without
  losing unmerged work, show each worktree's head and remote, and receive a
  daily offer to clean up.
- Open the web Cockpit for sessions, workflow runs, requests and tasks. Pages
  come from plugins, update live, and guard risky controls. Workflow pages show
  every declared phase and the steps inside it.
- Answer the owner's requests from a Telegram chat, with buttons for choices.
- Extend the host with plugins that add actions, record types, workflows,
  Cockpit pages and agent prompt sections. A plugin file is checked by hash
  before it loads, and a failed update leaves the installed copy in place.
- Distribute the command line under the Niwa Labs scope with an MIT license,
  and document how to run Niwa from source.
