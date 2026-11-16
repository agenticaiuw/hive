-- How the owner wants a web page to look, written by Hive. The owner asks from the browser
-- extension on the page itself ("when I come to this page, show just my five courses"); the request
-- goes through the usual queue (board_requests) with the page attached (board_page_asks), the
-- orchestrator writes a rule for it, and the extension applies every rule that's on whenever a
-- matching page loads (browser/chrome/src/page-rules.js).
CREATE TABLE IF NOT EXISTS board_page_asks (
  request INTEGER PRIMARY KEY,   -- board_requests.id
  url TEXT NOT NULL,
  title TEXT,
  outline TEXT                   -- the page as the extension saw it, for the agent to read
);

CREATE TABLE IF NOT EXISTS board_page_rules (
  id INTEGER PRIMARY KEY,
  host TEXT NOT NULL,            -- canvas.wisc.edu
  path TEXT NOT NULL DEFAULT '', -- the page's path, or '' for every page on the site
  title TEXT NOT NULL,           -- what it does, in a few words
  rule TEXT NOT NULL,            -- JSON {css, hide, keep}: see page-rules.js
  request INTEGER,               -- the board_requests.id it came from
  on_at INTEGER NOT NULL,
  off_at INTEGER                 -- set when the owner turns it off
);
CREATE INDEX IF NOT EXISTS board_page_rules_host ON board_page_rules (host, off_at);
