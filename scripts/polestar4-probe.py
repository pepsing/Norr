#!/usr/bin/env python3
"""Read-only P4 API probe using the isolated Norr P4 Keychain session."""

import argparse
import base64
import fcntl
import hashlib
import hmac
import http.client
import json
import math
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


SERVICE = "app.norr.mac.polestar4"
SUPPORT = Path.home() / "Library/Application Support" / SERVICE
READS = {
    "vehicle_status_cached": ("device-api", "/remote-control/vehicle/status/{vin}"),
    "vehicle_status": ("device-api", "/remote-control/vehicle/status/{vin}"),
    "vehicle_state": ("device-api", "/remote-control/vehicle/status/state/{vin}"),
    "capabilities": ("api", "/geelyTCAccess/tcservices/capability/{vin}"),
    "charge_settings": ("api", "/charge-server/ecarx_charge_set/{vin}"),
    "charge_status": ("api", "/charge-server/charge_status/{vin}"),
}
DEFAULT_READS = set(READS) - {"vehicle_status_cached"}
VIN_PATTERN = r"[A-HJ-NPR-Z0-9]{17}"


def allowed_request(host, path, method):
    if (host, path, method) in {
        ("user-api", "/auth-center/account/session", "POST"),
        ("user-api", "/auth/account/session/secure", "PUT"),
        ("device-api", "/device-platform/user/vehicle/secure", "GET"),
    }:
        return True
    return method == "GET" and any(
        host == expected_host and re.fullmatch(re.escape(template).replace(r"\{vin\}", VIN_PATTERN), path)
        for expected_host, template in READS.values()
    )


def normalize_response(status, payload):
    if status != 200 or not isinstance(payload, dict) or not payload:
        return {"code": None, "data": None}
    data = payload.get("data") if "code" in payload else payload
    ok = "code" not in payload or str(payload["code"]) == "1000"
    pending = False
    for value in (payload, data):
        if not isinstance(value, dict):
            continue
        nested = value.get("result") or {}
        service = value.get("serviceResult") or nested.get("serviceResult") or {}
        ok &= not value.get("error") and not service.get("error")
        operation = str(service.get("operationResult", 0))
        if operation == "1" and value.get("vehicleStatus"):
            pending = True
        else:
            ok &= operation == "0"
        ok &= str(value.get("resultCode", 0)) == "0"
        ok &= value.get("success") is not False and value.get("isSuccess") is not False
    return {"code": 1000 if ok else None, "data": data if ok else None, "pending": pending}


def valid_grant(grant):
    if not isinstance(grant, dict):
        return False
    try:
        expires_in = int(grant.get("expiresIn", 0))
    except (ValueError, TypeError):
        return False
    return all(
        isinstance(grant.get(key), str) and grant[key]
        for key in ("accessToken", "refreshToken", "userId", "clientId")
    ) and 0 < expires_in <= 31_536_000


def telemetry_summary(status):
    sections = status.get("additionalVehicleStatus", {})
    electric = sections.get("electricVehicleStatus", {})
    maintenance = sections.get("maintenanceStatus", {})

    def numeric(value, maximum):
        try:
            number = float(value)
            return math.isfinite(number) and 0 <= number <= maximum
        except (ValueError, TypeError):
            return False

    summary = {
        "statusSections": sorted(sections),
        "updateTimePresent": bool(status.get("updateTime")),
        "chargeLevelNumeric": numeric(electric.get("chargeLevel"), 100),
        "rangeNumeric": numeric(electric.get("distanceToEmptyOnBatteryOnly"), 10_000),
        "odometerNumeric": numeric(maintenance.get("odometer"), 10_000_000),
    }
    try:
        observed = float(status.get("updateTime"))
        if observed > 1e12:
            observed /= 1000
        if 1e9 < observed <= time.time() + 60:
            summary["observationAgeHours"] = round((time.time() - observed) / 3600, 1)
    except (ValueError, TypeError):
        pass
    return summary


