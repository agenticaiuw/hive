"""Local authentication broker. Tool arguments/results contain no credentials.

Configuration is a native secure-entry sheet; secrets live in macOS Keychain.
Phone passcodes are bound to the relay and WDA's device UUID, and sent once over
HTTPS in curl's stdin, never argv. This does not replace account passwords or OTPs.
"""
from __future__ import annotations
import hashlib
import ctypes
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]


class CredentialError(Exception):
    pass


def executable():
    # Prefer the installed, signed Hive bundle. A present but damaged bundle must
    # not silently redirect credential operations to an older or unsigned copy.
    bundles = [Path.home() / 'Applications/Hive.app',
               Path.home() / 'Applications/Agent.app',
               ROOT / 'build/Agent.app']
    for bundle in bundles:
        if not bundle.exists() and not bundle.is_symlink():
            continue
        path = bundle / 'Contents/MacOS/Agent'
        if bundle.is_symlink() or not bundle.is_dir() or path.is_symlink() or not path.is_file() or not os.access(path, os.X_OK):
            raise CredentialError('The selected local authentication helper is unavailable.')
        return str(path)
    raise CredentialError('Build Hive first with make build/Agent.app.')


def native(*args, secret=False):
    try:
        run = subprocess.run([executable(), '--credential', *args], capture_output=True, timeout=12)
    except (OSError, subprocess.TimeoutExpired):
        raise CredentialError('The local authentication helper did not finish. No automatic retry.') from None
    if run.returncode:
        # Read-phone errors must never accidentally echo stdout or a credential.
        if secret:
            raise CredentialError('Saved password unavailable or Keychain locked. Configure it in Hive → Authentication.')
        raise CredentialError(run.stderr.decode('utf-8', errors='replace').strip() or 'Authentication unavailable.')
    return run.stdout if secret else run.stdout.decode('utf-8').strip()


def phone_account(phone):
    if urlparse(phone.base).scheme != 'https':
        raise CredentialError('Phone credentials require an HTTPS relay.')
    info = phone.request('/api/wda/device/info').get('value') or {}
    uuid = info.get('uuid', '')
    if not re.fullmatch(r'[A-Fa-f0-9-]{32,36}', uuid):
        raise CredentialError('Could not verify the connected phone identity. No credential was used.')
    return 'phone:' + hashlib.sha256((phone.base + '\0' + uuid).encode()).hexdigest()


def attempt_path(account):
    from resumable_thread import state_dir
    folder = state_dir() / 'authentication'
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    return folder / (hashlib.sha256(account.encode()).hexdigest() + '.attempt')


def claim_attempt(account):
    path = attempt_path(account)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise CredentialError('A previous authentication attempt was not confirmed. Check the device and re-save the credential in Authentication before another attempt.') from None
    os.close(fd)
    return path


def authenticate_mac():
    """Types the saved Mac password with the agent's keyboard into the field that has the keyboard
    focus, then presses Return, the way the user would. The agent clicks the password field first.
    The password goes from the Keychain through a private pipe to the keyboard, never into model
    arguments, tool results, logs, argv or the clipboard."""
    from agent_vhid import AgentVHID, CHARS, MODIFIERS
    secret = bytearray()
    mac = AgentVHID(human=False)
    caps_changed = False
    cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    cg.CGEventSourceFlagsState.argtypes = [ctypes.c_int32]
    cg.CGEventSourceFlagsState.restype = ctypes.c_uint64
    caps_on = lambda: bool(cg.CGEventSourceFlagsState(1) & (1 << 16))
    try:
        if not mac.is_engaged():
            raise CredentialError('The user has control. Call mac.wait_for_control, then authenticate again.')
        if native('keyboard-layout') not in ('com.apple.keylayout.ABC', 'com.apple.keylayout.US'):
            raise CredentialError('The keyboard layout is not ABC/US, so the password would be typed wrong.')
        secret = bytearray(native('read-mac', secret=True))
        value = secret.decode('utf-8')
        if not value or any(ch not in CHARS for ch in value):
            raise CredentialError('The saved password has characters the keyboard path cannot type.')
        if caps_on():
            mac.key('capslock')
            caps_changed = True
        for ch in value:
            usage, shifted = CHARS[ch]
            mods = MODIFIERS['shift'] if shifted else 0
            if mods: mac._keys(mods)
            mac._keys(mods, usage)
            mac._keys(0)
        mac.key('return')
        time.sleep(0.5)
        return 'Typed the saved Mac password into the focused field and pressed Return. Take a screenshot to see the result.'
    except CredentialError:
        raise
    except Exception:
        raise CredentialError('Could not type the saved Mac password. Take a screenshot and try again.') from None
    finally:
        for i in range(len(secret)): secret[i] = 0
        try:
            if caps_changed and mac.is_engaged() and not caps_on(): mac.key('capslock')
            mac.close()
        except Exception: pass


