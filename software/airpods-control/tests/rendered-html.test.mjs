import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Agentic Audio control surface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Agentic Audio · AirPods Bridge<\/title>/i);
  assert.match(html, /Route your gadget’s voice to AirPods\./);
  assert.match(html, /Connect HUZZAH32/);
  assert.match(html, /nRF A3 \/ P0\.17 · LRC/);
  assert.match(html, /nRF A4 \/ P0\.18 · BCLK/);
  assert.match(html, /nRF A5 \/ P0\.19 · DATA/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("keeps starter preview code out of the finished product", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /navigator as SerialNavigator/);
  assert.match(page, /command:\s*"scan"/);
  assert.match(page, /command:\s*"connect"/);
  assert.match(layout, /Agentic Audio · AirPods Bridge/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /SkeletonPreview|codex-preview/);

  await assert.rejects(
    access(new URL("../app/_sites-preview", import.meta.url)),
  );
});
