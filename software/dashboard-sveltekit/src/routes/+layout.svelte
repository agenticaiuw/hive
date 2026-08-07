<script lang="ts">
  import "../app.css";
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types";

  const TITLE = "AI Pendant Dashboard";
  const DESCRIPTION =
    "Live Cloudflare, Mac bridge, microphone, and voice pipeline diagnostics for the AI Pendant.";

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<svelte:head>
  <title>{TITLE}</title>
  <meta name="description" content={DESCRIPTION} />
  <meta property="og:title" content={TITLE} />
  <meta property="og:description" content={DESCRIPTION} />
  <meta property="og:type" content="website" />
  <meta property="og:image" content={data.imageUrl} />
  <meta property="og:image:width" content="1731" />
  <meta property="og:image:height" content="909" />
  <meta property="og:image:alt" content={TITLE} />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={TITLE} />
  <meta name="twitter:description" content={DESCRIPTION} />
  <meta name="twitter:image" content={data.imageUrl} />
</svelte:head>

{@render children()}