def phone_prompt(phone):
    app = phone.request('/api/wda/activeAppInfo').get('value') or {}
    if app.get('bundleId') != 'com.apple.springboard':
        raise CredentialError('The phone is not showing a verified system passcode screen.')
    root = ET.fromstring(phone.in_session('/source')['value'])
    visible = [e for e in root.iter() if e.attrib.get('visible') == 'true']
    # Only labels: never read a secure field's value into model-visible diagnostics.
    text = ' '.join((e.attrib.get('label') or e.attrib.get('name') or '') for e in visible).lower()
    denied = ('incorrect', 'try again', 'failed', 'attempts remaining', 'unavailable', 'disabled',
              'new passcode', 'change passcode', 'reset', 'erase', 'payment', 'pay ', 'purchase')
    if any(word in text for word in denied) or not ('enter passcode' in text or 'enter iphone passcode' in text):
        raise CredentialError('This is not a supported sign-in/unlock passcode prompt, or it shows a failed attempt.')
    fields = [e for e in visible if e.tag == 'XCUIElementTypeSecureTextField']
    if len(fields) != 1:
        raise CredentialError('This passcode screen does not expose one secure field; unlock it yourself.')
    return phone.session()


def authenticate_phone(phone):
    # Checks precede secret access. Never fall back to coordinates, generic keys or clipboard.
    account = phone_account(phone)
    session = phone_prompt(phone)
    found = phone.in_session('/elements', 'POST', {
        'using': 'predicate string', 'value': "type == 'XCUIElementTypeSecureTextField' AND visible == 1"}).get('value')
    if not isinstance(found, list) or len(found) != 1:
        raise CredentialError('Cannot target the system passcode field unambiguously.')
    element = found[0].get('ELEMENT') or found[0].get('element-6066-11e4-a52e-4f735466cecf')
    if not isinstance(element, str) or not re.fullmatch(r'[\w-]+', element):
        raise CredentialError('Invalid secure field identifier.')
    secret = bytearray(native('read-phone', account, secret=True))
    try:
        if not re.fullmatch(rb'[0-9]{4,12}', secret):
            raise CredentialError('The saved phone passcode is not supported. Configure a numeric passcode in Authentication.')
        if phone_account(phone) != account or phone_prompt(phone) != session:
            raise CredentialError('The phone or authentication screen changed. No credential was used.')
        marker = claim_attempt(account)
        # One addressed field write; unlike in_session(), this never recreates a session and retries.
        phone.request(session + '/element/' + element + '/value', 'POST',
                      {'value': [secret.decode('ascii')]}, sensitive=True)
        time.sleep(0.8)
        locked = phone.request('/api/wda/locked').get('value')
        if locked is not False:
            raise CredentialError('The phone has not confirmed it is unlocked. No retry; check it yourself.')
        source = phone.in_session('/source')['value']
        if any('passcode' in (e.attrib.get('label') or e.attrib.get('name') or '').lower()
               for e in ET.fromstring(source).iter() if e.attrib.get('visible') == 'true'
               and e.tag == 'XCUIElementTypeSecureTextField'):
            raise CredentialError('The passcode prompt is still present. No automatic retry.')
        marker.unlink(missing_ok=True)
        return 'Phone passcode prompt completed. Verify the account sign-in result on screen.'
    finally:
        for i in range(len(secret)): secret[i] = 0


def main():
    import settings
    settings.load()
    if len(sys.argv) != 3 or sys.argv[1] != 'configure' or sys.argv[2] not in ('mac', 'phone'):
        print('Usage: credentials.py configure mac|phone')
        return 2
    try:
        if sys.argv[2] == 'phone':
            from phone import Phone
            account = phone_account(Phone())
        else:
            account = 'mac'
        # Only this user-invoked setup route displays the secure native entry sheet.
        run = subprocess.run([executable(), '--credential', 'configure', account])
        if run.returncode == 0:
            attempt_path(account).unlink(missing_ok=True)
        return run.returncode
    except Exception:
        message = ('Phone credential setup needs the configured phone online and unlocked. '
                   'Run Pocket Connect on the phone, then try again.' if sys.argv[2] == 'phone'
                   else 'Authentication setup could not start.')
        subprocess.run(['osascript', '-e', 'display alert "Authentication setup" message ' + json.dumps(message)],
                       capture_output=True)
        print(message)
        return 1


if __name__ == '__main__':
    sys.exit(main())
