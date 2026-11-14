// @ts-nocheck
// Calls the existing relay pairing endpoint. The caller owns secure storage of
// the returned token and must obtain the pairing code from the user.
export async function pairMeshDevice({ relayUrl, deviceId, deviceType, pairingCode, name = deviceId, fetchImpl = fetch }) {
  const url = new URL(relayUrl);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('Invalid relay URL');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(deviceId) || !['mobile', 'mac_bridge'].includes(deviceType) || typeof pairingCode !== 'string' || !pairingCode.trim()) throw new Error('Invalid pairing configuration');
  const response = await fetchImpl(new URL('/v1/devices/pair', url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, deviceType, name, pairingCode }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Device pairing failed');
  const data = await response.json();
  if (!data?.ok || data.device?.deviceId !== deviceId || data.device?.deviceType !== deviceType || typeof data.credential?.token !== 'string' || !data.credential.token) throw new Error('Invalid pairing response');
  return { deviceId, deviceType, token: data.credential.token };
}
