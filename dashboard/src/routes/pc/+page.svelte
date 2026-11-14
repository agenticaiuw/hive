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
  let credentialMode = $state('token');
  let text = $state('');
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
  async function submit() {
    busy = true;
    try { await client.submit(text); text = ''; records = await store.read(); }
    catch { notice = 'Could not save or submit the request. Check saved status before trying again.'; records = await store.read(); }
    finally { busy = false; }
  }
  onDestroy(() => { if (timer) clearInterval(timer); store?.close(); });
</script>

<svelte:head><title>Desktop requests</title></svelte:head>
<main class="pc-page">
  <a href="{base}/">← Dashboard</a>
  <h1>Desktop requests</h1>
  {#if !client}
    <p>Connect a paired mobile device to an authorized desktop.</p>
    <form onsubmit={(event) => { event.preventDefault(); connect(); }}>
      <label>Relay URL <input bind:value={relayUrl} type="url" required placeholder="https://relay.example" /></label>
      <label>Mobile device ID <input bind:value={deviceId} required autocomplete="off" /></label>
      <label>Desktop device ID <input bind:value={pcDeviceId} required autocomplete="off" /></label>
      <div class="choice"><label><input type="radio" bind:group={credentialMode} value="token" /> Device token</label><label><input type="radio" bind:group={credentialMode} value="pair" /> Pairing code</label></div>
      <label>{credentialMode === 'pair' ? 'Pairing code' : 'Mobile device token'} <input bind:value={secret} type="password" required autocomplete="off" /></label>
      <p>The credential stays in memory for this visit.{#if credentialMode === 'pair'} Pairing creates a new device credential.{/if}</p>
      <button disabled={busy}>Connect</button>
    </form>
  {:else}
    <form onsubmit={(event) => { event.preventDefault(); submit(); }}>
      <label>Request <textarea bind:value={text} required rows="4" placeholder="What should the desktop do?"></textarea></label>
      <button disabled={busy || !text.trim()}>Send request</button>
    </form>
    <h2>Requests</h2>
    <p>Accepted means the desktop admitted the request; it does not mean the work finished. Keep one Desktop requests page open at a time.</p>
    {#if records.length === 0}<p>No requests saved on this device.</p>{/if}
    <ul>{#each [...records].reverse() as record (record.localId)}<li><strong>{record.status === 'pending' && record.expiresAt && Date.parse(record.expiresAt) <= Date.now() ? 'awaiting result · delivery window elapsed' : record.status}</strong>{#if record.reason} · {record.reason.replaceAll('_', ' ')}{/if}<span>{record.updatedAt}</span></li>{/each}</ul>
  {/if}
  {#if notice}<p role="status">{notice}</p>{/if}
</main>
<style>
  .pc-page { max-width: 42rem; margin: 0 auto; padding: 2rem 1.25rem; }
  h1 { margin: 1.5rem 0 .4rem; } h2 { margin-top: 2rem; }
  p { line-height: 1.5; } form, label { display: grid; gap: .5rem; } form { gap: 1rem; margin-top: 1.5rem; }
  input:not([type='radio']), textarea { width: 100%; box-sizing: border-box; padding: .75rem; border: 1px solid #777; border-radius: .5rem; background: transparent; color: inherit; font: inherit; }
  button { justify-self: start; padding: .7rem 1rem; border: 0; border-radius: .5rem; font: inherit; cursor: pointer; }
  button:disabled { opacity: .55; } .choice { display: flex; gap: 1.5rem; } .choice label { display: flex; align-items: center; }
  ul { list-style: none; padding: 0; } li { padding: .8rem 0; border-bottom: 1px solid #777; } li span { display: block; opacity: .7; font-size: .85rem; margin-top: .25rem; }
</style>
