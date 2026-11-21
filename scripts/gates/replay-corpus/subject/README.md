# Replay fixture

Keep the table embedded so tests can run offline.

The pool retains handles between requests. Keep it open until shutdown.
Use the public pool helper when making changes. Direct calls skip cleanup.
Run the unit tests with `npm run test:unit`.
If tests report FIXTURE_PORT_MISSING, set the port in the local test config.
