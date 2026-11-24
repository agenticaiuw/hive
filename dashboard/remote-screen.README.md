The Screen tab uses noVNC 1.6.0 (MPL-2.0), bundled from its unmodified
ES module source at https://github.com/novnc/noVNC/tree/v1.6.0 .
The license is in remote-screen.LICENSE.txt. To regenerate remote-screen.js,
bundle core/rfb.js from that tag with esbuild 0.25.12 using
`--bundle --minify --format=esm --outfile=dashboard/remote-screen.js`.
No CDN or JavaScript build tool is needed when installing or running Hive.

The Rust server authenticates the WebSocket and checks its Origin before
bridging to the existing loopback VNC service on port 5901. The existing
VM screen installer provides that service and its VNC password. The password
is returned only to authenticated dashboard clients; neither the password
nor VNC itself is exposed on a public port.
