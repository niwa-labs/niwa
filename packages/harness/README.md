# @niwa-labs/harness

The shared session model and the contract every harness kind implements: reading transcripts, controlling a session, injection and an explicit declaration of capabilities. Each harness protocol is translated into this model, and all other logic works only on it.

## Profiles

Every kind declares the profile of its installations (`profile: { status, of(options) }`): the paths a
session needs inside a box, computed from the installation's options (its program, its home with the
sign-in, sessions, configuration and caches) and the hosts of its model. A kind without one does not
register. `bind` gives each installation its profile, with the hosts the owner names in `net` added.
`profileConformance(binding, { cwd })` runs a session of an installation in a nono box closed to reading
with nothing but that profile; a kind whose installations pass declares its profile `verified`, the others
`admitted`.
