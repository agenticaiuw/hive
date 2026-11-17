# desktop

Hive on the Mac.

- [`app`](./app): Hive.app itself (Rust, Swift, C++ and Python). Hive runs from here;
  `app/tools/update-app.sh` installs a new build.
- [`hive-bridge.mjs`](./hive-bridge.mjs): hands the phone's tools to Hive's agent on the cloud VM
  over SSH, since only the Mac can reach the phone.
- [`hive-files.mjs`](./hive-files.mjs): sends files between the Mac and the VM through Hive's cloud
  storage.
- [`vm-post.mjs`](./vm-post.mjs): posts to Discord or X through the VM's browser, showing the owner
  exactly what will be sent first.
- [`claude-code`](./claude-code): the hooks that put Claude Code's work on Hive's task board.
- [`integration`](./integration): packaging, install and rollback scripts for Hive.app, and
  `import-pc-agent.mjs`, which copied the older personal-agent source into `app` (it never
  overwrites an existing copy).

The Mac reaches Hive's other nodes (the VM, the browsers, the phone) through Hive's cloud, never
directly.

`node --test desktop/tests` runs the tests here.
