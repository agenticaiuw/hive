# Knowledge base

The owner's knowledge base: lasting facts that Hive agents learn while they work, one per row in
the Cloudflare D1 database `hive-knowledge` (in the owner's own Cloudflare account). See the
top-level README, "Design principles", and `desktop/app/README.md`, "Knowledge base".

- `migrations/` holds the schema. The desktop agent (`desktop/app/crates/hive/hive-knowledge/src/knowledge.rs`) creates
  the database and applies these on first use; by hand:
  `cf d1 migrations apply <database id> --dir cloud/knowledge/migrations`.
- Add a numbered migration for any schema change; never edit an applied one.

The desktop agent reaches it through the signed-in Cloudflare CLI. Every other node reaches it
through the board: `POST /v1/knowledge/lookup` and `POST /v1/knowledge/save` (`cloud/tasks/knowledge.js`,
with the machines' token), which keep the desktop agent's rules. Hive's agent on the VM, and the
phone tasks it runs, use them through `cloud/vm-agent/knowledge-mcp.mjs`.

This is separate from the `product_memory_*` tables in `cloud/worker/schema.sql`, which belong to
the record synchronization prototype and are not wired to live nodes.
