-- The owner stopping a request to Hive's cloud agent (the x on Hive's window on the Mac, whose agent
-- thinks in the cloud): when they asked (POST /v1/requests/stop). The orchestrator stops the agents of a
-- request it's working on when it next looks (GET /v1/requests/state), and ends the request.
ALTER TABLE board_requests ADD COLUMN stop_at INTEGER;
