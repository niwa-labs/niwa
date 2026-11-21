# @niwa-labs/acp

The Agent Client Protocol as niwa reads it: zod types generated from the schema of each supported SDK version, and the reading of a message against a snapshot, where a variant the snapshot does not know reads as a typed unknown instead of failing the session. It also holds the client side of a connection that the ACP harness kinds share: line framing, request ids, the calls in flight with their timeouts, and how far a failed call got.
