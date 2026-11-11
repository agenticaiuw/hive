"""Authentication boundaries with synthetic credentials; no device/account interaction."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import credentials
import phone
import mac_mcp
import phone_mcp

SECRET = '654321'
SOURCE = '''<AppiumAUT><XCUIElementTypeApplication name="SpringBoard" visible="true">
<XCUIElementTypeStaticText label="Enter iPhone Passcode" visible="true"/>
<XCUIElementTypeSecureTextField label="Passcode" visible="true"/>
</XCUIElementTypeApplication></AppiumAUT>'''


class FakePhone:
    base = 'https://phone.example.test'
    def __init__(self):
        self.owner = 'com.apple.springboard'
        self.source = SOURCE
        self.sent = []
        self.accept = True
        self.uuid = '12345678-1234-1234-1234-123456789abc'
    def request(self, path, method='GET', body=None, **kw):
        if path == '/api/wda/device/info': return {'value': {'uuid': self.uuid}}
        if path == '/api/wda/activeAppInfo': return {'value': {'bundleId': self.owner}}
        if path == '/api/wda/locked': return {'value': not self.accept}
        if path.endswith('/value'):
            self.sent.append((path, body, kw))
            if self.accept: self.source = '<AppiumAUT/>'
            return {'value': None}
        raise AssertionError(path)
    def session(self): return '/api/session/S1'
    def in_session(self, path, method='GET', body=None):
        if path == '/source': return {'value': self.source}
        if path == '/elements': return {'value': [{'ELEMENT': 'secure-1'}]}
        raise AssertionError(path)


class CredentialTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, AGENT_STATE_DIR=self.temp.name)
        env.start(); self.addCleanup(env.stop)
        self.p = FakePhone()
        self.read = patch('credentials.native', return_value=SECRET.encode()).start()
        self.addCleanup(patch.stopall)
        patch('credentials.time.sleep').start()

    def test_phone_exact_secure_field_and_secret_free_result(self):
        result = credentials.authenticate_phone(self.p)
        self.assertNotIn(SECRET, result)
        self.assertEqual(self.p.sent, [('/api/session/S1/element/secure-1/value',
                                      {'value':[SECRET]}, {'sensitive':True})])
        self.assertFalse(list(Path(self.temp.name).rglob('*.attempt')))

    def test_rejected_passcode_cannot_be_retried_across_instances(self):
        self.p.accept = False
        with self.assertRaises(credentials.CredentialError): credentials.authenticate_phone(self.p)
        with self.assertRaisesRegex(credentials.CredentialError, 'previous authentication'):
            credentials.authenticate_phone(self.p)
        self.assertEqual(len(self.p.sent), 1)

    def test_webpage_cannot_request_device_passcode(self):
        self.p.owner = 'com.apple.mobilesafari'
        with self.assertRaises(credentials.CredentialError): credentials.authenticate_phone(self.p)
        self.read.assert_not_called()
        self.assertFalse(self.p.sent)

    def test_reject_failed_attempt_and_passcode_change_screens(self):
        for text in ['Incorrect passcode', 'Enter new passcode', 'Try again in 1 minute', 'Confirm payment']:
            with self.subTest(text=text):
                self.p.source = SOURCE.replace('Enter iPhone Passcode', 'Enter iPhone Passcode ' + text)
                with self.assertRaises(credentials.CredentialError): credentials.authenticate_phone(self.p)
        self.read.assert_not_called()

    def test_no_http_or_unknown_device(self):
        self.p.base = 'http://phone.example.test'
        with self.assertRaises(credentials.CredentialError): credentials.authenticate_phone(self.p)
        self.p.base = 'https://phone.example.test'; self.p.uuid = 'unknown'
        with self.assertRaises(credentials.CredentialError): credentials.authenticate_phone(self.p)
        self.read.assert_not_called()

    def test_device_changed_before_write(self):
        def read(*a, **kw):
            self.p.uuid = '00000000-0000-0000-0000-000000000000'
            return SECRET.encode()
        self.read.side_effect = read
        with self.assertRaisesRegex(credentials.CredentialError, 'changed'):
            credentials.authenticate_phone(self.p)
        self.assertFalse(self.p.sent)

    def test_mac_respects_user_takeover(self):
        tools = mac_mcp.MacTools()
        tools.mac = Mock()
        tools.mac.is_engaged.return_value = False
        result = tools.call('authenticate', {})
        self.assertTrue(result['isError'])
        self.read.assert_not_called()

    def test_mac_password_is_typed_into_focus_then_return(self):
        import agent_vhid
        caps = [True]
        class FakeFlags:
            def __call__(self, _): return (1 << 16) if caps[0] else 0
        class FakeCG:
            CGEventSourceFlagsState = FakeFlags()
        class FakeMac:
            def __init__(self, **kw): self.events = []
            def is_engaged(self): return True
            def key(self, key):
                self.events.append(key)
                if key == 'capslock': caps[0] = not caps[0]
            def _keys(self, *keys): self.events.append(keys)
            def close(self): pass
        instance = FakeMac()
        self.read.side_effect = lambda action, **kw: (
            'com.apple.keylayout.ABC' if action == 'keyboard-layout'
            else b'Ab9!' if action == 'read-mac' else '')
        with patch.object(agent_vhid, 'AgentVHID', return_value=instance), patch('credentials.ctypes.CDLL', return_value=FakeCG()):
            result = credentials.authenticate_mac()
        self.assertTrue(caps[0])  # Caps Lock turned off for typing, then restored
        self.assertEqual(instance.events[0], 'capslock')
        self.assertEqual(instance.events[-2:], ['return', 'capslock'])
        self.assertEqual(sum(1 for e in instance.events if isinstance(e, tuple) and len(e) == 2), 4)
        self.assertNotIn('Ab9!', result)
        self.assertEqual([c.args[0] for c in self.read.call_args_list], ['keyboard-layout', 'read-mac'])

    def test_tools_take_no_secret_arguments_and_are_not_batchable(self):
        for module in [mac_mcp, phone_mcp]:
            tool = next(t for t in module.TOOLS if t['name'] == 'authenticate')
            self.assertFalse(tool['inputSchema']['additionalProperties'])
            self.assertEqual(tool['inputSchema']['properties'], {})
            self.assertNotIn('authenticate', module.BATCHABLE)
        result = phone_mcp.PhoneTools(self.p).call('authenticate', {'passcode': SECRET})
        self.assertTrue(result['isError'])
        self.assertNotIn(SECRET, str(result))
        self.read.assert_not_called()

    def test_batch_runs_authenticate_only_alone_and_without_arguments(self):
        tools = Mock()
        tools.call.return_value = mac_mcp.result(mac_mcp.text('filled'))
        alone = mac_mcp.run_batch(tools, {'steps': [{'tool': 'authenticate'}]}, mac_mcp.BATCHABLE)
        self.assertFalse(alone.get('isError'))
        tools.call.assert_called_once_with('authenticate', {})
        tools.call.reset_mock()
        for steps in ([{'tool': 'authenticate'}, {'tool': 'click', 'x': 1, 'y': 2}],
                      [{'tool': 'authenticate', 'password': SECRET}]):
            refused = mac_mcp.run_batch(tools, {'steps': steps}, mac_mcp.BATCHABLE)
            self.assertTrue(refused['isError'])
            self.assertNotIn(SECRET, str(refused))
        tools.call.assert_not_called()


# Sensitive transport behavior is exercised through the Rust fixture in test_phone_rust.

if __name__ == '__main__': unittest.main()
