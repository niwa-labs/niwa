# @niwa-labs/history

Reading a session's transcript through its harness's reading side: read with a bound harness (every record, or a digest or a brief in windows), plain-text search over the records, and a description of how much of a transcript was actually read. The `history` plugin watches a session of any harness as it grows and records how far its checklist is, when it pauses and when it ends; the transcript itself is never written into the journal. `/records` holds the schemas of the queries, the records and the actions.
