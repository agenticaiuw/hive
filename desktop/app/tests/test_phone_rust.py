"""Exercise the Rust phone transport with a synthetic curl, never the phone."""
import json
import os
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch

from tests import test_tools  # adds python/ to sys.path
import phone


class RustPhoneTransportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        (root / 'private').mkdir()
        (root / 'endpoint.txt').write_text('http://fixture.invalid')
        (root / 'private' / 'secrets.json').write_text(json.dumps({'CONTROL_TOKEN': 'synthetic-token'}))
        curl = root / 'curl'
        curl.write_text('''#!/usr/bin/python3
import json, os, sys
config = sys.stdin.read()
with open(os.environ['PHONE_FIXTURE_LOG'], 'a') as f:
    f.write(json.dumps({'args': sys.argv[1:], 'stdin': config}) + '\\n')
mode = os.environ.get('PHONE_FIXTURE_MODE', 'ok')
if mode == 'tls':
    sys.exit(35)
if mode == 'timeout':
    sys.stderr.write('synthetic secret')
    sys.exit(28)
if mode == 'busy':
    print('{}\\n429', end='')
else:
    print('{"value": null}\\n200', end='')
''')
        curl.chmod(0o755)
        self.log = root / 'calls'
        self.env = patch.dict(os.environ, {'PATH': str(root) + ':' + os.environ['PATH'], 'PHONE_FIXTURE_LOG': str(self.log)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.phone = phone.Phone(str(root))

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_token_and_body_are_only_on_stdin(self):
        self.phone.request('/api/secret', 'POST', {'value': ['synthetic secret']}, sensitive=True)
        calls = self.calls()
        self.assertEqual(len(calls), 1)
        self.assertNotIn('synthetic-token', repr(calls[0]['args']))
        self.assertNotIn('synthetic secret', repr(calls[0]['args']))
        self.assertIn('synthetic-token', calls[0]['stdin'])
        self.assertIn('synthetic secret', calls[0]['stdin'])

    def test_action_plans_are_pure_and_unknown_action_fails(self):
        plan = self.phone._call('action_plan', body={'name': 'swipe', 'args': {
            'from_x': 1, 'from_y': 2, 'to_x': 3, 'to_y': 4, 'seconds': .3}})
        self.assertEqual(plan, {'path': '/wda/dragfromtoforduration', 'in_session': True,
                                'body': {'fromX': 1, 'fromY': 2, 'toX': 3, 'toY': 4, 'duration': .3}})
        with self.assertRaises(phone.PhoneError):
            self.phone._call('action_plan', body={'name': 'unknown', 'args': {}})
        self.assertFalse(self.log.exists())

    def test_invalid_bundle_never_contacts_relay(self):
        with self.assertRaises(phone.PhoneError):
            self.phone.open_app('bad/bundle')
        self.assertFalse(self.log.exists())

    def test_accessibility_xml_escapes_redaction_and_secure_values(self):
        (Path(self.tmp.name) / 'private' / 'secrets.json').write_text(json.dumps({'CONTROL_TOKEN': 'synthetic-token-1234'}))
        source = ('<AppiumAUT><XCUIElementTypeButton visible="true" x="0" y="1" width="5" height="3" '
                  'label="Café &amp; tea" value="synthetic-token-1234"/>'
                  '<XCUIElementTypeSecureTextField visible="true" x="1" y="2" width="2" height="2" '
                  'label="Password" value="hidden passcode"/></AppiumAUT>')
        self.phone.in_session = lambda *_: {'value': source}
        self.assertEqual(self.phone.elements(), ['(2, 2) Button "Café & tea" value="[hidden]"',
                                                '(2, 3) SecureTextField "Password"'])
        self.assertFalse(self.log.exists())

    def test_malformed_accessibility_xml_still_raises_parse_error(self):
        self.phone.in_session = lambda *_: {'value': '<AppiumAUT><Broken></AppiumAUT>'}
        with self.assertRaises(ET.ParseError):
            self.phone.elements()

    def test_namespace_and_dtd_use_compatibility_parser_with_redaction(self):
        (Path(self.tmp.name) / 'private' / 'secrets.json').write_text(json.dumps({'CONTROL_TOKEN': 'synthetic-token-1234'}))
        sources = [
            '<AppiumAUT xmlns:x="urn:test"><x:XCUIElementTypeButton visible="true" x="0" y="0" '
            'width="2" height="2" label="Namespace" value="synthetic-token-1234"/></AppiumAUT>',
            '<!DOCTYPE AppiumAUT [<!ENTITY title "Entity">]><AppiumAUT><XCUIElementTypeButton '
            'visible="true" x="0" y="0" width="2" height="2" label="&title;" '
            'value="synthetic-token-1234"/></AppiumAUT>',
        ]
        for source in sources:
            with self.subTest(source=source):
                self.phone.in_session = lambda *_: {'value': source}
                lines = self.phone.elements()
                self.assertEqual(len(lines), 1)
                self.assertIn('value="[hidden]"', lines[0])
                self.assertNotIn('synthetic-token-1234', lines[0])
        self.assertFalse(self.log.exists())

    def test_unicode_element_ids_follow_python_validation_before_click(self):
        calls = []
        self.phone.in_session = lambda *args: calls.append(args)
        self.phone._call = lambda *args, **kwargs: 'é-2'
        self.phone.tap_element('test')
        self.assertEqual(calls, [('/element/é-2/click', 'POST', {})])
        self.phone._call = lambda *args, **kwargs: 'e\u0301'
        with self.assertRaises(phone.PhoneError):
            self.phone.tap_element('test')
        self.assertEqual(len(calls), 1)

    def test_sensitive_busy_and_failure_do_not_retry_or_echo(self):
        for mode in ('busy', 'timeout', 'tls'):
            with self.subTest(mode=mode):
                self.log.unlink(missing_ok=True)
                with patch.dict(os.environ, {'PHONE_FIXTURE_MODE': mode}):
                    with self.assertRaises(phone.PhoneError) as caught:
                        self.phone.request('/api/secret', 'POST', {'value': ['synthetic secret']}, sensitive=True)
                self.assertEqual(len(self.calls()), 1)
                self.assertNotIn('synthetic secret', str(caught.exception))

if __name__ == '__main__':
    unittest.main()
