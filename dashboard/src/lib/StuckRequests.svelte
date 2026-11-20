<script lang="ts">
  import type { Agent } from "./agents.js";

  let { agents }: { agents: Agent[] } = $props();
  const stuck = $derived(agents.filter((agent) => agent.status === "stuck"));
</script>

<!-- The sidebar folds away on phones. Stuck requests belong in the main page too, even before
     planning has given them any tasks. Use the same status and conversation as the sidebar. -->
{#if stuck.length}
  <section aria-labelledby="stuck-requests">
    <h2 id="stuck-requests">Stuck <span>{stuck.length}</span></h2>
    <ul>
      {#each stuck as agent (agent.key)}
        <li><a href={`#/agent/${encodeURIComponent(agent.key)}`}>{agent.title}</a></li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  section {
    margin-top: var(--s5);
  }
  h2 {
    color: var(--amber);
    font-size: var(--fs-small);
    margin-bottom: var(--s2);
  }
  h2 span {
    margin-left: var(--s1);
  }
  ul {
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--card);
  }
  a {
    display: block;
    padding: 12px 16px;
    border-radius: 14px;
    overflow-wrap: anywhere;
  }
  a:hover {
    background: var(--card-hover);
  }
</style>