def keychain(helper, action, account, value=None):
    result = subprocess.run(
        [str(helper), action, account],
        input=json.dumps(value, separators=(",", ":")).encode() if value is not None else None,
        capture_output=True,
    )
    if action == "read" and result.returncode == 44:
        return None
    if result.returncode:
        raise RuntimeError("Keychain operation failed; session was not changed")
    if action == "read":
        return result.stdout.decode()


def signature(secret, headers, query, body, timestamp, method, path):
    signed_headers = headers["Accept"].strip() + "\n"
    signed_headers += "".join(
        f"{key.lower()}:{headers[key].strip()}\n"
        for key in sorted(headers) if key.startswith("X-api")
    )
    parameters = urllib.parse.urlencode(sorted(query.items()), quote_via=urllib.parse.quote)
    # Android Base64.DEFAULT appends a newline even for the 16-byte MD5 digest.
    digest = base64.b64encode(hashlib.md5(body).digest()).decode() + "\n"
    source = f"{signed_headers}\n{parameters}\n{digest}{timestamp}\n{method}\n{path}"
    return base64.b64encode(hmac.new(secret.encode(), source.encode(), hashlib.sha1).digest()).decode()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Probe:
    def __init__(self, helper, apk, show_schema=False):
        self.helper = helper
        source = (apk / "jadx/sources/com/polestar/explore/core/carcontrol/RCSClient.java").read_text()
        match = re.search(r'"(polestar-app)", "([^"]+)"', source)
        if not match or match[1] != "polestar-app":
            raise RuntimeError("Unsupported APK configuration")
        self.app_id, self.secret = match.groups()
        device = keychain(helper, "read", "device-id")
        if not device:
            raise RuntimeError("Norr P4 has no saved device identifier")
        self.device = device.encode().hex()
        self.http = urllib.request.build_opener(NoRedirect())
        self.grant = None
        self.show_schema = show_schema

    def request(self, name, host, path, query=None, body=None, method="GET"):
        if not allowed_request(host, path, method) or (method == "GET" and body is not None):
            raise ValueError("Request is outside this probe's read-only API list")
        query = query or {}
        payload = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode() if body is not None else b""
        timestamp = str(int(time.time() * 1000))
        nonce = (str(uuid.uuid4()) + "".join(secrets.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") for _ in range(7)) + timestamp)[-36:]
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json; charset=utf-8",
            "X-APP-ID": self.app_id,
            "X-AGENT-TYPE": "android",
            "X-DEVICE-TYPE": "mobile",
            "X-OPERATOR-CODE": "POLESTAR",
            "X-DEVICE-IDENTIFIER": self.device,
            "X-ENV-TYPE": "production",
            "X-VERSION": "polestarNew",
            "Accept-Language": "zh-CN",
            "Accept-Encoding": "identity",
            "Connection": "close",
            "X-api-signature-version": "1.0",
            "X-api-signature-nonce": nonce,
        }
        if self.grant:
            headers["Authorization"] = self.grant["accessToken"]
            headers["X-CLIENT-ID"] = self.grant["clientId"]
        else:
            headers.update({"X-DEVICE-MANUFACTURE": "Apple", "X-DEVICE-BRAND": "Norr", "X-DEVICE-MODEL": "Norr P4 API probe", "X-DEVICE-RELEASE-DATE": "", "X-AGENT-VERSION": "macOS"})
        headers["X-SIGNATURE"] = signature(self.secret, headers, query, payload, timestamp, method, path)
        headers["X-TIMESTAMP"] = timestamp
        encoded = urllib.parse.urlencode(sorted(query.items()), quote_via=urllib.parse.quote)
        url = f"https://{host}.xchanger.cn{path}" + ("?" + encoded if encoded else "")
        request = urllib.request.Request(url, data=payload if body is not None else None, headers=headers, method=method)
        try:
            response = self.http.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, TimeoutError):
            raise RuntimeError(f"{name}: transport failure") from None
        with response:
            status = response.code
            content_type = response.headers.get("Content-Type")
            try:
                raw = response.read()
            except (TimeoutError, http.client.HTTPException):
                raise RuntimeError(f"{name}: response body incomplete (HTTP {status})") from None
            try:
                result = json.loads(raw)
            except (ValueError, UnicodeError):
                result = {}
        if not isinstance(result, dict):
            result = {}
        service_result = result.get("serviceResult") or (result.get("result") or {}).get("serviceResult") or {}
        normalized = normalize_response(status, result)
        record = {"name": name, "http": status, "contentType": content_type, "bytes": len(raw), "code": result.get("code"), "operationResult": service_result.get("operationResult"), "accepted": normalized["code"] == 1000}
        if self.show_schema:
            record["keys"] = sorted(result)
        if isinstance(result.get("error"), dict):
            record["errorCode"] = result["error"].get("code")
        error_message = result.get("message")
        if not error_message and isinstance(result.get("error"), dict):
            error_message = result["error"].get("message")
        if isinstance(error_message, str):
            message = re.sub(r"[A-Za-z0-9_./+=-]{24,}|[A-HJ-NPR-Z0-9]{17}|\d{6,}", "[redacted]", error_message)
            record["message"] = message[:200]
        for key in ("errorCode", "resultCode", "status", "success", "error"):
            if key in result:
                record[key] = result[key] if isinstance(result[key], (int, bool)) else type(result[key]).__name__
        print(json.dumps(record, ensure_ascii=False), flush=True)
        return normalized

    def save(self, grant, account_hash):
        if not valid_grant(grant):
            raise RuntimeError("Incomplete Geely grant; previous session retained")
        stored = {"grant": grant, "savedAt": time.time(), "accountHash": account_hash}
        keychain(self.helper, "write", "polestar-geely-session", stored)
        self.grant = grant

    def authorize(self, refresh=False, exchange=False):
        raw = keychain(self.helper, "read", "polestar-china-session")
        if not raw:
            raise RuntimeError("Log in to Norr P4 first")
        china = json.loads(raw)
        account_hash = hashlib.sha256(china["login"]["userUid"].encode()).hexdigest()
        raw_saved = keychain(self.helper, "read", "polestar-geely-session")
        saved = json.loads(raw_saved) if raw_saved else None
        if saved and saved.get("accountHash") == account_hash and not exchange:
            self.grant = saved["grant"]
            if not valid_grant(self.grant):
                raise RuntimeError("Saved Geely session is incomplete")
            expired = saved["savedAt"] + int(self.grant.get("expiresIn", 0)) <= time.time() + 60
            if refresh or expired:
                response = self.request("session_refresh", "user-api", "/auth/account/session/secure", body={"refreshToken": self.grant["refreshToken"]}, method="PUT")
                grant = response.get("data")
                if response.get("code") != 1000 or not isinstance(grant, dict) or not grant.get("accessToken"):
                    raise RuntimeError("Geely refresh failed; saved session retained")
                # This endpoint may rotate only accessToken; retain the existing refreshToken.
                self.save({**self.grant, **grant}, account_hash)
            print(json.dumps({"sessionRestored": True, "refreshed": refresh or expired}), flush=True)
            return
        response = self.request("session_exchange", "user-api", "/auth-center/account/session", body={"identityType": "polestar", "accessToken": china["login"]["accessToken"]}, method="POST")
        if response.get("code") != 1000:
            raise RuntimeError("Geely session exchange failed")
        grant = response.get("data", {})
        if str(grant.get("resultCode", "0")) != "0":
            raise RuntimeError("Geely login was not accepted")
        self.save(grant, account_hash)
        print(json.dumps({"sessionSaved": True, "expiresIn": grant.get("expiresIn")}), flush=True)

    def run(self, only=None):
        only = set(only) if only else DEFAULT_READS
        failures = 0
        found = 0
        response = self.request("vehicle_list", "device-api", "/device-platform/user/vehicle/secure", {"userId": self.grant["userId"], "needSharedCar": "1"})
        if response.get("code") != 1000:
            raise RuntimeError("Geely vehicle list failed")
        vehicles = response.get("data", {}).get("list")
        if not isinstance(vehicles, list):
            raise RuntimeError("Vehicle list response has no list")
        print(json.dumps({"vehicleCount": len(vehicles)}), flush=True)
        for vehicle in vehicles:
            profile = {key: vehicle.get(key) for key in ("modelName", "seriesName", "vehicleType", "tboxPlatform", "ihuPlatform")}
            print(json.dumps({"vehicleProfile": profile}, ensure_ascii=False), flush=True)
            name = str(profile.get("modelName")) + " " + str(profile.get("seriesName"))
            if not re.search(r"polestar\s*4|极星\s*4|\bP4\b", name, re.IGNORECASE):
                continue
            found += 1
            vin = vehicle.get("vin", "")
            if not re.fullmatch(VIN_PATTERN, vin):
                raise RuntimeError("Invalid vehicle identifier")
            uid = self.grant["userId"]
            endpoints = [
                ("vehicle_status_cached", "device-api", f"/remote-control/vehicle/status/{vin}", {"userId": uid, "latest": "false", "target": ""}),
                ("vehicle_status", "device-api", f"/remote-control/vehicle/status/{vin}", {"userId": uid, "latest": "true", "target": ""}),
                ("vehicle_state", "device-api", f"/remote-control/vehicle/status/state/{vin}", {"userId": uid}),
                ("capabilities", "api", f"/geelyTCAccess/tcservices/capability/{vin}", {"pageSize": 2000, "pageIndex": 1, "vehicleType": vehicle["vehicleType"], "sortField": "", "direction": ""}),
                ("charge_settings", "api", f"/charge-server/ecarx_charge_set/{vin}", {}),
                ("charge_status", "api", f"/charge-server/charge_status/{vin}", {}),
            ]
            for label, host, path, query in endpoints:
                if label not in only:
                    continue
                try:
                    result = self.request(label, host, path, query)
                    data = result.get("data", {})
                    if result.get("code") != 1000 or not isinstance(data, dict) or not data:
                        raise RuntimeError(f"{label}: API rejected the request or returned no data")
                except RuntimeError as error:
                    print(json.dumps({"name": label, "error": str(error)}), flush=True)
                    failures += 1
                    continue
                if self.show_schema:
                    print(json.dumps({"name": label, "schema": schema(data)}, ensure_ascii=False), flush=True)
                if label == "capabilities" and isinstance(data, dict):
                    items = data.get("list", [])
                    print(json.dumps({"capabilityCount": len(items), "enabledCount": sum(item.get("valueEnable") is True for item in items)}), flush=True)
                if label.startswith("vehicle_status"):
                    status = data.get("vehicleStatus", {})
                    print(json.dumps({**telemetry_summary(status), "freshnessPending": result.get("pending", False)}), flush=True)
        if not found:
            raise RuntimeError("No Polestar 4 was returned for this account")
        if failures:
            raise RuntimeError(f"{failures} read(s) did not complete successfully")


