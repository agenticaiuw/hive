"""Durable provider waiting, configured proxy only, and stop fencing."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
os.environ.setdefault('AGENT_ENV_FILE', '/dev/null')
import agent
import provider_wait
import task_recovery
import voice_agent

class ProviderWaitTests(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {'AGENT_STATE_DIR': tempfile.mkdtemp()})
        self.env.start(); self.addCleanup(self.env.stop)

    def test_checks_persist_and_are_rate_limited(self):
        self.assertEqual(provider_wait.reserve('one', now=100, arm=True)['state'], 'check')
        self.assertEqual(provider_wait.reserve('one', now=101, arm=True), {'state': 'waiting', 'delay': 299})
        self.assertTrue(provider_wait.exists('one'))
        self.assertEqual(provider_wait.reserve('one', now=400, arm=False)['state'], 'check')
        self.assertTrue(provider_wait.resolve('one'))
        self.assertFalse(provider_wait.exists('one'))
        self.assertEqual(provider_wait.reserve('one', now=401, arm=True)['state'], 'waiting')
        self.assertTrue(provider_wait.exists('one'))

    def test_never_attempts_direct_network_when_proxy_missing(self):
        with mock.patch('provider_wait.urllib.request.getproxies', return_value={}), \
             mock.patch('provider_wait.http.client.HTTPSConnection') as connect:
            self.assertFalse(provider_wait.reachable())
            connect.assert_not_called()

    def test_probe_uses_proxy_tunnel_without_credentials(self):
        connection = mock.Mock(); connection.getresponse.return_value.status = 200
        with mock.patch('provider_wait.urllib.request.getproxies', return_value={'https': 'http://127.0.0.1:7769'}), \
             mock.patch('provider_wait.http.client.HTTPSConnection', return_value=connection) as connect:
            self.assertTrue(provider_wait.reachable())
        connect.assert_called_once_with('127.0.0.1', 7769, timeout=8)
        connection.set_tunnel.assert_called_once_with('chatgpt.com', 443)
        connection.request.assert_called_once_with('HEAD', '/')

    def test_user_stop_or_pause_prevents_probe_and_resume(self):
        identity = task_recovery.begin('work', 'mac', 'thread')
        task_recovery.finish(identity, 'stopped')
        task = agent.CodexTask('work'); task._recovery_id = identity
        with mock.patch('provider_wait.reachable') as probe:
            self.assertFalse(task._wait_for_provider(arm=True))
        probe.assert_not_called()
        self.assertFalse(provider_wait.exists(identity))
        self.assertEqual(task_recovery.current()['status'], 'stopped')

    def test_restore_waits_before_reconnecting_saved_thread(self):
        identity = task_recovery.begin('work', 'mac', 'thread')
        record = task_recovery.current()
        provider_wait.reserve(identity, now=100, arm=True)
        task = agent.CodexTask('work'); task._startup_record = record
        with mock.patch.object(agent, 'device_tools', return_value={}), \
             mock.patch.object(task, '_wait_for_provider', return_value=False) as wait, \
             mock.patch.object(agent, 'codex_server') as server:
            task._restore_task()
        wait.assert_called_once_with(arm=False)
        server.assert_not_called()

    def test_wait_resumes_only_after_proxy_probe_succeeds(self):
        identity = task_recovery.begin('work', 'mac', 'thread')
        task = agent.CodexTask('work'); task._recovery_id = identity
        with mock.patch('provider_wait.reserve', side_effect=[{'state': 'check'}, {'state': 'check'}]), \
             mock.patch('provider_wait.reachable', side_effect=[False, True]) as probe, \
             mock.patch('provider_wait.resolve', return_value=True) as resolve, \
             mock.patch.object(task._done, 'wait', return_value=False):
            self.assertTrue(task._wait_for_provider(arm=True))
        self.assertEqual(probe.call_count, 2)
        resolve.assert_called_once_with(identity)
        self.assertTrue(task._provider_available)

    def test_wait_survives_restarts_but_resolved_dispatch_is_not_repeated(self):
        identity = task_recovery.begin('work', 'mac', 'thread')
        provider_wait.reserve(identity, now=100, arm=True)
        self.assertEqual(voice_agent.startup_recovery_record()['id'], identity)
        self.assertEqual(voice_agent.startup_recovery_record()['id'], identity)
        self.assertEqual(task_recovery.current()['startup_attempts'], 0)
        provider_wait.resolve(identity)
        self.assertIsNone(voice_agent.startup_recovery_record())

    def test_stopped_wait_is_not_recovered_after_restart(self):
        identity = task_recovery.begin('work', 'mac', 'thread')
        provider_wait.reserve(identity, now=100, arm=True)
        task_recovery.finish(identity, 'stopped')
        self.assertIsNone(voice_agent.startup_recovery_record())

    def test_closed_workspace_is_never_reopened_by_provider_recovery(self):
        identity = task_recovery.begin('work', 'mac', 'thread')
        task = agent.CodexTask('work'); task._recovery_id = identity
        def stop_waiting(_):
            task._done.set()
        with mock.patch.dict(os.environ, {'AGENT_SPACEO_COMMAND':'spaceo'}), \
             mock.patch('provider_wait.reserve', return_value={'state':'check'}), \
             mock.patch('provider_wait.reachable', return_value=True), \
             mock.patch('provider_wait.resolve') as resolve, \
             mock.patch.object(task._done, 'wait', side_effect=stop_waiting):
            self.assertFalse(task._wait_for_provider(arm=True))
        resolve.assert_not_called()
        self.assertEqual(task_recovery.current()['status'], 'active')

    def test_expired_wait_never_probes_or_dispatches(self):
        identity = task_recovery.begin('work', 'mac', 'thread')
        task = agent.CodexTask('work'); task._recovery_id = identity; task.session = mock.Mock()
        with mock.patch('provider_wait.reserve', return_value={'state':'expired'}), \
             mock.patch('provider_wait.reachable') as probe:
            self.assertFalse(task._wait_for_provider(arm=True))
        probe.assert_not_called(); self.assertIn('recovery window', task._ended)

if __name__ == '__main__':
    unittest.main()
