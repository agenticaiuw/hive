#!/usr/bin/env python3
"""Deterministic report validation; no app, display or input access."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('performance_summary', ROOT / 'scripts/performance-summary.py')
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

class Reports(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.write('summary.json', dict(ok=True, topologyRestored=True, elapsedSeconds=10,
            phases=[dict(phase='idle', elapsedSeconds=0)]))
        self.write('sample-starts.json', dict(daemon=0))
        rows = [dict(elapsedSeconds=t, sample=dict(cpuUserSeconds=t*.02, cpuSystemSeconds=0,
                    physicalFootprintBytes=1048576*(10+t), interruptWakeups=t*3)) for t in range(11)]
        (self.root/'daemon-resources.jsonl').write_text('\n'.join(map(json.dumps, rows)))
        self.write('operations.json', [dict(command='ping', ms=n) for n in range(1,21)])

    def write(self, name, value):
        (self.root/name).write_text(json.dumps(value))

    def test_phase_edges_cpu_memory_and_percentiles(self):
        result = report.summarize(self.root)
        phase = result['resources']['daemon']['idle']
        self.assertEqual(phase['samples'], 8)
        self.assertEqual(phase['cpuPercent'], 2)
        self.assertEqual(phase['footprintPeakMiB'], 18)
        self.assertEqual(phase['interruptWakeupsPerSecond'], 3)
        self.assertEqual(result['latencies']['ping'], dict(count=20,p50Ms=10.5,p95Ms=19,p99Ms=20))

    def test_failed_run_stays_failed_and_empty_health_is_not_permission_evidence(self):
        self.write('summary.json', dict(ok=False, topologyRestored=False, elapsedSeconds=10,
                                      phases=[dict(phase='cleanup',elapsedSeconds=0)]))
        (self.root/'viewer-health.jsonl').write_text('')
        result = report.summarize(self.root)
        self.assertFalse(result['ok'])
        self.assertFalse(result['topologyRestored'])
        self.assertFalse(result['viewerEvidence']['screenRecordingGranted'])
        self.assertEqual(result['viewerEvidence']['maxFPS'],0)

    def test_unknown_role_rejected(self):
        self.write('sample-starts.json', {'../private':0})
        with self.assertRaises(ValueError): report.summarize(self.root)

    def test_testing_override_preserved_and_legacy_is_unknown(self):
        self.assertIsNone(report.summarize(self.root)['testingOverride'])
        summary = json.loads((self.root / 'summary.json').read_text())
        for value in (True, False):
            summary['testingOverride'] = value
            self.write('summary.json', summary)
            self.assertIs(report.summarize(self.root)['testingOverride'], value)
        summary['testingOverride'] = 'false'
        self.write('summary.json', summary)
        with self.assertRaises(ValueError): report.summarize(self.root)

    def test_focused_coverage_survives_summary_and_legacy_coverage_is_unknown(self):
        self.assertIsNone(report.summarize(self.root)['requestedViewerModes'])
        summary = json.loads((self.root / 'summary.json').read_text())
        summary['requestedViewerModes'] = ['static', 'scrolling']
        self.write('summary.json', summary)
        self.assertEqual(report.summarize(self.root)['requestedViewerModes'], ['static', 'scrolling'])
        summary['requestedViewerModes'] = ['animated', 'unknown']
        self.write('summary.json', summary)
        with self.assertRaises(ValueError): report.summarize(self.root)

    def test_fixture_progress_is_separate_from_viewer_delivery(self):
        self.write('fixture-health.json', [
            dict(mode='animated',visibility='hidden',frames=0),
            dict(mode='animated',visibility='visible',frames=12)])
        result = report.summarize(self.root)
        self.assertEqual(result['fixtureEvidence']['animated'],dict(
            samples=2,visibleSamples=1,hiddenSamples=1,minFrames=0,maxFrames=12))
        self.assertEqual(result['fixtureEvidence']['scrolling']['samples'],0)
        self.assertIsNone(result['fixtureEvidence']['scrolling']['maxFrames'])

    def test_oversized_report_rejected(self):
        with (self.root/'operations.json').open('wb') as f: f.truncate(16*1024*1024+1)
        with self.assertRaises(ValueError): report.summarize(self.root)

    def test_fifo_and_symlink_reports_are_refused_without_waiting_for_a_writer(self):
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        with self.assertRaises(ValueError): report.read(fifo)
        link = self.root / 'link'
        link.symlink_to(fifo)
        with self.assertRaises(OSError): report.read(link)

if __name__ == '__main__': unittest.main()
