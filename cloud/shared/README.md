# cloud/shared

Plain ES modules with no npm dependencies that the builds share.

- `hiveCloud.mjs`: fills in the owner's Hive Cloud address in the browser extension's and phone
  app's builds.
- `privacy.test.mjs`: checks the whole repository for the owner's personal details.

Tests: `node --test cloud/shared`.
