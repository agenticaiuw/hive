"""UI admission precedes dispatch and stop survives receipt-store failures."""
import os
import queue
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
os.environ.setdefault('AGENT_ENV_FILE', '/dev/null')
from voice_agent import VoiceAgent
import ui_ingress

class UIIngressTests(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {'AGENT_STATE_DIR': tempfile.mkdtemp()})
        self.env.start()
        self.addCleanup(self.env.stop)

    def voice(self):
        a = VoiceAgent.__new__(VoiceAgent)
        a.ahead = a.timing = None
        a.over_its_voice = False
        a.voice = None
        a.input_mode = 'voice'
        a.captions = mock.Mock()
        a.tasks = {'mac': None, 'phone': None}
        a.doing = {}
        a.last_said = {}
        a.events = queue.Queue()
        a.out = mock.Mock(); a.log = mock.Mock(); a.say = mock.Mock()
        a.tell = mock.Mock(); a.show_doing = mock.Mock(); a.hand_back = mock.Mock()
        a.take_control = mock.Mock()
        return a

    def test_ui_admission_before_start_and_receipt_linked(self):
        a = self.voice(); calls = []
        task = mock.Mock(); task.start.side_effect = lambda: calls.append('start')
        with mock.patch('ui_ingress.admit', side_effect=lambda text, channel: calls.append('admit') or 'receipt-1'), \
             mock.patch('ui_ingress.finish', side_effect=lambda receipt, status: calls.append('finish')), \
             mock.patch('voice_agent.CodexTask', return_value=task), \
             mock.patch('voice_agent.notify'):
            a.on_transcript('Do useful work', typed=True)
        self.assertEqual(calls, ['admit', 'start', 'finish'])
        self.assertEqual(task._receipt_id, 'receipt-1')

    def test_store_failure_fails_closed_before_new_work(self):
        a = self.voice()
        with mock.patch('ui_ingress.admit', side_effect=OSError('unavailable')), \
             mock.patch('voice_agent.CodexTask') as task:
            a.on_transcript('Do useful work', typed=True)
        task.assert_not_called()

    def test_stop_executes_before_failed_receipt(self):
        a = self.voice(); task = mock.Mock(running=True); a.tasks['mac'] = task
        with mock.patch('ui_ingress.admit', side_effect=OSError('unavailable')):
            a.on_transcript('stop', typed=True)
        task.stop.assert_called_once()
        self.assertIsNone(a.tasks['mac'])

    def test_stop_fences_a_persisted_wait_without_an_in_memory_task(self):
        import provider_wait, task_recovery
        identity = task_recovery.begin('work', 'mac', 'thread')
        provider_wait.arm(identity)
        a = self.voice()
        with mock.patch('ui_ingress.admit', return_value='receipt'), mock.patch('ui_ingress.finish'):
            a.on_transcript('stop', typed=True)
        self.assertEqual(task_recovery.current()['status'], 'stopped')

    def test_previously_captured_socket_request_is_not_recaptured(self):
        a = self.voice(); task = mock.Mock()
        with mock.patch('ui_ingress.admit') as admit, mock.patch('voice_agent.CodexTask', return_value=task), \
             mock.patch('voice_agent.notify'):
            a.on_transcript('Do useful work', typed=True, captured=True, ingress_receipt='socket-receipt')
        admit.assert_not_called()
        self.assertEqual(task._receipt_id, 'socket-receipt')

    def test_short_acknowledgement_is_captured_without_starting_work(self):
        a = self.voice()
        with mock.patch('ui_ingress.admit', return_value='receipt') as admit, \
             mock.patch('ui_ingress.finish') as finish, mock.patch('voice_agent.CodexTask') as task:
            a.on_transcript('okay', typed=True)
        admit.assert_called_once_with('okay', 'typed')
        finish.assert_called_once_with('receipt', 'accepted')
        task.assert_not_called()

    def test_real_ledger_receipt_is_durable_and_private(self):
        if not os.access(ui_ingress.LEDGER, os.X_OK):
            self.skipTest('build ledger helper first')
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(ui_ingress, 'state_dir', return_value=Path(directory)):
            receipt = ui_ingress.admit('Make the project plan', 'voice')
            control = Path(directory) / 'control'
            listing = lambda: json.loads(subprocess.run([str(ui_ingress.LEDGER), str(control)],
                check=True, capture_output=True, text=True).stdout)
            self.assertEqual((listing()[0]['receiptId'], listing()[0]['status']), (receipt, 'dispatching'))
            self.assertNotIn(b'Make the project plan', (control / 'request-ledger.sqlite3').read_bytes())
            ui_ingress.finish(receipt, 'accepted')
            self.assertEqual(listing()[0]['status'], 'accepted')

if __name__ == '__main__':
    unittest.main()
