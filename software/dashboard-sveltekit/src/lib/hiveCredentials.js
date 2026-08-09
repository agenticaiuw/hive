/**
 * Credential-inventory view logic for the hive node panel.
 *
 * Ported from `ai-pendant-simulator/hive-dashboard` (the hand-rolled page's
 * `credentialSection` plus the aggregator's per-node filtering) when that page
 * folded into this dashboard. The revoke POST itself stays with the local
 * aggregator, which holds the admin key; the browser only ever names a
 * tokenId.
 *
 * Dependency-free on purpose (no $app, no fetch), so the node test suite can
 * import the exact code the component runs — the same rule as transportRule.js
 * and hiveFeed.js.
 */

/**
 * @typedef {{ tokenId: string, deviceId: string, role: string,
 *   scopeCount: number, scopes: string[], narrowed: boolean,
 *   lastUsedAt: string | null, revokedAt: string | null }} CredentialRow
 * @typedef {{ rows: CredentialRow[], active: number, revoked: number,
 *   byRole: Record<string, number>, scope: string, fleetTotal: number }}
 *   CredentialView
 */

/**
 * The inventory as one node panel shows it, optionally narrowed to one role.
 *
 * The counts are recomputed over the filtered rows. Spreading the fleet-wide
 * block and swapping only its rows array carries the parent's totals through,
 * so with no phone paired the phone panel would read the fleet's numbers over
 * an empty list — the same fix the aggregator's `/api/node/ios` branch
 * carries. `byRole` counts ACTIVE credentials only, matching the aggregator.
 *
 * @param {{ credentials?: CredentialRow[], total?: number } | null | undefined} inventory
 *   the `relay.credentials` source data (live overview only — the aggregator
 *   withholds it from the relay snapshot)
 * @param {string} [role] narrow to this role; "" keeps the whole fleet
 * @returns {CredentialView | null} null when there is no inventory data at all
 */
export function credentialView(inventory, role = "") {
  if (!inventory || !Array.isArray(inventory.credentials)) return null;
  const rows = role
    ? inventory.credentials.filter((entry) => entry?.role === role)
    : inventory.credentials.slice();
  const active = rows.filter((entry) => entry && !entry.revokedAt);
  return {
    rows,
    active: active.length,
    revoked: rows.length - active.length,
    byRole: active.reduce(
      (acc, entry) => ({ ...acc, [entry.role]: (acc[entry.role] || 0) + 1 }),
      /** @type {Record<string, number>} */ ({}),
    ),
    scope: role,
    fleetTotal: Number(inventory.total ?? inventory.credentials.length),
  };
}

/**
 * The sentence for an empty list.
 *
 * An empty FILTERED view means "no device of this kind has ever been paired",
 * not "nothing can act as this hive" — and saying the second under the phone's
 * heading, while the fleet's own credentials are live on the relay panel, is
 * the most dangerous sentence this panel could print.
 *
 * @param {CredentialView} view
 */
export function credentialEmptyText(view) {
  return view.scope
    ? `no ${view.scope} credential has ever been issued — the ${view.fleetTotal} on the relay belong to other devices, and are listed on the Cloud Relay panel`
    : "no device credentials — every client is still on the admin key";
}

/**
 * The armed button's own words. Two clicks, not a confirm() dialog: the armed
 * state names the device on the button itself, so the thing being killed is
 * visible at the moment of the decision rather than in a modal that reads
 * "are you sure".
 *
 * @param {{ role: string, deviceId: string }} row
 */
export function armedRevokeLabel(row) {
  return `kill ${row.role} ${row.deviceId}?`;
}
