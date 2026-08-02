# AI Pendant Browser Bridge

Install this unpacked extension on your **home Mac Chrome** so AI Pendant can reuse sites where you are already logged in (Gmail, Amazon, Google Docs, etc.).

## Setup

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this `browser-extension/` folder
5. Open extension options and set:
   - Agent URL: `http://127.0.0.1:8000`
   - Agent Token: same as `AGENT_TOKEN` in `.env`
6. Keep Chrome running on the home Mac with the extension enabled

## How it works

- The extension polls the local Mac agent at `/browser/poll`
- When the agent receives `browser_navigate`, `browser_click`, `browser_type`, or `browser_read_page` actions, they run in your existing Chrome profile
- No OAuth plugin setup is required because the browser already has your cookies and sessions

## Requirements

- Home Mac agent running (`npm run agent`)
- Chrome open on the home Mac (can be in background)
- Same machine as the local agent
