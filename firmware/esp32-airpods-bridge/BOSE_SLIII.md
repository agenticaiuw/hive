# Bose SoundLink III (SLIII) + HUZZAH32

## Pairing checklist (do this first)

1. **Power on** the Bose SLIII.
2. **Disconnect it from your iPhone/Mac** (or put those devices’ Bluetooth off) so the speaker is free.
3. Put Bose in **pairing mode**: hold the Bluetooth button until the light blinks.
4. Power the **HUZZAH32** from its own USB cable; shared GND with nRF only.
5. Flash/monitor this firmware — it defaults target to **`Bose SLIII`** and pages BD_ADDR `08:DF:1F:EA:19:33`.

## Serial commands (115200)

Send JSON lines over USB serial:

```json
{"command":"scan"}
{"command":"connect","target":"Bose SLIII"}
{"command":"status"}
{"command":"tone"}
```

- **`tone`**: ESP32 plays a 3 s test tone over A2DP (does not need nRF audio). Use this to verify Bose link first.
- **`connect`**: save target and reconnect.

## What “connected” looks like

Monitor should show:

```json
{"type":"bridge","state":"connected","message":"Bluetooth speaker connected..."}
```

Diagnostics every second: `"state":"connected"`.

If stuck on `"searching"`:

- Speaker still bonded to a phone that is nearby and grabbing it
- Wrong BD_ADDR (re-scan: `{"command":"scan"}` and note the address in discovery events)
- Speaker off / not in range

## nRF reply playback (no autoplay)

1. Record / upload / agent works on nRF.
2. While waiting for speech: LED **blinks**.
3. When speech is on the pendant: LED **solid**.
4. **Press button 1** → nRF plays PCM over I2S → ESP resamples → A2DP → Bose.
5. Nothing plays until that press (by design).

## Progressive play (chunks while you listen)

Today the pendant downloads the **full** reply, then solid LED, then play.

Target UX (next firmware step):

- First speech bytes arrive → solid LED (ready)
- Button 1 starts play from a ring buffer
- More chunks fill the ring while Bose is already playing

Cloud mid-press streaming already feeds **your speech up** to Realtime while you talk; progressive **down** to Bose is the download/play half.
