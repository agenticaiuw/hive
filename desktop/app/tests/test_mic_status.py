"""A system-audio tap that dies must not be reported as working."""
import io
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python'))
import mic


class Tap:
    def __init__(self, data, error=b'', code=1):
        self.stdout = io.BytesIO(data)
        self.stderr = io.BytesIO(error)
        self.returncode = code

    def wait(self):
        return self.returncode


class TapStatus(unittest.TestCase):
    def make_mic(self, tap):
        m = mic.Microphone.__new__(mic.Microphone)
        m.active = True
        m._current_tap = tap
        m.tap_error = None
        m._tap_data_at = 0.0
        m.from_mac = lambda _: None
        return m

    def test_connected_but_stalled_tap_is_not_reported_working(self):
        tap = Tap(b'')
        m = self.make_mic(tap)
        m._canceller = object()
        self.assertIn("unverified", m.describe())

    def test_eof_after_valid_header_reports_failure(self):
        tap = Tap(b'16000 1\n', b'agent-vhid-tap: capture failed')
        m = self.make_mic(tap)
        m._read_tap(tap)
        self.assertEqual(m.tap_error, 'capture failed')

    def test_dead_tap_does_not_count_as_hearing_mac(self):
        tap = Tap(b'16000 1\n')
        m = self.make_mic(tap)
        m._canceller = object()
        m.heard_mac_at = time.monotonic()
        m._read_tap(tap)
        self.assertFalse(m.hears_the_mac())

    def test_replaced_tap_cannot_overwrite_current_status(self):
        old = Tap(b'', b'old failure')
        m = self.make_mic(Tap(b''))
        m.tap_error = None
        m._read_tap(old)
        self.assertIsNone(m.tap_error)

    def test_inactive_tap_stop_is_not_failure(self):
        tap = Tap(b'16000 1\n')
        m = self.make_mic(tap)
        m.active = False
        m._read_tap(tap)
        self.assertIsNone(m.tap_error)

if __name__ == '__main__':
    unittest.main()
