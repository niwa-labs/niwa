# @niwa-labs/messages

Messages between agents, sessions and the owner: an envelope that says who sent it, who it is for and what it carries, sent with `message.send` and recorded in the journal. A message to a session is unfolded into text and delivered through `session.send`.

The root entry holds the plugin and its factories; `@niwa-labs/messages/records` holds the envelope schemas, the records, the typed action references and the pure helpers that other plugins may import.