def schema(value, depth=0):
    if depth > 7:
        return type(value).__name__
    if isinstance(value, dict):
        return {key: schema(item, depth + 1) for key, item in value.items()}
    if isinstance(value, list):
        return {"count": len(value), "item": schema(value[0], depth + 1) if value else None}
    return type(value).__name__


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk-dir", type=Path, required=True)
    parser.add_argument("--keychain-helper", type=Path, required=True)
    auth = parser.add_mutually_exclusive_group()
    auth.add_argument("--refresh", action="store_true", help="Verify renewal of the saved Geely grant")
    auth.add_argument("--exchange", action="store_true", help="Exchange the saved China grant for a new Geely session")
    parser.add_argument("--only", action="append", choices=sorted(READS), help="Limit reads after vehicle discovery; may be repeated")
    parser.add_argument("--schema", action="store_true", help="Include field names and types, never raw vehicle values")
    args = parser.parse_args()
    SUPPORT.mkdir(parents=True, exist_ok=True)
    with (SUPPORT / "geely-probe.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        probe = Probe(args.keychain_helper, args.apk_dir, args.schema)
        probe.authorize(args.refresh, args.exchange)
        probe.run(args.only)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError, ValueError, OSError) as error:
        print(f"Probe stopped: {type(error).__name__}" + (f": {error}" if isinstance(error, RuntimeError) else ""), file=sys.stderr)
        sys.exit(1)
