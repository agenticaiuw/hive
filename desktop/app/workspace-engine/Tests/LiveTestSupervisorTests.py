"""Fault injection uses only disposable Python children, never WindowServer."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest


SUPERVISOR = Path(__file__).resolve().parents[1] / "scripts/live-test-supervisor.py"


class LiveTestSupervisorTests(unittest.TestCase):
    def run_fixture(self, child, case_timeout=0.2, run_timeout=2):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "live.log"
            pid_path = Path(directory) / "child.pid"
            child = ("import os; from pathlib import Path; "
                     f"Path({str(pid_path)!r}).write_text(str(os.getpid())); " + child)
            script = (
                "import importlib.util,sys; sys.dont_write_bytecode=True; "
                "s=importlib.util.spec_from_file_location('supervisor',sys.argv[1]); "
                "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                "sys.exit(m.supervise([sys.executable,'-u','-c',sys.argv[3]],sys.argv[2],"
                f"case_timeout={case_timeout},run_timeout={run_timeout}))"
            )
            try:
                result = subprocess.run([sys.executable, "-c", script, str(SUPERVISOR),
                                         str(log), child], capture_output=True, timeout=5)
                contents = log.read_text()
                self.assertEqual(log.stat().st_mode & 0o777, 0o600)
                if result.returncode == 124:
                    state = subprocess.check_output(
                        ["ps", "-o", "stat=", "-p", pid_path.read_text()], text=True, timeout=2)
                    self.assertIn("T", state, "the retained fixture child must actually be stopped")
                return result.returncode, contents
            finally:
                # Only the disposable fixture group we just created; production never kills.
                if pid_path.exists():
                    try:
                        os.killpg(int(pid_path.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_preserves_exit_code_and_log(self):
        code, log = self.run_fixture("print('fixture failure'); raise SystemExit(7)")
        self.assertEqual(code, 7)
        self.assertIn("fixture failure", log)

    def test_case_deadline_does_not_depend_on_more_output(self):
        code, log = self.run_fixture(
            "import time; print(\"Test Case 'fixture' started.\"); time.sleep(10)")
        self.assertEqual(code, 124)
        self.assertIn("suspended", log)

    def test_whole_run_deadline_handles_a_silent_child(self):
        code, log = self.run_fixture("import time; time.sleep(10)", run_timeout=0.2)
        self.assertEqual(code, 124)
        self.assertIn("No automatic kill or retry", log)

    def test_case_completion_clears_case_deadline(self):
        code, _ = self.run_fixture(
            "import time; print(\"Test Case 'fixture' started.\"); "
            "print(\"Test Case 'fixture' passed (0.01 seconds).\"); time.sleep(0.4)")
        self.assertEqual(code, 0)

    def test_terminal_hangup_suspends_the_isolated_child(self):
        code, log = self.run_fixture(
            "import signal,time; os.kill(os.getppid(), signal.SIGHUP); time.sleep(10)")
        self.assertEqual(code, 124)
        self.assertIn("suspended", log)
        self.assertIn("No automatic kill or retry", log)

    def test_unverified_cleanup_request_retains_the_child_for_inspection(self):
        code, log = self.run_fixture(
            "import time; print('LIVE SAFETY STOP REQUEST: cleanup unverified'); time.sleep(10)")
        self.assertEqual(code, 124)
        self.assertIn("suspended", log)


if __name__ == "__main__":
    unittest.main()
