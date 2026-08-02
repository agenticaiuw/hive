import { Capacitor, registerPlugin } from '@capacitor/core'

const WEB_STORAGE_KEY = 'pendantDeviceCredential'
const SecureStorage = registerPlugin('PendantSecureStorage')

/**
 * Device credentials are secrets, unlike the relay URL and device name.
 *
 * The iOS build stores the credential in the Keychain. The browser fallback
 * uses localStorage so the web controller can survive a reload; it must only
 * receive a scoped device token, never the relay administrator key.
 */
export async function loadDeviceCredential() {
  if (Capacitor.isNativePlatform()) {
    const result = await SecureStorage.get()
    return decodeCredential(result?.value)
  }

  return decodeCredential(globalThis.localStorage?.getItem(WEB_STORAGE_KEY))
}

export async function storeDeviceCredential(credential) {
  const value = encodeCredential(credential)

  if (Capacitor.isNativePlatform()) {
    await SecureStorage.set({ value })
    return
  }

  globalThis.localStorage?.setItem(WEB_STORAGE_KEY, value)
}

export async function clearDeviceCredential() {
  if (Capacitor.isNativePlatform()) {
    await SecureStorage.remove()
    return
  }

  globalThis.localStorage?.removeItem(WEB_STORAGE_KEY)
}

export function isNativeCredentialStorage() {
  return Capacitor.isNativePlatform()
}

function encodeCredential(credential) {
  if (!credential || typeof credential !== 'object') {
    throw new TypeError('A device credential object is required.')
  }

  const token = String(credential.token || '').trim()
  if (!token) {
    throw new TypeError('The device credential is missing its token.')
  }

  return JSON.stringify({
    token,
    tokenId: credential.tokenId || null,
    role: credential.role || 'device',
    scopes: Array.isArray(credential.scopes) ? credential.scopes : [],
    expiresAt: credential.expiresAt || null,
  })
}

function decodeCredential(value) {
  if (!value) {
    return null
  }

  try {
    const credential = JSON.parse(value)
    return credential && typeof credential.token === 'string' && credential.token
      ? credential
      : null
  } catch {
    return null
  }
}
