import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("polestar4_probe", Path(__file__).parents[1] / "polestar4-probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def grant():
    return {"accessToken": "fixture-access", "refreshToken": "fixture-refresh", "userId": "fixture-user", "clientId": "fixture-client", "expiresIn": 7200}


def client():
    value = probe.Probe.__new__(probe.Probe)
    value.helper = Path("unused-test-helper")
    value.grant = grant()
    value.show_schema = False
    return value


class Polestar4ProbeTests(unittest.TestCase):
    def test_signature_matches_independent_node_crypto_fixture(self):
        headers = {"Accept": "application/json", "X-api-signature-version": "1.0", "X-api-signature-nonce": "fixture-nonce"}
        query = {"userId": "test user", "target": "", "latest": "true"}
        actual = probe.signature("fixture-secret", headers, query, b"", "1700000000000", "GET", "/remote-control/vehicle/status/TEST1234567890123")
        self.assertEqual(actual, "aV+SgF7vyIjxgsMRBpWqh8OvvWI=")

    def test_only_authentication_and_specific_reads_are_allowed(self):
        vin = "TEST1234567890123"
        self.assertTrue(probe.allowed_request("device-api", f"/remote-control/vehicle/status/{vin}", "GET"))
        self.assertTrue(probe.allowed_request("user-api", "/auth/account/session/secure", "PUT"))
        for host, path, method in [
            ("device-api", f"/remote-control/vehicle/telematics/{vin}", "PUT"),
            ("api", f"/charge-server/ecarx_charge_set/{vin}", "POST"),
            ("user-api", "/auth/account/session/secure", "DELETE"),
            ("api", "/unknown", "GET"),
            ("attacker.example", "/device-platform/user/vehicle/secure", "GET"),
            ("device-api", "/remote-control/vehicle/status/../../admin", "GET"),
        ]:
            with self.subTest(path=path):
                self.assertFalse(probe.allowed_request(host, path, method))

    def test_http_200_does_not_hide_api_failure(self):
        cases = [
            (200, {"accessToken": "fixture"}, True),
            (200, {"code": "1000", "data": {"list": []}}, True),
            (200, {"code": "1400", "data": None, "success": False}, False),
            (401, {"error": {"code": 1404}}, False),
            (200, {"error": {"code": 1404}}, False),
            (200, {"result": {"serviceResult": {"operationResult": 2}}, "vehicleStatus": {}}, False),
            (200, {"code": 1000, "data": {"resultCode": 2}}, False),
            (200, {}, False),
        ]
        for status, payload, expected in cases:
            with self.subTest(payload=payload):
                self.assertEqual(probe.normalize_response(status, payload)["code"] == 1000, expected)

    def authorize_with(self, response, *, account_matches=True):
        value = client()
        china = {"login": {"userUid": "fixture-account", "accessToken": "fixture-outer-token", "globleToken": {"accessToken": "fixture-global-token"}}}
        scope = hashlib.sha256(b"fixture-account").hexdigest()
        saved = {"grant": grant(), "savedAt": time.time(), "accountHash": scope if account_matches else "different-account"}
        writes, requests = [], []

        def storage(helper, action, account, data=None):
            if action == "write":
                writes.append((account, data))
            else:
                return json.dumps(china if account == "polestar-china-session" else saved)

        def request(*args, **kwargs):
            requests.append((args, kwargs))
            return response

        value.request = request
        with patch.object(probe, "keychain", side_effect=storage), contextlib.redirect_stdout(io.StringIO()):
            try:
                value.authorize(refresh=True)
            except RuntimeError as error:
                return value, writes, requests, error
        return value, writes, requests, None

    def test_refresh_persists_access_token_and_preserves_omitted_fields(self):
        value, writes, _, error = self.authorize_with({"code": 1000, "data": {"accessToken": "fixture-renewed", "expiresIn": 7200}})
        self.assertIsNone(error)
        self.assertEqual(value.grant["accessToken"], "fixture-renewed")
        self.assertEqual(value.grant["refreshToken"], "fixture-refresh")
        self.assertEqual(value.grant["clientId"], "fixture-client")
        self.assertEqual(writes[0][0], "polestar-geely-session")
        self.assertEqual(writes[0][1]["grant"], value.grant)

    def test_submitted_status_read_keeps_cached_data_and_pending_marker(self):
        status = {"updateTime": "fixture-time"}
        payload = {"result": {"serviceResult": {"operationResult": 1}}, "vehicleStatus": status}
        result = probe.normalize_response(200, payload)
        self.assertEqual(result["code"], 1000)
        self.assertTrue(result["pending"])
        self.assertEqual(result["data"]["vehicleStatus"], status)

    def test_rejected_refresh_does_not_overwrite_saved_session(self):
        value, writes, _, error = self.authorize_with({"code": None, "data": None})
        self.assertIsNotNone(error)
        self.assertEqual(writes, [])
        self.assertEqual(value.grant, grant())

    def test_changed_account_exchanges_outer_token_without_reusing_geely_grant(self):
        _, writes, requests, error = self.authorize_with({"code": 1000, "data": grant()}, account_matches=False)
        self.assertIsNone(error)
        self.assertEqual(requests[0][0][0], "session_exchange")
        self.assertEqual(requests[0][1]["body"], {"identityType": "polestar", "accessToken": "fixture-outer-token"})
        self.assertEqual(len(writes), 1)

    def test_vehicle_queries_use_user_id_and_do_not_log_values(self):
        value = client()
        vin = "TEST1234567890123"
        calls = []

        def request(name, host, path, query):
            calls.append((name, path, query))
            if name == "vehicle_list":
                data = {"list": [{"modelName": "Polestar 4", "vin": vin, "vehicleType": 0}]}
            else:
                data = {"vehicleStatus": {"additionalVehicleStatus": {}, "updateTime": "fixture-time"}}
            return {"code": 1000, "data": data}

        value.request = request
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            value.run(["vehicle_status"])
        for _, _, query in calls:
            self.assertEqual(query["userId"], "fixture-user")
            self.assertNotIn("uid", query)
        self.assertEqual(calls[1][2]["latest"], "true")
        for private in (vin, "fixture-user", "fixture-time", "fixture-access"):
            self.assertNotIn(private, output.getvalue())

    def test_partial_failure_exits_unsuccessfully(self):
        value = client()

        def request(name, *args):
            if name == "vehicle_list":
                return {"code": 1000, "data": {"list": [{"modelName": "Polestar 4", "vin": "TEST1234567890123", "vehicleType": 0}]}}
            return {"code": None, "data": None}

        value.request = request
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
            value.run(["vehicle_status"])


if __name__ == "__main__":
    unittest.main()
