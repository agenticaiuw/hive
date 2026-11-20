import { readFile } from 'node:fs/promises';
import { compile } from 'svelte/compiler';

// Render the real component in Node without needing a browser or the Worker's bindings.
export async function load(url, context, nextLoad) {
  if (!url.endsWith('.svelte')) return nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  return { format: 'module', shortCircuit: true, source: compile(source, { filename: new URL(url).pathname, generate: 'server' }).js.code };
}
