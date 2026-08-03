<script lang="ts">
  import { page } from "$app/state";

  // The server's `safeReturnTo` still governs where the 303 actually lands;
  // this is only the value echoed back into the form.
  const returnTo = $derived.by(() => {
    const raw = page.url.searchParams.get("returnTo") ?? "";
    return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
  });
  const failed = $derived(Boolean(page.url.searchParams.get("error")));
</script>

<main class="login-shell">
  <section class="login-card" aria-labelledby="login-title">
    <div class="brand-mark" aria-hidden="true">P</div>
    <p class="kicker">AI Pendant</p>
    <h1 id="login-title">Dashboard</h1>
    <p class="login-copy">Enter your pairing code.</p>

    {#if failed}
      <p class="login-error" role="alert">
        That pairing code was not accepted.
      </p>
    {/if}

    <!-- A native form post, so signing in works before (and without) hydration. -->
    <form class="login-form" action="/api/auth/login" method="post">
      <input type="hidden" name="returnTo" value={returnTo} />
      <label for="accessKey">Pairing code</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        id="accessKey"
        name="accessKey"
        type="password"
        autocomplete="current-password"
        required
        autofocus
      />
      <button type="submit">Continue</button>
    </form>
    <p class="login-note">
      Your code is sent only to the dashboard over HTTPS and never appears in
      the page URL.
    </p>
  </section>
</main>
