<script>
  // @ts-nocheck
  import { base } from '$app/paths';
  import { onDestroy } from 'svelte';
  import { pairMeshDevice } from '../../../../cloud/shared/mesh-pairing.mjs';
  import { MobilePcMeshClient } from '../../../../cloud/shared/pc-mesh-client.mjs';
  import { openPcMeshStore } from '../../../../cloud/shared/pc-mesh-store.mjs';

  let relayUrl = $state('');
  let deviceId = $state('');
  let pcDeviceId = $state('');
  let secret = $state('');
  let credentialMode = $state('pair');
  let records = $state([]);
  let busy = $state(false);
  let notice = $state('');
  let client = $state(null);
  let store = null;
  let timer = null;

  async function connect() {
    busy = true; notice = '';
    try {
      const token = credentialMode === 'pair' ? (await pairMeshDevice({ relayUrl, deviceId, deviceType: 'mobile', pairingCode: secret })).token : secret;
      store = await openPcMeshStore({ name: `hivemind-pc-${deviceId}-${pcDeviceId}` });
      client = new MobilePcMeshClient({ relayUrl, token, deviceId, pcDeviceId, store });
      secret = '';
      records = await store.read();
      await refresh();
      timer = setInterval(refresh, 5000);
    } catch {
      store?.close(); store = null; client = null;
      notice = 'Could not connect. Check the relay, device IDs and credential.';
    } finally { busy = false; }
  }
  async function refresh() {
    if (!client) return;
    try { await client.pollOnce(); records = await store.read(); notice = ''; }
    catch { notice = 'Could not refresh results. The last saved statuses are shown.'; }
  }
  onDestroy(() => { if (timer) clearInterval(timer); store?.close(); });
</script>

<svelte:head><title>Settings · Hive</title></svelte:head>
<main class="settings">
  <a class="back" href="{base}/">← Tasks</a>
  <h1>Settings</h1>
  <section aria-labelledby="devices">
    <h2 id="devices">Devices</h2>
    {#if !client}
      <p class="hint">Pair a phone with a desktop through the relay.</p>
      <form onsubmit={(event) => { event.preventDefault(); connect(); }}>
        <label>Relay <input bind:value={relayUrl} type="url" required placeholder="https://relay.example" /></label>
        <label>This device's ID <input bind:value={deviceId} required autocomplete="off" /></label>
        <label>Desktop's ID <input bind:value={pcDeviceId} required autocomplete="off" /></label>
        <div class="choice"><label><input type="radio" bind:group={credentialMode} value="pair" /> Pairing code</label><label><input type="radio" bind:group={credentialMode} value="token" /> Device token</label></div>
        <label>{credentialMode === 'pair' ? 'Pairing code' : 'Device token'} <input bind:value={secret} type="password" required autocomplete="off" /></label>
        <button disabled={busy}>Pair</button>
      </form>
    {:else}
      <p class="hint">Paired with {pcDeviceId}.</p>
      {#if records.length}
        <ul>{#each [...records].reverse() as record (record.localId)}<li><strong>{record.status === 'pending' && record.expiresAt && Date.parse(record.expiresAt) <= Date.now() ? 'awaiting result' : record.status}</strong>{#if record.reason} · {record.reason.replaceAll('_', ' ')}{/if}<span>{record.updatedAt}</span></li>{/each}</ul>
      {/if}
    {/if}
    {#if notice}<p role="status" class="hint">{notice}</p>{/if}
  </section>
</main>
<style>
  .settings { max-width: 640px; margin: 0 auto; padding: var(--s6, 32px) var(--s5, 20px); }
  .back { color: var(--muted); text-decoration: none; font-size: var(--fs-small, 13px); }
  .back:hover { color: var(--ink); }
  h1 { margin: var(--s4, 16px) 0 var(--s5, 20px); font-size: 22px; }
  h2 { margin: 0 0 var(--s2, 8px); font-size: 15px; }
  section { padding: var(--s4, 16px); border: 1px solid var(--line); border-radius: 12px; background: rgba(255, 244, 228, 0.02); }
  .hint { color: var(--muted); margin: 0 0 var(--s3, 12px); line-height: 1.5; }
  form, label { display: grid; gap: 6px; } form { gap: var(--s3, 12px); }
  label { color: var(--muted); font-size: var(--fs-small, 13px); }
  input:not([type='radio']) { width: 100%; box-sizing: border-box; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: rgba(0, 0, 0, 0.2); color: var(--ink); font: inherit; font-size: 14px; }
  .choice { display: flex; gap: var(--s4, 16px); } .choice label { display: flex; align-items: center; gap: 6px; }
  button { justify-self: start; padding: 7px 14px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255, 244, 228, 0.06); color: var(--ink); font: inherit; cursor: pointer; }
  button:disabled { opacity: .55; }
  ul { list-style: none; padding: 0; margin: 0; } li { padding: 8px 0; border-bottom: 1px solid var(--line); } li span { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
</style>
