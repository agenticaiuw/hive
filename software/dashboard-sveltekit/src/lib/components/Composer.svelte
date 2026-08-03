<script lang="ts">
  /**
   * Lets a signed-in personal device speak or type a command. Both paths land
   * in the same relay pipeline the pendant uses, so the run simply appears in
   * the hero via the existing freshness polling.
   */
  import { onDestroy, onMount } from "svelte";
  import {
    blobToBase64,
    mimeToFormat,
    pickRecorderMimeType,
    recordClock,
  } from "$lib/pipeline";

  type ComposerMode = "idle" | "recording" | "sending";

  const SESSION_STORAGE_KEY = "ai-pendant-dashboard-conversation-id";
  const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/;

  type ActiveRecording = {
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    mimeType: string;
    startedAt: number;
  };

  let { onQueued }: { onQueued: () => void } = $props();

  let mode = $state<ComposerMode>("idle");
  let text = $state("");
  let hint = $state("");
  let seconds = $state(0);
  let sessionId = $state("");

  // Deliberately a plain binding, not `$state`: the recorder handle is
  // machinery, and mutating it must never schedule a re-render or re-run the
  // timer effect below.
  let active: ActiveRecording | null = null;

  const recording = $derived(mode === "recording");
  const sending = $derived(mode === "sending");

  onMount(() => {
    let stored = "";
    try {
      stored = localStorage.getItem(SESSION_STORAGE_KEY) || "";
    } catch {
      // Private browsing may make localStorage unavailable; the in-memory id
      // still keeps every command in this mounted dashboard together.
    }
    sessionId = SESSION_ID_PATTERN.test(stored) ? stored : crypto.randomUUID();
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    } catch {
      // See the private-browsing fallback above.
    }
  });

  function conversationSessionId() {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      sessionId = crypto.randomUUID();
    }
    return sessionId;
  }

  $effect(() => {
    if (mode !== "recording") return;
    const timer = window.setInterval(() => {
      const startedAt = active?.startedAt;
      if (startedAt) {
        seconds = Math.floor((Date.now() - startedAt) / 1000);
      }
    }, 250);
    return () => window.clearInterval(timer);
  });

  // Release the microphone if the dashboard unmounts mid-recording.
  onDestroy(() => {
    const pending = active;
    active = null;
    if (!pending) return;
    try {
      if (pending.recorder.state !== "inactive") pending.recorder.stop();
    } catch {
      // already stopped
    }
    pending.stream.getTracks().forEach((track) => track.stop());
  });

  async function startRecording() {
    hint = "";
    if (
      typeof MediaRecorder === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      hint = "This browser cannot record audio — type a command instead.";
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.start(250);
      active = {
        recorder,
        stream,
        chunks,
        mimeType: recorder.mimeType || mimeType || "audio/webm",
        startedAt: Date.now(),
      };
      seconds = 0;
      mode = "recording";
    } catch {
      // The mic stays live if MediaRecorder failed after getUserMedia resolved.
      stream?.getTracks().forEach((track) => track.stop());
      hint = "Microphone blocked — allow mic access or type instead.";
    }
  }

  async function stopAndSend() {
    const pending = active;
    if (!pending) return;
    active = null;
    mode = "sending";
    try {
      // A recorder that already stopped itself will never fire onstop again,
      // and a wedged one must not strand the composer in "sending".
      if (pending.recorder.state !== "inactive") {
        const stopped = new Promise<void>((resolve) => {
          pending.recorder.onstop = () => resolve();
        });
        pending.recorder.stop();
        await Promise.race([
          stopped,
          new Promise<void>((resolve) => window.setTimeout(resolve, 2000)),
        ]);
      }

      const blob = new Blob(pending.chunks, { type: pending.mimeType });
      if (!blob.size) {
        throw new Error("No audio captured — try again.");
      }
      const audioBase64 = await blobToBase64(blob);
      const response = await fetch("/api/command/audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64,
          format: mimeToFormat(blob.type || pending.mimeType),
          durationMs: Date.now() - pending.startedAt,
          sessionId: conversationSessionId(),
          language: navigator.language?.toLowerCase().startsWith("ko")
            ? "ko"
            : "en",
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Voice send failed (${response.status})`);
      }
      if (payload.noSpeech) {
        hint = "No speech detected — try again.";
      } else if (payload.queueError) {
        hint = payload.queueError;
      }
      onQueued();
    } catch (sendError) {
      hint =
        sendError instanceof Error ? sendError.message : "Voice send failed.";
    } finally {
      // Always hand the microphone back, however the send ended.
      pending.stream.getTracks().forEach((track) => track.stop());
      mode = "idle";
    }
  }

  async function submitText(event: SubmitEvent) {
    event.preventDefault();
    const command = text.trim();
    if (!command || mode !== "idle") return;
    hint = "";
    mode = "sending";
    try {
      const response = await fetch("/api/command/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: command,
          sessionId: conversationSessionId(),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Send failed (${response.status})`);
      }
      text = "";
      onQueued();
    } catch (sendError) {
      hint = sendError instanceof Error ? sendError.message : "Send failed.";
    } finally {
      mode = "idle";
    }
  }
</script>

<div class="composer-block">
  <div class="composer">
    <button
      type="button"
      class="mic-button {recording ? 'recording' : ''}"
      onclick={recording ? stopAndSend : startRecording}
      disabled={sending}
      aria-label={recording ? "Stop recording and send" : "Record a voice command"}
      title={recording ? "Stop recording and send" : "Record a voice command"}
    >
      {#if recording}
        <svg
          viewBox="0 0 16 16"
          width="15"
          height="15"
          fill="currentColor"
          aria-hidden="true"
        >
          <rect x="4" y="4" width="8" height="8" rx="1.5" />
        </svg>
      {:else}
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
          <path d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0" />
          <path d="M8 11.8v2.4" />
        </svg>
      {/if}
    </button>
    {#if recording}
      <span class="record-timer">{recordClock(seconds)}</span>
    {/if}
    {#if sending}
      <span class="composer-status">Sending…</span>
    {/if}
    <form class="composer-field" onsubmit={submitText}>
      <input
        bind:value={text}
        placeholder="Type a command…"
        aria-label="Type a command"
        enterkeyhint="send"
        maxlength="2000"
        disabled={mode !== "idle"}
      />
      <button
        type="submit"
        class="send-button"
        aria-label="Send command"
        title="Send command"
        disabled={mode !== "idle" || !text.trim()}
      >
        <svg
          viewBox="0 0 16 16"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M8 12.5v-9" />
          <path d="M4.2 7.2 8 3.5l3.8 3.7" />
        </svg>
      </button>
    </form>
  </div>
  {#if hint}
    <p class="composer-hint">{hint}</p>
  {/if}
</div>
