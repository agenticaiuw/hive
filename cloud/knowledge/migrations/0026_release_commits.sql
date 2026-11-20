-- One version for all of Hive (cloud/tasks/nodes.js): each release says which commit on main it was built
-- from, so every node, whatever its kind and whoever's it is, reads as the same numbering.
ALTER TABLE board_releases ADD COLUMN git_commit TEXT;
