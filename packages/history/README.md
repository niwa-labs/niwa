# @niwa-labs/history

Stateless library for reading a session's transcript through its harness's reading side: read with a bound harness, plain-text search over the records, and a description of how much of a transcript was actually read. The root entry holds the functions; `/records` holds the schemas of the queries, matches, coverage and session records. Nothing is stored here: the transcript is never written into the journal.
