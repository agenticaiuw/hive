<script lang="ts">
  /**
   * "The hive needs you." The one card on this page that is allowed to shout.
   *
   * A parked plan is the only state where the dashboard is blocking on a human,
   * so it sits above everything — including the answer — and carries its own
   * action rather than describing one somewhere else (NN/g heuristic 9: name the
   * problem, offer the way out). Status is carried by an icon, a word and a
   * colour together, never colour alone (WCAG 1.4.1).
   *
   * Only the newest plan is shown in full: one banner, one decision (Polaris).
   * Older parked plans render `compact`, which still carries its own Approve
   * button so no pending decision costs an extra click to reach.
   *
   * Nothing here is generated: the reasons are the agent's `meta.blocked[]`
   * verbatim, and the steps are the labels it wrote for its own plan.
   */
  import type { PendingApproval } from "$lib/runState";
  import { formatWhen } from "$lib/jobs";

  let {
    approval,
    canApprove,
    compact = false,
    stale = false,
    busy = false,
    denying = false,
    error = "",
    onApprove,
    onDeny,
    onSeePlan,
  }: {
    approval: PendingApproval;
    /** False on the deployed build, which has no approve route to the Mac. */
    canApprove: boolean;
    compact?: boolean;
    /**
     * A plan the owner has already slept on (see STALE_APPROVAL_AFTER_MS).
     * Still a decision, no longer an interruption: grey instead of amber, a
     * clock instead of a warning triangle, and Dismiss leads because clearing
     * an expired ask is the likeliest right answer now.
     */
    stale?: boolean;
    busy?: boolean;
    denying?: boolean;
    error?: string;
    onApprove: (jobId: string) => void;
    /** Every id the card folded in — see PendingApproval.jobIds. */
    onDeny: (jobIds: string[]) => void;
    onSeePlan: () => void;
  } = $props();

  const alsoParked = $derived(
    approval.duplicates === 1
      ? "1 older copy of this request is also parked."
      : approval.duplicates > 1
        ? `${approval.duplicates} older copies of this request are also parked.`
        : "",
  );
</script>

<section
  class="approval {compact ? 'compact' : ''} {stale ? 'stale' : ''}"
  aria-labelledby={`approval-${approval.jobId}`}
>
  <p class="approval-flag">
    {#if stale}
      <!-- A clock, not a siren: the state is "old", not "danger". -->
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="6.3"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
        />
        <path
          d="M8 4.6V8l2.4 1.7"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span id={`approval-${approval.jobId}`}
        >Still parked · since {formatWhen(approval.at) || "a while ago"}</span
      >
    {:else}
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path
          d="M8 1.6 15 14H1z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linejoin="round"
        />
        <path
          d="M8 6v3.6"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
        <circle cx="8" cy="11.8" r="0.9" fill="currentColor" />
      </svg>
      <span id={`approval-${approval.jobId}`}>Needs your approval</span>
    {/if}
  </p>

  <p class="approval-ask">{approval.command || "A prepared plan"}</p>

  {#if !compact}
    {#if approval.steps.length}
      <ul class="approval-steps">
        {#each approval.steps as step, index (index)}
          <li>{step.label}</li>
        {/each}
      </ul>
    {/if}

    {#if approval.blocked.length}
      <ul class="approval-why">
        {#each approval.blocked as reason, index (index)}
          <li>{reason.reason || reason.type}</li>
        {/each}
      </ul>
    {/if}
  {/if}

  {#if error}
    <p class="approval-error" role="alert">{error}</p>
  {/if}

  <div class="approval-actions">
    {#if canApprove}
      {#if stale}
        <!--
          The decision has inverted with age: hours later, "clear this" is the
          likely answer and "run a plan I parked before lunch" the risky one —
          so Dismiss takes the lead slot and Approve steps down to the quiet
          outline. Both still one click; only the emphasis moved.
        -->
        <button
          type="button"
          class="button-deny"
          disabled={busy || denying}
          onclick={() => onDeny(approval.jobIds)}
          >{denying ? "Dismissing…" : "Dismiss"}</button
        >
        <button
          type="button"
          class="button-quiet"
          disabled={busy || denying}
          onclick={() => onApprove(approval.jobId)}
          >{busy ? "Running it…" : "Approve and run"}</button
        >
      {:else}
        <button
          type="button"
          class="button-primary"
          disabled={busy || denying}
          onclick={() => onApprove(approval.jobId)}
          >{busy ? "Running it…" : "Approve and run"}</button
        >
        <!--
          The other half of a decision. A card that can only be approved is not a
          question, it is a nag: "no" used to mean leaving it on screen forever.
          Deny runs none of it and clears every copy this card folded in.
        -->
        <button
          type="button"
          class="button-deny"
          disabled={busy || denying}
          onclick={() => onDeny(approval.jobIds)}
          >{denying ? "Dismissing…" : "Deny"}</button
        >
      {/if}
    {:else if !compact}
      <p class="approval-remote">
        Approve this on the Mac dashboard — this page has no route to the Mac.
      </p>
    {/if}
    <button type="button" class="button-quiet" onclick={onSeePlan}
      >{compact ? "Details" : "See the full plan"}</button
    >
  </div>

  {#if !compact && alsoParked}
    <p class="approval-note">{alsoParked}</p>
  {/if}
</section>
