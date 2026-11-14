<script lang="ts">
  /**
   * The hero: what the hive said, first and largest.
   *
   * Inverted pyramid (NN/g) — the conclusion goes at the top, the process
   * below it. So the answer is the one element carrying size + weight + full
   * contrast at once, and the owner's question is demoted to a single small
   * secondary line above it. The question appears exactly once on this page.
   *
   * When there is no answer, the run must LOOK like a run with no answer: the
   * honest status word takes the display slot instead, and nothing stands in
   * for a result that does not exist.
   */
  import { formatWhen } from "$lib/jobs";
  import { deviceTagsFor } from "$lib/hiveFeed.js";
  import type { RunState } from "$lib/runState";
  import type { Snippet } from "svelte";

  let {
    state,
    run = null,
    ownAudio = "",
    replyAudio = "",
    onNeedsYou = null,
    details,
  }: {
    state: RunState;
    /** The whole run record, so the badge reads the SAME classifier as the
     * feed rows (`deviceTagsFor`: origin, source, markers, telemetry). Passing
     * origin/source strings alone once made this badge say "Cloud" for the
     * very run Recent tagged "Pendant" — one run, two names. */
    run?: {
      origin?: unknown;
      source?: unknown;
      kind?: unknown;
      executor?: unknown;
      events?: unknown;
    } | null;
    ownAudio?: string;
    replyAudio?: string;
    /** Jumps to the approval card when this run is the parked one. */
    onNeedsYou?: (() => void) | null;
    /** The collapsed developer layer, rendered by the page. */
    details?: Snippet;
  } = $props();

  const nodeTags = $derived(run ? deviceTagsFor(run) : []);

  const answered = $derived(state.phase === "answered");
  /** The answer when there is one; otherwise the honest status word. */
  const headline = $derived(answered ? state.answer : state.label);
  /**
   * Long prose and a two-word status cannot share one size. Three steps only,
   * so the page never has more than a handful of type sizes in play.
   */
  const headlineSize = $derived(
    !answered ? "word" : state.answer.length > 190 ? "long" : "answer",
  );
  const live = $derived(state.phase === "listening" || state.phase === "thinking");
</script>

<article class="answer-card" aria-label="Latest answer">
  <div class="answer-eyebrow">
    <span class="state-pill {state.tone}">
      <i class="state-dot {live ? 'pulsing' : ''}" aria-hidden="true"></i>
      {state.label}
    </span>
    {#if state.at}
      <span class="answer-when">{formatWhen(state.at)}</span>
    {/if}
    {#if nodeTags.length}
      <span
        class="answer-source"
        title={nodeTags.map((tag) => tag.hint).join(" · ")}
        >{nodeTags.map((tag) => tag.label).join(" · ")}</span
      >
    {/if}
  </div>

  {#if state.question}
    <p class="answer-question">
      <span>You asked</span>
      {state.question}
    </p>
  {/if}

  {#if state.phase === "nothing-yet"}
    <h2 class="answer-headline" data-size="word">Ready</h2>
    <p class="answer-sub">Press the pendant or type a command</p>
  {:else}
    <h2 class="answer-headline" data-size={headlineSize}>{headline}</h2>
  {/if}

  {#if state.phase === "failed" && state.error}
    <p class="answer-error">{state.error}</p>
  {/if}

  {#if !answered && state.detail && state.phase !== "failed"}
    <p class="answer-sub">{state.detail}</p>
  {/if}

  {#if state.phase === "needs-approval"}
    <div class="answer-actions">
      {#if onNeedsYou}
        <button type="button" class="button-primary" onclick={onNeedsYou}
          >Go to the approval</button
        >
      {/if}
    </div>
  {/if}

  {#if answered && state.delivery}
    <!-- The agent's own account of how far the spoken reply got. It never
         claims the pendant played it, because nothing observed that. -->
    <p class="answer-delivery">Spoken reply · {state.delivery}</p>
  {/if}

  {#if ownAudio || replyAudio}
    <div class="answer-audio">
      {#if replyAudio}
        <div class="answer-track">
          <span>Its reply</span>
          <audio
            controls
            preload="metadata"
            src={replyAudio}
            aria-label="The agent's spoken reply"
          ></audio>
        </div>
      {/if}
      {#if ownAudio}
        <div class="answer-track">
          <span>Your voice</span>
          <audio
            controls
            preload="metadata"
            src={ownAudio}
            aria-label="Your recording"
          ></audio>
        </div>
      {/if}
    </div>
  {/if}

  {@render details?.()}
</article>
