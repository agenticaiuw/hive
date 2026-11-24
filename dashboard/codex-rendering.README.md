Tool history rendering follows OpenAI Codex (Apache-2.0), revision
9202c7916b434d5312ac580148b7d2460e57fe7e:
https://github.com/openai/codex/tree/9202c7916b434d5312ac580148b7d2460e57fe7e/codex-rs/tui/src

The dashboard adapts exec_cell/render.rs and history_cell/mcp.rs labels,
exploration actions, bullet/indented output layout and bounded previews to HTML.
Codex's public implementation is a terminal renderer, not a web component;
this is an HTML adaptation, not a copy of the proprietary Codex app UI.
Full output expands inline; original tool images retain the exact bytes.
Native app-server item IDs reconcile running/completed rows across polls.
License and upstream notice accompany this adaptation.
