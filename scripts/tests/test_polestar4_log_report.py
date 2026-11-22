import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "polestar4-log-report.py"


def run_report(log):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "log.json"
        path.write_text(json.dumps(log), encoding="utf-8")
        return subprocess.run([sys.executable, str(SCRIPT), str(path)], capture_output=True, text=True)


def sample(collected, reported, locked, status="success"):
    return {"collectedAt": collected, "exterior": {
        "status": status, "reportedAt": reported, "locked": locked,
    }}


class P4LogReportTests(unittest.TestCase):
    def test_desktop_compares_only_valid_reports_before_the_next_lock_attempt(self):
        note = lambda time, action: {"recordedAt": time, "action": action, "outcome": "before"}
        log = {
            "format": "norr-p4-test-log", "version": 1,
            "testerObservations": [note(1000, "unlock"), note(1500, "lock"), note(2500, "unlock")],
            "readings": [sample(1002, 1000, False), sample(1300, 1250, True),
                         sample(1400, 1350, False, "failed"), sample(1600, 1550, True),
                         sample(2800, 3000, False), sample(2700, None, False)],
        }
        result = run_report(log)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("新上报 1 条，末次为已锁定", result.stdout)
        self.assertIn("新上报中出现目标状态", result.stdout)
        self.assertEqual(result.stdout.count("该时段没有可核对的新上报"), 1)
        self.assertEqual(result.stdout.count("新上报中出现目标状态"), 1)

    def test_air_conditioning_deduplicates_cached_reads_and_respects_other_actions(self):
        note = lambda time, action: {"recordedAt": time, "action": action, "outcome": "before"}
        def climate(collected, reported, state):
            return {"collectedAt": collected, "climate": {
                "status": "success", "reportedAt": reported, "activity": state,
            }}
        result = run_report({
            "format": "norr-p4-test-log", "version": 1,
            "testerObservations": [note(1000, "climateStart"), note(1100, "unlock"), note(1800, "climateStop")],
            "readings": [climate(1700, 1400, "active"), climate(1600, 1400, "active"),
                         climate(1200, 1150, "starting"), climate(2200, 2100, "idle")],
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("新上报 2 条，末次为运行中", result.stdout)
        self.assertIn("新上报 1 条，末次为已停止", result.stdout)

    def test_preexisting_target_and_conflicting_reports_are_visible(self):
        result = run_report({
            "format": "norr-p4-test-log", "version": 1,
            "testerObservations": [{"recordedAt": 2000, "action": "unlock", "outcome": "before"}],
            "readings": [sample(1000, 900, False), sample(2100, 2050, True),
                         sample(2200, 2050, False), sample(602001, 602001, False)],
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("准备前最近上报为已解锁", result.stdout)
        self.assertIn("同一上报时间的读数冲突", result.stdout)
        self.assertNotIn("新上报中出现目标状态", result.stdout)

    def test_ios_distinguishes_manual_acceptance_and_garage_reads_from_receipts(self):
        result = run_report({
            "format": "norr-ios-session-log", "version": 1, "vehicleControlTransport": None,
            "events": [
                {"operation": "manualObservation", "action": "unlock", "vehicleRef": "PRIVATE-A",
                 "outcome": "appAccepted", "operationSource": "officialApp", "time": 1000},
                {"operation": "manualObservation", "action": "climateStart", "vehicleRef": "PRIVATE-B",
                 "outcome": "observed", "operationSource": "vehicle", "time": 2000},
                {"operation": "readGarage", "phase": "completed", "time": 3000},
            ],
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("读取车库成功 1 次", result.stdout)
        self.assertIn("车辆 1", result.stdout)
        self.assertIn("车辆 2", result.stdout)
        self.assertIn("官方 App 提示受理", result.stdout)
        self.assertIn("车控服务回执：未采集", result.stdout)
        self.assertNotIn("新上报中出现目标状态", result.stdout)
        self.assertNotIn("PRIVATE", result.stdout)

    def test_ios_correlates_only_the_selected_vehicle_and_keeps_reference_target_distinct(self):
        def note(ref, when):
            return {"operation": "manualObservation", "action": "climateStart", "vehicleRef": ref,
                    "outcome": "before", "operationSource": "vehicle", "time": when}
        def read(ref, collected, reported, activity):
            return {"operation": "readVehicle", "phase": "completed", "source": "c3", "vehicleRef": ref,
                    "sample": {"collectedAt": collected, "climate": {"status": "success", "reportedAt": reported, "activity": activity},
                               "battery": {"status": "success", "percent": 49}, "target": {"status": "success", "referencePercent": 90}}}
        result = run_report({"format": "norr-ios-session-log", "version": 1, "vehicleControlTransport": None,
                             "events": [note("PRIVATE-A", 1000), note("PRIVATE-B", 1050), read("PRIVATE-A", 2000, 1600, "active"),
                                        read("PRIVATE-B", 1900, None, "active"), read("PRIVATE-B", 2200, 2000, "idle")]})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count("新上报中出现目标状态"), 1)
        self.assertIn("当前电量 49%，充电上限（C3 参考值） 90%", result.stdout)
        self.assertIn("未见明确匹配的上报", result.stdout)
        self.assertNotIn("PRIVATE", result.stdout)

    def test_rejects_unknown_format_or_event_list(self):
        for log in [{"format": "norr-p4-test-log", "version": 2},
                    {"format": "norr-ios-session-log", "version": 1, "events": {}},
                    {"format": "norr-ios-session-log", "version": 1, "events": [], "vehicleControlTransport": "new"}]:
            result = run_report(log)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("Traceback", result.stderr)
