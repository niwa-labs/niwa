# @niwa-labs/harness-pi

The pi harness kind: reads the sessions pi keeps in its agent directory, drives pi in its RPC mode, brings niwa inside pi through an extension that reports by running `niwa insert report`, and gives a session niwa's actions as pi tools through a per-session extension that registers niwa's MCP server (`src/mcp/`).
