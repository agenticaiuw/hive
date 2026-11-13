# Hive Safari extension

The shared extension resources and native credential escrow handler live in
`browser/safari/Hive Browser Bridge/Shared (Extension)` in this repository.
The name and bundle identifier are adapted for the Hive app. `embed.sh` embeds
and signs the extension before the containing app is signed.

The extension expects the Hivemind local-agent browser bridge (pairing,
authenticated heartbeat, command poll and result endpoints). Embedding it does
not itself start that server or connect Hive's tools to it. Safari enablement,
site permissions, pairing and end-to-end browser operation must be verified
separately. Do not distribute an ad-hoc build as an update to a signed install.
