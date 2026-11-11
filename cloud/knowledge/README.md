# Knowledge base

The owner's knowledge base: lasting facts that Hive agents learn while they work, one per row in
the Cloudflare D1 database `hive-knowledge` (in the owner's own Cloudflare account). See the
top-level README, "Design principles", and `desktop/app/README.md`, "Knowledge base".

- `migrations/` holds the schema. The desktop agent (`desktop/app/python/knowledge.py`) creates
  the database and applies these on first use; by hand:
  `cf d1 migrations apply <database id> --dir cloud/knowledge/migrations`.
- Add a numbered migration for any schema change; never edit an applied one.

Today only the desktop agent reaches it, through the signed-in Cloudflare CLI. The phone and VM
agents will need an HTTP route to it in `cloud/worker`.

This is separate from the `product_memory_*` tables in `cloud/worker/schema.sql`, which belong to
the record synchronization prototype and are not wired to live nodes.
