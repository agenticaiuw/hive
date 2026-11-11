"""Recovery admission is durable and never replays a reserved continuation."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import task_recovery
import agent


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {'AGENT_STATE_DIR': tempfile.mkdtemp()})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_reservations_and_stop_survive_reload(self):
        identity = task_recovery.begin('do the work', 'mac', 'thread-1')
        self.assertEqual(task_recovery.reserve('startup')['id'], identity)
        self.assertIsNone(task_recovery.reserve('startup'))
        self.assertEqual(task_recovery.reserve('blocked', identity)['id'], identity)
        self.assertIsNone(task_recovery.reserve('blocked', identity))
        task_recovery.finish(identity, 'stopped')
        self.assertIsNone(task_recovery.reserve('startup'))
        self.assertIsNone(task_recovery.reserve('blocked', identity))

    def test_old_owner_cannot_stop_new_request(self):
        old = task_recovery.begin('old', 'mac', 'thread-1')
        new = task_recovery.begin('new', 'mac', 'thread-1')
        self.assertFalse(task_recovery.finish(old, 'stopped'))
        self.assertEqual(task_recovery.reserve('startup')['id'], new)

    def test_stopped_task_refuses_continuation_admission(self):
        task = agent.CodexTask('task')
        task._server = mock.Mock()
        task._stopped = True
        with self.assertRaises(agent.ResumeError):
            task._continuation_start({'threadId': 'thread'})
        task._server.request.assert_not_called()

    def test_maintenance_interrupt_preserves_authorization_but_user_stop_fences(self):
        identity = task_recovery.begin('work', 'mac', 'thread-1')
        task = agent.CodexTask('work')
        task._recovery_id = identity
        task._interrupt = mock.Mock()
        task.stop_for_maintenance()
        self.assertEqual(task_recovery.current()['status'], 'active')
        task._interrupt.assert_called_once()
        next_task = agent.CodexTask('work')
        next_task._recovery_id = identity
        next_task.stop()
        self.assertEqual(task_recovery.current()['status'], 'stopped')

    def test_owner_lock_prevents_second_process_owner(self):
        owner = task_recovery.acquire_owner()
        self.assertIsNotNone(owner)
        self.assertIsNone(task_recovery.acquire_owner())
        owner.close()
        second = task_recovery.acquire_owner()
        self.assertIsNotNone(second)
        second.close()

    def test_invalid_record_fails_closed(self):
        (Path(os.environ['AGENT_STATE_DIR']) / 'task-recovery.json').write_text('{}')
        with self.assertRaises(ValueError):
            task_recovery.reserve('startup')

    def test_request_text_is_never_saved_and_legacy_records_are_scrubbed(self):
        secret = 'unlabeled sensitive request text'
        identity = task_recovery.begin(secret, 'mac', 'thread-1')
        path = Path(os.environ['AGENT_STATE_DIR']) / 'task-recovery.json'
        self.assertNotIn(secret, path.read_text())
        legacy = task_recovery.current()
        legacy['task'] = secret
        path.write_text(__import__('json').dumps(legacy))
        self.assertEqual(task_recovery.reserve('startup')['id'], identity)
        self.assertNotIn(secret, path.read_text())
        self.assertNotIn('task', task_recovery.current())

    def test_recovery_links_to_the_ingress_receipt_without_request_text(self):
        receipt = 'a' * 32
        identity = task_recovery.begin('sensitive instruction', 'mac', 'thread-1', receipt_id=receipt)
        record = task_recovery.current()
        self.assertEqual((record['id'], record['receiptId']), (identity, receipt))
        self.assertNotIn('sensitive instruction', str(record))

    def test_blocked_goal_gets_one_same_thread_reassessment(self):
        identity = task_recovery.begin('two tasks', 'mac', 'thread-1')
        task = agent.CodexTask('two tasks')
        task._recovery_id = identity
        task._thread, task._turn = 'thread-1', 'turn-1'
        task._between_goal_turns = True
        task._server = mock.Mock()
        task._server.request.side_effect = lambda method, params, timeout: (
            {'goal': {'status': 'blocked'}} if method == 'thread/goal/get' else
            {'thread': {'status': {'type': 'idle'}}} if method == 'thread/read' else
            {'turn': {'id': 'turn-2'}})
        task._await_goal_continuation('turn-1')
        calls = task._server.request.call_args_list
        self.assertEqual([c.args[0] for c in calls], ['thread/goal/get', 'thread/read', 'thread/goal/get', 'turn/start'])
        request = calls[-1].args[1]
        self.assertEqual(request['threadId'], 'thread-1')
        self.assertIn('outcome is uncertain', request['input'][0]['text'])
        self.assertIsNone(task_recovery.reserve('blocked', identity))

    def test_goal_paused_during_blocked_check_never_wakes(self):
        identity = task_recovery.begin('two tasks', 'mac', 'thread-1')
        task = agent.CodexTask('two tasks')
        task._recovery_id = identity
        task._thread, task._turn = 'thread-1', 'turn-1'
        task._between_goal_turns = True
        task._server = mock.Mock()
        statuses = iter(['blocked', 'paused', 'paused'])
        task._server.request.side_effect = lambda method, params, timeout: (
            {'goal': {'status': next(statuses)}} if method == 'thread/goal/get' else
            {'thread': {'status': {'type': 'idle'}}})
        task.session = mock.Mock()
        task._await_goal_continuation('turn-1')
        self.assertNotIn('turn/start', [c.args[0] for c in task._server.request.call_args_list])
        self.assertEqual(task_recovery.current()['blocked_attempts'], 0)

    def test_blocked_completion_waits_for_idle_before_one_reassessment(self):
        identity = task_recovery.begin('two tasks', 'mac', 'thread-1')
        task = agent.CodexTask('two tasks')
        task._recovery_id = identity
        task._thread, task._turn = 'thread-1', 'turn-1'
        task._between_goal_turns = True
        task._done.wait = mock.Mock()
        task._server = mock.Mock()
        states = iter(['active', 'idle'])
        task._server.request.side_effect = lambda method, params, timeout: (
            {'goal': {'status': 'blocked'}} if method == 'thread/goal/get' else
            {'thread': {'status': {'type': next(states)}}} if method == 'thread/read' else
            {'turn': {'id': 'turn-2'}})
        task._await_goal_continuation('turn-1')
        self.assertEqual(sum(c.args[0] == 'turn/start' for c in task._server.request.call_args_list), 1)
        task._done.wait.assert_called_once_with(1)

    def test_provider_routing_failure_retries_once_without_replaying_task(self):
        task = agent.CodexTask('original request')
        task._thread, task._turn = 'thread-1', 'turn-1'
        task._between_goal_turns = True
        task._routing_failure = True
        task._server = mock.Mock()
        task._server.request.side_effect = lambda method, params, timeout: (
            {'goal': None} if method == 'thread/goal/get' else
            {'thread': {'status': {'type': 'idle'}}} if method == 'thread/read' else
            {'turn': {'id': 'turn-2'}})
        task._await_goal_continuation('turn-1')
        request = task._server.request.call_args_list[-1].args[1]
        self.assertEqual(request['threadId'], 'thread-1')
        self.assertNotIn('original request', request['input'][0]['text'])
        self.assertIn('outcome is uncertain', request['input'][0]['text'])
        self.assertFalse(task._routing_retry_available)
        task.session = mock.Mock()
        task._await_goal_continuation('turn-1')
        self.assertEqual(sum(c.args[0] == 'turn/start' for c in task._server.request.call_args_list), 1)
        self.assertIn('Provider routing remained unavailable', task._ended)

    def test_routing_failure_classifier_is_narrow(self):
        self.assertTrue(agent.CodexTask._recoverable_goal_error({'message': 'workspace routing discovery failed',
                                                                  'codexErrorInfo': 'other'}))
        self.assertFalse(agent.CodexTask._recoverable_goal_error({'message': 'permission denied',
                                                                   'codexErrorInfo': 'other'}))

    def test_startup_without_goal_uses_saved_thread_and_new_instruction(self):
        identity = task_recovery.begin('original request', 'mac', 'thread-1')
        record = task_recovery.reserve('startup')
        task = agent.CodexTask('original request')
        task._startup_record = record
        task.session = mock.Mock()
        task.session.thread_for.return_value = ('thread-1', '')
        server = mock.Mock()
        server.request.side_effect = lambda method, params, timeout: (
            {'goal': None} if method == 'thread/goal/get' else
            {'thread': {'status': {'type': 'idle'}}} if method == 'thread/read' else
            {'turn': {'id': 'turn-2'}})
        with mock.patch.object(agent, 'device_tools', return_value={}), \
             mock.patch.object(agent, 'codex_server', return_value=server), \
             mock.patch.object(agent, 'thread_params', return_value={}):
            task._restore_task()
        self.assertEqual(task._recovery_id, identity)
        self.assertEqual(task.session.thread_for.call_args.kwargs['expected_thread'], 'thread-1')
        request = server.request.call_args_list[-1].args[1]
        self.assertEqual(request['threadId'], 'thread-1')
        self.assertNotIn('original request', request['input'][0]['text'])
        self.assertIn('uncertain outcomes', request['input'][0]['text'])

if __name__ == '__main__':
    unittest.main()
