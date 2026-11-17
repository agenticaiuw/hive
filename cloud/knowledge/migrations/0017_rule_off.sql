-- The owner turning a standing rule off from any dashboard (2026-11-17: "delete a standing rule from
-- the dashboard"). Once set, the rule stays off on the board whatever its machine sends, and that
-- machine's ledger turns it off too on its next sync, so no agent is given it again.
ALTER TABLE board_rules ADD COLUMN off_at INTEGER;
