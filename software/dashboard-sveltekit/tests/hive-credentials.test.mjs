import assert from "node:assert/strict";
import test from "node:test";

import {
  armedRevokeLabel,
  credentialEmptyText,
  credentialView,
} from "../src/lib/hiveCredentials.js";

const row = (overrides = {}) => ({
  tokenId: "tok_1",
  deviceId: "device-1",
  role: "mac_bridge",
  scopeCount: 3,
  scopes: ["mac:execute", "ops:read", "state:write"],
  narrowed: false,
  lastUsedAt: "2026-08-09T05:00:00.000Z",
  revokedAt: null,
  ...overrides,
});

test("counts the fleet and groups active credentials by role", () => {
  const view = credentialView({
    credentials: [
      row(),
      row({ tokenId: "tok_2", role: "mobile", deviceId: "phone-1" }),
      row({ tokenId: "tok_3", role: "mobile", revokedAt: "2026-08-01T00:00:00Z" }),
    ],
    total: 3,
  });
  assert.equal(view.rows.length, 3);
  assert.equal(view.active, 2);
  assert.equal(view.revoked, 1);
  // byRole counts ACTIVE credentials only, matching the aggregator.
  assert.deepEqual(view.byRole, { mac_bridge: 1, mobile: 1 });
  assert.equal(view.scope, "");
  assert.equal(view.fleetTotal, 3);
});

test("narrowing to one role recomputes the counts over the filtered rows", () => {
  // The bug this guards: spreading the fleet block and swapping only the rows
  // carried the fleet's totals through, so an empty phone panel read
  // "1 active · 10 revoked" over no rows.
  const view = credentialView(
    {
      credentials: [row(), row({ tokenId: "tok_2", revokedAt: "2026-08-01T00:00:00Z" })],
      total: 2,
    },
    "mobile",
  );
  assert.equal(view.rows.length, 0);
  assert.equal(view.active, 0);
  assert.equal(view.revoked, 0);
  assert.deepEqual(view.byRole, {});
  assert.equal(view.scope, "mobile");
  // The fleet total survives so the empty sentence can point at the relay panel.
  assert.equal(view.fleetTotal, 2);
});

test("returns null when there is no inventory data at all", () => {
  assert.equal(credentialView(null), null);
  assert.equal(credentialView(undefined, "mobile"), null);
  assert.equal(credentialView({}, "mobile"), null);
});

test("an empty filtered list is honest about which filter produced it", () => {
  const fleet = credentialView({ credentials: [], total: 0 });
  assert.equal(
    credentialEmptyText(fleet),
    "no device credentials — every client is still on the admin key",
  );

  const phone = credentialView(
    { credentials: [row(), row({ tokenId: "tok_2" })], total: 2 },
    "mobile",
  );
  // Never "nothing can act as this hive" under the phone's heading while the
  // fleet's credentials are live on the relay panel.
  assert.equal(
    credentialEmptyText(phone),
    "no mobile credential has ever been issued — the 2 on the relay belong to other devices, and are listed on the Cloud Relay panel",
  );
});

test("the armed button names exactly what is about to be killed", () => {
  assert.equal(
    armedRevokeLabel({ role: "mobile", deviceId: "evans-iphone" }),
    "kill mobile evans-iphone?",
  );
});
