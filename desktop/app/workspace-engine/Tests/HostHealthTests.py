import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from xml.parsers.expat import ExpatError

spec = importlib.util.spec_from_file_location('health', Path(__file__).resolve().parents[1] / 'scripts/host-health.py')
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class HostHealthTests(unittest.TestCase):
    def test_console_diagnostic_preserves_only_boolean_metadata(self):
        source = dict(IOConsoleLocked=True, IOConsoleUsers=[dict(
            kCGSSessionOnConsoleKey=True, kCGSessionLoginDoneKey=True,
            CGSSessionScreenIsLocked=True, kCGSSessionUserNameKey="private-user",
            kCGSSessionUserIDKey=501)], unrelated="private-content")
        report = health.parse_console_diagnostic(plistlib.dumps(source).decode())
        self.assertEqual(report, dict(state="observed", source="ioreg_undocumented",
            consoleLocked=True, sessions=[dict(onConsole=True, loginComplete=True, screenLocked=True)]))
        self.assertNotIn("private", json.dumps(report))

    def test_console_diagnostic_missing_and_wrong_types_remain_unknown(self):
        source = dict(IOConsoleLocked=0, IOConsoleUsers=[dict(
            kCGSSessionOnConsoleKey=False, kCGSessionLoginDoneKey="yes")])
        report = health.parse_console_diagnostic(plistlib.dumps(source).decode())
        self.assertIsNone(report['consoleLocked'])
        self.assertEqual(report['sessions'], [dict(onConsole=False, loginComplete=None, screenLocked=None)])
        self.assertIsNone(health.parse_console_diagnostic(
            plistlib.dumps(dict(IOConsoleUsers=[])).decode())['consoleLocked'])

    def test_console_diagnostic_rejects_invalid_shapes_and_session_saturation(self):
        for source in [[], {}, dict(IOConsoleUsers={}), dict(IOConsoleUsers=[1]),
                       dict(IOConsoleUsers=[{}] * 33)]:
            with self.assertRaises(ValueError):
                health.parse_console_diagnostic(plistlib.dumps(source).decode())
        self.assertEqual(len(health.parse_console_diagnostic(
            plistlib.dumps(dict(IOConsoleUsers=[{}] * 32)).decode())['sessions']), 32)
        with mock.patch.object(health, 'MAX_OUTPUT', 4):
            with self.assertRaises(ValueError): health.parse_console_diagnostic('too large')

    def test_console_diagnostic_helper_failure_is_content_free_and_unknown(self):
        for failure in [OSError('private-helper-output'),
                        subprocess.TimeoutExpired('private-command', 3),
                        ExpatError('private-parser-data')]:
            with mock.patch.object(health, 'read_command', side_effect=failure), \
                    mock.patch.object(health.time, 'time', return_value=123):
                self.assertEqual(health.console_diagnostic(), dict(state="unavailable",
                    source="ioreg_undocumented", consoleLocked=None, sessions=[], observedAtEpochSeconds=123))

    def test_console_diagnostic_does_not_change_health_admission(self):
        for diagnostic in [dict(state="observed", consoleLocked=True), dict(state="unavailable")]:
            output = io.StringIO()
            with mock.patch.dict(os.environ, {}, clear=True), \
                    mock.patch.object(health.sys, 'platform', 'darwin'), \
                    mock.patch.object(health.sys, 'argv', ['host-health.py']), \
                    mock.patch.object(health.time, 'time', return_value=200000), \
                    mock.patch.object(health.time, 'monotonic', return_value=100), \
                    mock.patch.object(health.time, 'sleep'), \
                    mock.patch.object(health, 'read_command', return_value='{ sec = 1, usec = 0 }'), \
                    mock.patch.object(health, 'snapshot', side_effect=self.samples()), \
                    mock.patch.object(health, 'windowserver_timeouts', return_value=0), \
                    mock.patch.object(health, 'console_diagnostic', return_value=diagnostic), \
                    mock.patch.object(health.sys, 'stdout', output):
                self.assertEqual(health.main(), 0)
            report = json.loads(output.getvalue())
            self.assertTrue(report['admitted'])
            self.assertEqual(report['reasons'], [])
            self.assertEqual(report['consoleSessionDiagnostic'], diagnostic)

    def test_unknown_observation_identifies_only_fixed_input_stage(self):
        for stage in ['sample_before', 'sample_after', 'system_timeout_log']:
            output = io.StringIO()
            failure = OSError('private command output must stay private')
            before, after = self.samples()
            samples = ([failure] if stage == 'sample_before' else
                       [before, failure] if stage == 'sample_after' else [before, after])
            with mock.patch.dict(os.environ, {}, clear=True), \
                    mock.patch.object(health.sys, 'platform', 'darwin'), \
                    mock.patch.object(health.sys, 'argv', ['host-health.py']), \
                    mock.patch.object(health.time, 'time', return_value=200000), \
                    mock.patch.object(health.time, 'monotonic', return_value=100), \
                    mock.patch.object(health.time, 'sleep'), \
                    mock.patch.object(health, 'read_command', return_value='{ sec = 1, usec = 0 }'), \
                    mock.patch.object(health, 'snapshot', side_effect=samples), \
                    mock.patch.object(health, 'windowserver_timeouts', side_effect=failure), \
                    mock.patch.object(health.sys, 'stdout', output):
                self.assertEqual(health.main(), 2)
            report = json.loads(output.getvalue())
            self.assertFalse(report['admitted'])
            self.assertEqual(report['unavailableInput'], stage)
            self.assertEqual(report['reasons'], ['host_health_unknown'])
            self.assertNotIn('private command output', output.getvalue())

    def test_testing_override_keeps_measured_colorsync_load_when_a_later_input_fails(self):
        failure = OSError('private command output must stay private')
        before, after = self.samples()
        busy = dict(schemaVersion=1, admitted=False, reasons=['colorsync_busy'], colorsyncCPUPercent=80.0)
        output = io.StringIO()
        with mock.patch.dict(os.environ, {'SPACEO_LIVE_TESTS': '1', 'SPACEO_TESTING_HOST': '1'}, clear=True), \
                mock.patch.object(health.sys, 'platform', 'darwin'), \
                mock.patch.object(health.sys, 'argv', ['host-health.py']), \
                mock.patch.object(health.time, 'time', return_value=200000), \
                mock.patch.object(health.time, 'monotonic', return_value=100), \
                mock.patch.object(health.time, 'sleep'), \
                mock.patch.object(health, 'read_command', return_value='{ sec = 1, usec = 0 }'), \
                mock.patch.object(health, 'snapshot', side_effect=[before, after]), \
                mock.patch.object(health, 'assess', return_value=busy), \
                mock.patch.object(health, 'windowserver_timeouts', side_effect=failure), \
                mock.patch.object(health.sys, 'stdout', output):
            self.assertEqual(health.main(), 2)
        report = json.loads(output.getvalue())
        self.assertFalse(report['admitted'])
        self.assertTrue(report['testingOverride'])
        self.assertEqual(report['reasons'], ['host_health_unknown', 'colorsync_busy'])

    def test_testing_override_requires_both_flags_and_preserves_observed_refusal(self):
        for env in [{}, {'SPACEO_LIVE_TESTS': '1'}, {'SPACEO_TESTING_HOST': '1'},
                    {'SPACEO_LIVE_TESTS': '0', 'SPACEO_TESTING_HOST': '1'}]:
            self.assertFalse(health.testing_override(env))
        with mock.patch.dict(os.environ, {'SPACEO_LIVE_TESTS': '1', 'SPACEO_TESTING_HOST': '1'}):
            report = health.apply_testing_override(dict(admitted=False, reasons=['memory_pressure']))
            self.assertTrue(report['admitted'])
            self.assertFalse(report['observedAdmitted'])
            self.assertTrue(report['testingOverride'])
            self.assertEqual(report['reasons'], ['memory_pressure'])
            quiet = health.apply_testing_override(dict(admitted=False, reasons=['swap_activity'],
                                                       colorsyncCPUPercent=49.9))
            self.assertTrue(quiet['admitted'])
            # RA-057: measured ColorSync load is never waived; the override keeps the normal limit.
            busy = health.apply_testing_override(dict(admitted=False, reasons=['colorsync_busy', 'swap_activity'],
                                                      colorsyncCPUPercent=50.0))
            self.assertFalse(busy['admitted'])
            self.assertFalse(busy['observedAdmitted'])
            self.assertEqual(busy['reasons'], ['colorsync_busy', 'swap_activity'])
            with mock.patch.object(health.sys, 'platform', 'unsupported'), \
                    mock.patch('sys.stdout', new_callable=io.StringIO) as output:
                self.assertEqual(health.main(), 0)
                self.assertEqual(json.loads(output.getvalue())['reasons'], ['host_health_unknown'])

    def test_system_timeout_check_is_bounded_content_free_and_fail_closed(self):
        with mock.patch.object(health, 'read_command', return_value='[{"eventMessage":"private timeout content"}]') as read:
            self.assertEqual(health.windowserver_timeouts(100, 200), 1)
            command = read.call_args.args[0]
            self.assertEqual(command[:4], ['/usr/bin/log', 'show', '--style', 'json'])
            self.assertIn('--start', command)
            self.assertIn('--end', command)
        for value in ['{}', 'null', '[{}]', 'bad json']:
            with mock.patch.object(health, 'read_command', return_value=value):
                with self.assertRaises(ValueError): health.windowserver_timeouts(100, 200)
        with mock.patch.object(health, 'read_command', return_value='[]'):
            self.assertEqual(health.windowserver_timeouts(100, 200), 0)
            for since in [float('nan'), 201, -100000]:
                with self.assertRaises(ValueError): health.windowserver_timeouts(since, 200)

    def samples(self):
        a = dict(at=1, pressure=1, swap=dict(Swapins=100, Swapouts=200),
                 services={name: (i+1, 10., 1) for i, name in enumerate(health.SERVICES)})
        b = copy.deepcopy(a)
        b['at'] = 6
        return a, b

    def test_quiet_host_with_old_swap_is_admitted(self):
        self.assertTrue(health.assess(*self.samples())['admitted'])

    def test_past_windowserver_reports_are_not_an_admission_input(self):
        # A WindowServer report from earlier in the boot no longer refuses a quiet host.
        report = health.assess(*self.samples())
        self.assertTrue(report['admitted'])
        self.assertNotIn('windowServerDiagnosticReports', report)
        for name in ['windowserver_diagnostics', 'diagnostic_cutoff', 'MAX_DIAGNOSTIC_ENTRIES']:
            self.assertFalse(hasattr(health, name), name)

    def test_cpu_counter_formats_and_service_filtering(self):
        for value, expected in [('403:18.33', 24198.33), ('01:02:03.5', 3723.5), ('2-01:02:03', 176523)]:
            self.assertAlmostEqual(health.cpu_seconds(value), expected)
        text = '1 00:01.00 /private/unrelated app\n' + '\n'.join(
            f'{i+10} 403:18.33 {name}' for i, name in enumerate(health.SERVICES))
        self.assertEqual(len(health.parse_services(text)), 2)
        self.assertEqual(len(health.parse_services(text.splitlines()[1])), 1)
        self.assertEqual(health.parse_services('1 00:00.00 /bin/ps'), {})
        for bad in ['', 'malformed listing', 'invalid ' + health.SERVICES[0], text + '\n' + text.splitlines()[1]]:
            with self.assertRaises(ValueError): health.parse_services(bad)

    IDLE = ["state = not running", "active count = 0", "runs = 23",
            "last exit reason = JETSAM_REASON_MEMORY_IDLE_EXIT",
            "last jetsam exit details = JETSAM_REASON_MEMORY_IDLE_EXIT", "job state = exited",
            "properties = partial import | supports pressured exit | system service"]
    NEVER_STARTED = ["active count = 0", "state = not running", "runs = 0",
                     "last exit code = (never exited)"]

    def record(self, fields, service=None, program=None):
        service = service or health.SERVICES[0]
        # Nested blocks are ignored; only top-level fields are evidence.
        return ("system/" + health.launchd_label(service) + " = {\n\tprogram = " + (program or service) + "\n"
                + "".join("\t" + field + "\n" for field in fields)
                + '\tendpoints = {\n\t\t"x" = {\n\t\t\tpid = 9\n\t\t\tstate = running\n\t\t}\n\t}\n}\n')

    def running_record(self, pid, service, runs=1):
        return self.record(["active count = 2", "state = running", f"runs = {runs}", f"pid = {pid}",
                            "last exit code = (never exited)", "job state = running"], service)

    def test_launchd_evidence_accepts_only_exact_running_idle_exit_and_never_started(self):
        service = health.SERVICES[0]
        self.assertEqual(health.launchd_service(self.record(self.IDLE), service), (None, 23))
        self.assertEqual(health.launchd_service(self.record(self.NEVER_STARTED), service), (None, 0))
        self.assertEqual(health.launchd_service(self.running_record(533, service, 4), service), (533, 4))
        idle = lambda old, new: self.record([new if f.startswith(old) else f for f in self.IDLE if new or not f.startswith(old)])
        for bad in [idle("last exit reason", "last exit reason = JETSAM_REASON_MEMORY_HIGHWATER"),
                    self.record(self.IDLE + ["last terminating signal = Killed: 9"]),
                    self.record(self.IDLE + ["last exit code = 1"]), self.record(self.IDLE + ["pid = 42"]),
                    idle("active count", "active count = 1"), idle("properties", "properties = system service"),
                    idle("job state", "job state = spawn scheduled"), idle("runs", "runs = 0"),
                    idle("state = not running", "state = spawn scheduled"),
                    self.record([f.replace("runs = 0", "runs = 1") for f in self.NEVER_STARTED]),
                    self.record(self.NEVER_STARTED + ["job state = exited"]),
                    self.record(["state = running", "runs = 1"]), self.record(["state = running", "runs = 1", "pid = 0"]),
                    "", "malformed", idle("runs", "runs = -1"), idle("runs", None),
                    self.record(self.IDLE + ["state = not running"]),
                    self.record(self.IDLE, health.SERVICES[1]), self.record(self.IDLE, program="/private/other")]:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError): health.launchd_service(bad, service)

    def services(self, *values):
        return dict(zip(health.SERVICES, values))

    def test_crash_loop_hidden_between_absent_process_listings_is_unknown(self):
        a, b = self.samples()
        a['services'] = self.services((None, None, 5), (None, None, 0))
        b['services'] = self.services((None, None, 7), (None, None, 0))
        with self.assertRaises(ValueError): health.assess(a, b)

    def test_launch_counts_admit_only_stable_idle_or_one_accounted_start(self):
        a, b = self.samples()
        a['services'] = b['services'] = self.services((None, None, 5), (None, None, 0))
        report = health.assess(a, b)
        self.assertTrue(report['admitted'])
        self.assertEqual(report['colorsyncCPUPercent'], 0)
        self.assertEqual(set(report), set(health.assess(*self.samples())))
        b = dict(b, services=self.services((40, .1, 6), (None, None, 0)))
        self.assertEqual(health.assess(a, b)['colorsyncCPUPercent'], 2)
        b = dict(b, services=self.services((40, 2.5, 6), (None, None, 0)))
        self.assertEqual(health.assess(a, b)['reasons'], ['colorsync_busy'])
        for old, new in [((None, None, 5), (40, 0., 7)), ((None, None, 5), (40, 0., 5)),
                         ((None, None, 5), (None, None, 4)), ((40, 1., 3), (40, 1., 4)),
                         ((40, 1., 3), (41, 1., 3)), ((40, 1., 3), (None, None, 3))]:
            a, b = self.samples()
            a['services'] = self.services(old, (None, None, 0))
            b['services'] = self.services(new, (None, None, 0))
            with self.subTest(old=old, new=new):
                with self.assertRaises(ValueError): health.assess(a, b)
        a, b = self.samples()
        del b['services'][health.SERVICES[1]]
        with self.assertRaises(ValueError): health.assess(a, b)

    def test_idle_service_does_not_mask_busy_running_peer(self):
        a, b = self.samples()
        a['services'] = self.services((None, None, 23), (2, 10., 1))
        b['services'] = self.services((None, None, 23), (2, 12.5, 1))
        self.assertEqual(health.assess(a, b)['reasons'], ['colorsync_busy'])

    def test_service_sample_reconciles_process_listings_with_both_exact_jobs(self):
        names, other = health.SERVICES, '1 00:00.01 /sbin/launchd'
        idle0, idle1 = self.record(self.IDLE, names[0]), self.record(self.NEVER_STARTED, names[1])

        def run(outputs):
            if len(outputs) == 4:
                outputs = outputs + outputs[1:3]
            calls = []

            def read(command, until):
                calls.append(command)
                expected = '/bin/ps' if len(calls) in (1, 4) else '/bin/launchctl'
                self.assertEqual(command[0], expected)
                if expected == '/bin/launchctl':
                    index = len(calls)-2 if len(calls) <= 3 else len(calls)-5
                    self.assertEqual(command[1:], ['print', 'system/' + health.launchd_label(names[index])])
                self.assertEqual(until, 99)
                value = outputs[len(calls)-1]
                if value is None:
                    raise ValueError('unreadable')
                return value
            with mock.patch.object(health, 'read_command', side_effect=read), \
                    mock.patch.object(health.time, 'monotonic', return_value=0):
                return health.service_sample(99)[1]

        self.assertEqual(run([other, idle0, idle1, other]), self.services((None, None, 23), (None, None, 0)))
        rows = lambda cpu: '\n'.join([other, f'533 {cpu} {names[0]}', f'546 00:01.00 {names[1]}'])
        self.assertEqual(run([rows('00:01.00'), self.running_record(533, names[0], 2),
                              self.running_record(546, names[1]), rows('00:01.50')]),
                         self.services((533, 1.5, 2), (546, 1., 1)))
        appeared, wrong = other + f'\n533 00:01.00 {names[0]}', other + f'\n534 00:01.00 {names[0]}'
        for outputs in [[other, idle0, idle1, appeared], [appeared, idle0, idle1, other],
                        [other, self.running_record(533, names[0]), idle1, appeared],
                        [wrong, self.running_record(533, names[0]), idle1, wrong],
                        [rows('00:02.00'), self.running_record(533, names[0]), self.running_record(546, names[1]), rows('00:01.00')],
                        [other, None], [None], ['malformed listing'], [other, idle0, 'system/ = {'],
                        [other, idle0, self.record(['state = not running', 'active count = 0', 'runs = 4',
                                                    'last terminating signal = Segmentation fault: 11'], names[1])]]:
            with self.subTest(outputs=outputs):
                with self.assertRaises(ValueError): run(outputs)

    def test_launch_and_exit_after_launchd_read_is_not_hidden_by_absent_process_rows(self):
        other = '1 00:00.01 /sbin/launchd'
        initial = [self.record(self.IDLE, name) for name in health.SERVICES]
        for changed in range(2):
            final = initial.copy()
            final[changed] = final[changed].replace('runs = 23', 'runs = 24')
            outputs = [other, *initial, other, *final]
            with mock.patch.object(health, 'read_command', side_effect=outputs), \
                    mock.patch.object(health.time, 'monotonic', return_value=0):
                with self.assertRaisesRegex(ValueError, 'service changed'):
                    health.service_sample(99)

    def test_snapshot_shares_one_budget_across_every_helper(self):
        clock = [0.]
        seen = []
        records = {health.launchd_label(name): self.record(self.IDLE, name) for name in health.SERVICES}

        def read(command, until):
            seen.append(until - clock[0])
            if until - clock[0] <= 0:
                raise ValueError('snapshot exceeded budget')
            clock[0] += .5
            if command[0] == '/usr/sbin/sysctl': return '1\n'
            if command[0] == '/usr/bin/vm_stat': return 'Swapins: 1.\nSwapouts: 2.\n'
            if command[0] == '/bin/ps': return '1 00:00.01 /sbin/launchd'
            return records[command[2].split('/', 1)[1]]
        with mock.patch.object(health.time, 'monotonic', side_effect=lambda: clock[0]), \
                mock.patch.object(health, 'read_command', side_effect=read):
            with self.assertRaises(ValueError): health.snapshot()
        self.assertEqual(seen, [2.5, 2., 1.5, 1., .5, 0.])
        clock[0], seen[:] = 0., []
        with mock.patch.object(health.time, 'monotonic', side_effect=lambda: clock[0]), \
                mock.patch.object(health, 'read_command', side_effect=read), \
                mock.patch.object(health, 'SNAPSHOT_BUDGET', 4.1):
            self.assertEqual(health.snapshot()['services'], self.services((None, None, 23), (None, None, 23)))
        with self.assertRaises(ValueError): health.read_command([sys.executable, '-c', 'pass'], until=0)

    def test_cpu_observation_time_excludes_asymmetric_trailing_launchd_latency(self):
        clock, calls, capture = [100.], [0], [0]

        def read(command, until):
            calls[0] += 1
            if command[0] == '/usr/sbin/sysctl': return '1\n'
            if command[0] == '/usr/bin/vm_stat': return 'Swapins: 0.\nSwapouts: 0.\n'
            if command[0] == '/bin/ps':
                clock[0] += .05
                # Forty percent of one CPU, continuously, independent of helper latency.
                cpu = .4 * clock[0]
                return f'1 00:00.00 /sbin/launchd\n533 00:{cpu:05.2f} {health.SERVICES[0]}'
            if capture[0] == 0 and calls[0] == 7:
                clock[0] += 2
            service = next(name for name in health.SERVICES
                           if command[-1].endswith(health.launchd_label(name)))
            return (self.running_record(533, service) if service == health.SERVICES[0]
                    else self.record(self.NEVER_STARTED, service))

        with mock.patch.object(health.time, 'monotonic', side_effect=lambda: clock[0]), \
                mock.patch.object(health, 'read_command', side_effect=read):
            before = health.snapshot()
            self.assertAlmostEqual(before['at'], 100.1)
            # The first final validation takes two seconds, still inside the snapshot budget.
            clock[0] += 5
            capture[0], calls[0] = 1, 0
            after = health.snapshot()
        report = health.assess(before, after)
        self.assertEqual(report['intervalSeconds'], 7.1)
        self.assertTrue(report['admitted'])
        self.assertEqual(report['colorsyncCPUPercent'], 40)

    def test_main_paces_from_observation_with_slow_captures_and_sleep_overshoot(self):
        clock, captures, sleeps = [100.], [0], []
        before, _ = self.samples()

        def snapshot():
            result = copy.deepcopy(before)
            if captures[0] == 0:
                result['at'] = clock[0]
                clock[0] += 2.45  # Trailing validation, within the 2.5-second budget.
            else:
                clock[0] += 2.45  # Next capture's work before observing process CPU.
                result['at'] = clock[0]
            captures[0] += 1
            return result

        def sleep(seconds):
            sleeps.append(seconds)
            clock[0] += seconds + .2  # Scheduling may overshoot the requested sleep.

        output = io.StringIO()
        with mock.patch.object(health.sys, 'platform', 'darwin'), \
                mock.patch.object(health.sys, 'argv', ['host-health.py']), \
                mock.patch.object(health.time, 'monotonic', side_effect=lambda: clock[0]), \
                mock.patch.object(health.time, 'time', return_value=200000), \
                mock.patch.object(health.time, 'sleep', side_effect=sleep), \
                mock.patch.object(health, 'read_command', return_value='{ sec = 1, usec = 0 }'), \
                mock.patch.object(health, 'windowserver_timeouts', return_value=0), \
                mock.patch.object(health, 'snapshot', side_effect=snapshot), \
                mock.patch.object(health.sys, 'stdout', output):
            self.assertEqual(health.main(), 0)
        self.assertEqual(captures[0], 2)
        self.assertAlmostEqual(sleeps[0], 2.55)
        report = json.loads(output.getvalue())
        self.assertTrue(report['admitted'])
        self.assertEqual(report['intervalSeconds'], 7.65)

    def test_busy_services_pressure_and_current_swap_refuse(self):
        a, b = self.samples()
        service = health.SERVICES[0]
        b['services'][service] = (a['services'][service][0], 12.5, 1)
        b['pressure'] = 2
        b['swap']['Swapouts'] += 1
        r = health.assess(a, b)
        self.assertFalse(r['admitted'])
        self.assertEqual(r['reasons'], ['memory_pressure', 'colorsync_busy', 'swap_activity'])
        self.assertEqual(r['colorsyncCPUPercent'], 50)
        self.assertNotIn(service, str(r))

    def test_restarts_counter_resets_and_short_intervals_are_unknown(self):
        for field in ['restart', 'cpu_reset', 'swap_reset', 'short', 'nan']:
            a, b = self.samples()
            name = health.SERVICES[0]
            if field == 'restart': b['services'][name] = (99, 10, 1)
            if field == 'cpu_reset': b['services'][name] = (1, 9, 1)
            if field == 'swap_reset': b['swap']['Swapins'] = 0
            if field == 'short': b['at'] = 2
            if field == 'nan': b['at'] = float('nan')
            with self.assertRaises(ValueError): health.assess(a, b)

    def test_helpers_are_bounded_and_nonzero_is_not_evidence(self):
        self.assertEqual(health.read_command([sys.executable, '-c', 'print("ok")']), 'ok\n')
        for code in ['raise SystemExit(1)', 'print("x" * (1024*1024+1))', 'import time; time.sleep(10)']:
            with self.assertRaises(ValueError): health.read_command([sys.executable, '-c', code])

    def test_matrix_refusal_does_not_start_mcp(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            helper = root / 'python3'
            helper.write_text('#!/bin/sh\nexit 1\n')
            helper.chmod(0o700)
            binary = root / 'fake-spaceo'
            # If reached, the marker is emitted independently of any live daemon or display.
            binary.write_text('#!/bin/sh\necho MCP_MUST_NOT_START >&2\nexit 99\n')
            binary.chmod(0o700)
            script = Path(__file__).resolve().parents[1] / 'scripts/computer-use-check.mjs'
            result = subprocess.run(['node', str(script), str(binary)], capture_output=True,
                text=True, timeout=5, env=dict(os.environ, SPACEO_LIVE_TESTS='1',
                PATH=str(root)+os.pathsep+os.environ['PATH']))
            self.assertEqual(result.returncode, 1)
            self.assertIn('host is not quiet enough', result.stderr)
            self.assertNotIn('MCP_MUST_NOT_START', result.stderr)


if __name__ == '__main__':
    unittest.main()
