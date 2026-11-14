-- What an agent changed for each task: the files it edited and the commits it made (JSON lists,
-- as the ledger keeps them). The dashboard shows them; a commit links to its diff.
ALTER TABLE board_tasks ADD COLUMN files TEXT;
ALTER TABLE board_tasks ADD COLUMN commits TEXT;
