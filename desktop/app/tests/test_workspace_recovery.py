"""Startup latch recovery; tests never touch a display, daemon or the real journal."""
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import workspace_recovery


def engine(report, clear=(0, 'cleared', '')):
    calls = []
    def run(command, timeout):
        calls.append(command[1:])
        if command[1:] == ['doctor', '--json']:
            return (1, report if isinstance(report, str) else json.dumps(report), 'progress')
        if command[1:] == ['daemon', 'stop']:
            return (0, '', '')
        if command[1:] == ['safety', 'clear-host-health', '--operator']:
            return clear
        raise AssertionError(command)
    return run, calls


class WorkspaceRecoveryTests(unittest.TestCase):
    def test_healthy_engine_is_left_alone(self):
        run, calls = engine({'displaySafety': {'state': 'ready'}, 'displays': {'spaceO': [4]}})
        self.assertEqual(workspace_recovery.recover_if_latched('spaceo', run), ('not-latched', ''))
        self.assertEqual(calls, [['doctor', '--json']])

    def test_idle_host_health_latch_is_cleared_with_the_engine_command(self):
        run, calls = engine({'displaySafety': {'state': 'blocked', 'reason': 'host health: swap_activity'},
                             'displays': {'spaceO': []}})
        self.assertEqual(workspace_recovery.recover_if_latched('spaceo', run),
                         ('cleared', 'host health: swap_activity'))
        self.assertEqual(calls, [['doctor', '--json'], ['daemon', 'stop'],
                                 ['safety', 'clear-host-health', '--operator']])

    def test_engine_refusal_is_reported_not_retried(self):
        run, calls = engine({'displaySafety': {'state': 'blocked',
                                               'reason': 'host health: host_health_unknown (colorsync_launchd_unreadable)'}},
                            clear=(1, '', 'error: host health is not ready: swap_activity\n'))
        outcome, detail = workspace_recovery.recover_if_latched('spaceo', run)
        self.assertEqual(outcome, 'refused')
        self.assertIn('swap_activity', detail)
        self.assertEqual(calls.count(['safety', 'clear-host-health', '--operator']), 1)

    def test_online_display_other_failures_and_unreadable_reports_change_nothing(self):
        cases = [
            {'displaySafety': {'state': 'blocked', 'reason': 'host health: memory_pressure'},
             'displays': {'spaceO': [4]}},
            {'displaySafety': {'state': 'blocked', 'reason': 'unfinished display mutation'}},
            {'displaySafety': {'state': 'unknown'}},
            'not json',
        ]
        for report in cases:
            run, calls = engine(report)
            outcome, _ = workspace_recovery.recover_if_latched('spaceo', run)
            self.assertEqual(outcome, 'skipped')
            self.assertEqual(calls, [['doctor', '--json']])


if __name__ == '__main__':
    unittest.main()
