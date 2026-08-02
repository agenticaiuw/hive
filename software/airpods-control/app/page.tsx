"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type SerialPortLike = {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
};

type SerialNavigator = Navigator & {
  serial?: {
    requestPort: () => Promise<SerialPortLike>;
  };
};

type BridgeState = "offline" | "usb" | "searching" | "connected";
type DiscoveredDevice = { name: string; rssi: number };

const stateCopy: Record<BridgeState, { label: string; detail: string }> = {
  offline: {
    label: "ESP32 offline",
    detail: "Connect the Feather to this Mac with a data-capable USB cable.",
  },
  usb: {
    label: "USB connected",
    detail: "The bridge is ready to receive an AirPods target.",
  },
  searching: {
    label: "Searching",
    detail: "Keep the AirPods case open with its light flashing white.",
  },
  connected: {
    label: "Audio linked",
    detail:
      "The ESP32 is forwarding returned agent speech from the nRF to your Bluetooth device.",
  },
};

export default function Home() {
  const [bridgeState, setBridgeState] = useState<BridgeState>("offline");
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [events, setEvents] = useState<string[]>([
    "Waiting for the HUZZAH32 USB connection.",
  ]);
  const [busy, setBusy] = useState(false);
  const [serialSupported, setSerialSupported] = useState(true);
  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef =
    useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  const addEvent = useCallback((message: string) => {
    const time = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setEvents((current) => [`${time}  ${message}`, ...current].slice(0, 8));
  }, []);

  useEffect(() => {
    const hydration = window.setTimeout(() => {
      const nav = navigator as SerialNavigator;
      setSerialSupported(Boolean(nav.serial));
    }, 0);
    return () => window.clearTimeout(hydration);
  }, []);

  const processLine = useCallback(
    (rawLine: string) => {
      const line = rawLine.trim();
      if (!line) return;

      try {
        const data = JSON.parse(line) as {
          type?: string;
          state?: BridgeState;
          message?: string;
          target?: string;
          device?: string;
          rssi?: number;
        };
        if (data.state && data.state in stateCopy) setBridgeState(data.state);
        if (data.type === "discovery" && data.device) {
          const discovered = {
            name: data.device,
            rssi: data.rssi ?? -127,
          };
          setDevices((current) => {
            const withoutDuplicate = current.filter(
              (device) => device.name !== discovered.name,
            );
            return [...withoutDuplicate, discovered]
              .sort((left, right) => right.rssi - left.rssi)
              .slice(0, 12);
          });
        }
        addEvent(data.message ?? line);
      } catch {
        const normalized = line.toLowerCase();
        if (normalized.includes("connected")) setBridgeState("connected");
        else if (
          normalized.includes("search") ||
          normalized.includes("discover")
        )
          setBridgeState("searching");
        addEvent(line);
      }
    },
    [addEvent],
  );

  const startReadLoop = useCallback(
    async (port: SerialPortLike) => {
      if (!port.readable) return;
      const reader = port.readable.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let pending = "";

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? "";
          lines.forEach(processLine);
        }
      } catch (error) {
        if (portRef.current) {
          addEvent(
            `Serial read stopped: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
        }
      } finally {
        reader.releaseLock();
        readerRef.current = null;
      }
    },
    [addEvent, processLine],
  );

  const connectUsb = async () => {
    const nav = navigator as SerialNavigator;
    if (!nav.serial) return;
    setBusy(true);

    try {
      const port = await nav.serial.requestPort();
      await port.open({ baudRate: 115200 });
      portRef.current = port;
      setBridgeState("usb");
      addEvent("HUZZAH32 USB serial connected at 115200 baud.");
      void startReadLoop(port);
    } catch (error) {
      addEvent(
        `USB connection failed: ${
          error instanceof Error ? error.message : "permission was not granted"
        }`,
      );
    } finally {
      setBusy(false);
    }
  };

  const sendCommand = async (command: Record<string, unknown>) => {
    const port = portRef.current;
    if (!port?.writable) {
      addEvent("Connect the HUZZAH32 over USB first.");
      return false;
    }

    const writer = port.writable.getWriter();
    try {
      await writer.write(
        new TextEncoder().encode(`${JSON.stringify(command)}\n`),
      );
      return true;
    } finally {
      writer.releaseLock();
    }
  };

  const scanDevices = async () => {
    setDevices([]);
    setBusy(true);
    const sent = await sendCommand({ command: "scan" });
    if (sent) {
      setBridgeState("searching");
      addEvent("Scanning for nearby Bluetooth audio devices.");
    }
    setBusy(false);
  };

  const pairAirPods = async (deviceName: string) => {
    const cleanName = deviceName.trim();
    if (!cleanName) {
      addEvent("Enter the Bluetooth name shown for your AirPods.");
      return;
    }

    window.localStorage.setItem("airpods-target", cleanName);
    setBusy(true);
    const sent = await sendCommand({
      command: "connect",
      target: cleanName,
      volume: 100,
    });
    if (sent) {
      setBridgeState("searching");
      addEvent(`Searching for “${cleanName}” at 100% bridge volume.`);
    }
    setBusy(false);
  };

  const forgetAirPods = async () => {
    const sent = await sendCommand({ command: "forget" });
    if (sent) {
      setBridgeState("usb");
      addEvent("Saved Bluetooth target and pairing were cleared.");
    }
  };

  const requestStatus = async () => {
    const sent = await sendCommand({ command: "status" });
    if (sent) addEvent("Status requested from the ESP32.");
  };

  const currentState = stateCopy[bridgeState];

  return (
    <main className="shell">
      <nav className="topbar" aria-label="Agentic Audio">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <span>Agentic Audio</span>
        </div>
        <div className="topbar-note">nRF9160 → HUZZAH32 → AirPods</div>
      </nav>

      <section className="hero">
        <div>
          <p className="eyebrow">Bluetooth audio bridge</p>
          <h1>Route your gadget’s voice to AirPods.</h1>
          <p className="lede">
            Configure the Feather over USB, then let it carry the live I²S audio
            stream from the nRF board over Bluetooth Classic.
          </p>
        </div>
        <div className={`status-orb status-${bridgeState}`} aria-hidden="true">
          <span />
        </div>
      </section>

      {!serialSupported && (
        <aside className="browser-warning">
          Web Serial is unavailable in this browser. Open this page in Chrome or
          Edge on the Mac.
        </aside>
      )}

      <section className="dashboard">
        <article className="control-card">
          <div className="card-heading">
            <div>
              <p className="step-label">01 · USB bridge</p>
              <h2>{currentState.label}</h2>
            </div>
            <span className={`state-pill state-${bridgeState}`}>
              <i />
              {bridgeState === "offline" ? "Not ready" : "Ready"}
            </span>
          </div>
          <p className="muted">{currentState.detail}</p>

          <button
            className="button button-dark"
            onClick={connectUsb}
            disabled={!serialSupported || busy || bridgeState !== "offline"}
          >
            <span className="usb-symbol" aria-hidden="true">
              ↯
            </span>
            {bridgeState === "offline" ? "Connect HUZZAH32" : "USB connected"}
          </button>

          <div className="divider" />

          <div className="pairing-heading">
            <div>
              <p className="step-label">02 · Bluetooth target</p>
              <h2>Pair AirPods</h2>
            </div>
            <span className="volume-badge">100% output</span>
          </div>

          <button
            className="button button-accent scan-button"
            onClick={scanDevices}
            disabled={busy || bridgeState === "offline"}
          >
            Scan nearby audio devices
          </button>

          <p className="hint scan-hint">
            AirPods 4 or Pro 3: open the case and double-tap its front until the
            light flashes white. Older cases: hold the rear button for about
            five seconds. Then start the scan.
          </p>

          <div className="device-list" aria-live="polite">
            {devices.length === 0 ? (
              <div className="empty-device">
                <span>◌</span>
                <p>
                  {bridgeState === "searching"
                    ? "Listening for nearby Bluetooth audio devices…"
                    : "No scan results yet."}
                </p>
              </div>
            ) : (
              devices.map((device) => (
                <button
                  className="device-row"
                  key={device.name}
                  onClick={() => pairAirPods(device.name)}
                  disabled={busy}
                >
                  <span className="device-icon" aria-hidden="true">
                    ◖
                  </span>
                  <span>
                    <strong>{device.name}</strong>
                    <small>{device.rssi} dBm</small>
                  </span>
                  <b>Connect</b>
                </button>
              ))
            )}
          </div>

          <div className="secondary-actions">
            <button onClick={requestStatus} disabled={bridgeState === "offline"}>
              Refresh status
            </button>
            <button onClick={forgetAirPods} disabled={bridgeState === "offline"}>
              Forget pairing
            </button>
          </div>
        </article>

        <aside className="wiring-card">
          <p className="step-label">Physical wiring</p>
          <h2>Four wires. Agent speech only.</h2>
          <p className="muted">
            Keep the MAX98357 disconnected. This I²S link carries only the
            agent’s returned voice from the nRF to the ESP32.
          </p>

          <div className="wire-list">
            <div className="wire">
              <span className="wire-color cyan" />
              <div>
                <strong>nRF A3 / P0.17 · LRC</strong>
                <small>to ESP GPIO 33</small>
              </div>
              <b>33</b>
            </div>
            <div className="wire">
              <span className="wire-color violet" />
              <div>
                <strong>nRF A4 / P0.18 · BCLK</strong>
                <small>to ESP GPIO 27</small>
              </div>
              <b>27</b>
            </div>
            <div className="wire">
              <span className="wire-color orange" />
              <div>
                <strong>nRF A5 / P0.19 · DATA</strong>
                <small>to ESP GPIO 14</small>
              </div>
              <b>14</b>
            </div>
            <div className="wire">
              <span className="wire-color black" />
              <div>
                <strong>nRF GND</strong>
                <small>to ESP GND</small>
              </div>
              <b>G</b>
            </div>
          </div>

          <div className="power-note">
            <strong>Power separately</strong>
            <span>
              Keep the HUZZAH32 on USB. Do not connect the boards’ 5V or 3V
              power pins together.
            </span>
          </div>

          <div className="storage-block">
            <div className="storage-heading">
              <div>
                <p className="step-label">MicroSD · Adafruit #254</p>
                <h2>nRF SPI storage</h2>
              </div>
              <span className="sd-pill">Wire next</span>
            </div>
            <div className="sd-grid">
              <span>Breakout 5V</span>
              <b>nRF DK 5V</b>
              <span>Breakout GND</span>
              <b>nRF GND</b>
              <span>Breakout CLK</span>
              <b>nRF D13 · P0.13</b>
              <span>Breakout DO</span>
              <b>nRF D12 · P0.12</b>
              <span>Breakout DI</span>
              <b>nRF D11 · P0.11</b>
              <span>Breakout CS</span>
              <b>nRF D10 · P0.10</b>
            </div>
            <p className="storage-note">
              The microSD belongs to the nRF, not the temporary ESP bridge.
              Leave the breakout’s 3V and CD pins disconnected.
            </p>
          </div>
        </aside>
      </section>

      <section className="event-card">
        <div className="event-heading">
          <div>
            <p className="step-label">Bridge activity</p>
            <h2>Live event log</h2>
          </div>
          <span className="serial-label">115200 baud</span>
        </div>
        <div className="log" role="log" aria-live="polite">
          {events.map((event, index) => (
            <p key={`${event}-${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {event}
            </p>
          ))}
        </div>
      </section>

      <footer>
        <span>Agentic Gadget · local control surface</span>
        <span>
          Mic audio uploads over LTE; returned agent speech plays over
          Bluetooth.
        </span>
      </footer>
    </main>
  );
}
