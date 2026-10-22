# SPDX-License-Identifier: MIT
import sys
import unittest
from typing import Any
from pathlib import Path

try:
    from fastapi.testclient import TestClient
    import isotp  # noqa: F401
    HAVE_DEPS = True
except (ImportError, RuntimeError):
    HAVE_DEPS = False

WEBDEMO = Path(__file__).resolve().parent.parent / "examples" / "webdemo"


@unittest.skipUnless(HAVE_DEPS, "webdemo dependencies are not installed")
class TestWebDemo(unittest.TestCase):
    server: Any
    client: Any

    @classmethod
    def setUpClass(cls) -> None:
        sys.path.insert(0, str(WEBDEMO))
        import server
        cls.server = server
        cls.client = TestClient(server.app)

    def test_summary_and_encode(self) -> None:
        summary = self.client.get("/api/db/somersault.pdx").json()
        self.assertEqual([layer["name"] for layer in summary["layers"]], [
            "somersault_protocol", "somersault_base_variant", "somersault_lazy",
            "somersault_assiduous"
        ])
        r = self.client.post(
            "/api/db/somersault.pdx/encode",
            json={
                "layer": "somersault_lazy",
                "service": "do_forward_flips",
                "params": {
                    "forward_soberness_check": "0x12",
                    "num_flips": "5"
                }
            }).json()
        self.assertEqual(r["hex"], "ba1205")
        self.assertEqual([s["param"] for s in r["spans"]],
                         ["sid", "forward_soberness_check", "num_flips"])

    def test_decode_response(self) -> None:
        r = self.client.post(
            "/api/db/somersault.pdx/decode",
            json={
                "layer": "somersault_assiduous",
                "hex": "7f ba 01 03",
                "request_hex": "ba1205"
            }).json()
        self.assertEqual(r[0]["coding_object"], "flips_not_done")
        self.assertEqual(r[0]["params"]["reason"], 1)

    def test_compare(self) -> None:
        r = self.client.get("/api/compare?old=somersault.pdx&new=somersault_modified.pdx").json()
        self.assertEqual(r["summary"]["new_layers"], 1)

    def test_live_network(self) -> None:
        self.client.post(
            "/api/live/start",
            json={
                "db": "somersault.pdx",
                "layer": "somersault_lazy",
                "chart": "angry_chart"
            })
        try:
            # without a bribe, the angry ECU's state chart forbids session_start
            tx = self.client.post(
                "/api/live/send", json={
                    "service": "session_start",
                    "params": {}
                }).json()
            self.assertTrue(tx["blocked"])

            tx = self.client.post(
                "/api/live/send", json={
                    "service": "session_start",
                    "params": {
                        "bribe": "1"
                    }
                }).json()
            self.assertFalse(tx["blocked"])
            self.assertEqual(tx["response"]["kind"], "positive")
            self.assertEqual(tx["state_after"], "on_street")

            tx = self.client.post(
                "/api/live/send",
                json={
                    "service": "do_forward_flips",
                    "params": {
                        "forward_soberness_check": "0x12",
                        "num_flips": "3"
                    }
                }).json()
            self.assertEqual(tx["response"]["coding_object"], "grudging_forward")
            self.assertEqual(tx["response"]["params"]["num_flips_done"], 3)

            # a 20 byte telegram requires ISO-TP segmentation
            tx = self.client.post("/api/live/send", json={"raw": "ba1203" + "00" * 17}).json()
            self.assertGreater(tx["frames"], 3)

            # a scripted run keeps flipping until the modeled ECU refuses
            for _ in range(6):
                tx = self.client.post(
                    "/api/live/send",
                    json={
                        "service": "do_forward_flips",
                        "params": {
                            "forward_soberness_check": "0x12",
                            "num_flips": "5"
                        }
                    })
                self.assertEqual(tx.status_code, 200)
            # the overheated acrobat answers with a GLOBAL-NEG-RESPONSE
            self.assertEqual(tx.json()["response"]["coding_object"], "too_hot")

            # raw telegrams which encode an ODX service run through the state chart
            tx = self.client.post("/api/live/send", json={"raw": "1001"}).json()
            self.assertEqual(tx["service"], "session_stop")
            self.assertEqual(tx["state_after"], "in_bed")

            # a session_start refused by the ECU must not advance the state chart
            assert self.server._live is not None
            self.server._live.behavior.temperature = 99.0
            tx = self.client.post(
                "/api/live/send", json={
                    "service": "session_start",
                    "params": {
                        "bribe": "1"
                    }
                }).json()
            self.assertEqual(tx["response"]["coding_object"], "too_hot")
            self.assertEqual(tx["state_after"], "in_bed")

            tx = self.client.post("/api/live/send", json={"raw": "3101ff00"}).json()
            self.assertEqual(tx["response"]["hex"], "7f3111")

            poll = self.client.get("/api/live/poll?after=0").json()
            kinds = {f["isotp"] for f in poll["frames"]}
            self.assertTrue({"SF", "FF", "FC", "CF"} <= kinds)
        finally:
            assert self.server._live is not None
            self.server._live.close()
            self.server._live = None

    def test_raw_requests_use_state_chart(self) -> None:
        self.client.post(
            "/api/live/start",
            json={
                "db": "somersault.pdx",
                "layer": "somersault_lazy",
                "chart": "angry_chart"
            })
        try:
            tx = self.client.post("/api/live/send", json={"raw": "31 01 ff 00"}).json()
            self.assertEqual(tx["response"]["hex"], "7f3111")
            self.assertNotEqual(tx["response"]["kind"], "global_negative")
            # raw session_start (bribe=1) with a trailing byte
            tx = self.client.post("/api/live/send", json={"raw": "10 00 01 00"}).json()
            self.assertEqual(tx["service"], "session_start")
            self.assertEqual(tx["state_after"], "on_street")
            tx = self.client.post("/api/live/send", json={"raw": "10 01"}).json()
            self.assertEqual(tx["service"], "session_stop")
            self.assertEqual(tx["state_after"], "in_bed")
            # without a bribe the chart blocks the raw telegram, too
            tx = self.client.post("/api/live/send", json={"raw": "10 00 00 00"}).json()
            self.assertTrue(tx["blocked"])
        finally:
            assert self.server._live is not None
            self.server._live.close()
            self.server._live = None

    def test_security_access(self) -> None:
        from virtual_ecu import demo_security_key

        self.assertIn("somersault_security.pdx",
                      [d["name"] for d in self.client.get("/api/databases").json()])
        st = self.client.post(
            "/api/live/start",
            json={
                "db": "somersault_security.pdx",
                "layer": "somersault_assiduous",
                "chart": "security_chart"
            }).json()
        self.assertEqual(st["charts"]["security_chart"], "locked")
        self.assertEqual(st["preconditions"]["headstand"], [{
            "chart": "security_chart",
            "state": "unlocked"
        }])

        def send(service: str, **params: str) -> dict[str, Any]:
            r = self.client.post("/api/live/send", json={"service": service, "params": params})
            self.assertEqual(r.status_code, 200, r.text)
            result: dict[str, Any] = r.json()
            return result

        def seed() -> int:
            tx = send("security_request_seed")
            self.assertEqual(tx["request"]["hex"], "2701")
            self.assertEqual(tx["response"]["coding_object"], "security_seed")
            self.assertEqual(len(tx["response"]["hex"]), 12)
            return int(tx["response"]["params"]["security_seed"])

        try:
            # the ODX pre-condition blocks headstand while security_chart is locked
            tx = send("headstand", duration="3")
            self.assertTrue(tx["blocked"])
            self.assertEqual(tx["state_before"], "locked")

            # a wrong key is answered with invalidKey; the negative response
            # must not advance the chart
            for attempt in range(2):
                s = seed()
                tx = send("security_send_key", security_key=hex(demo_security_key(s) ^ 1))
                self.assertEqual(tx["response"]["hex"], "7f2735")
                self.assertEqual(tx["response"]["nrc"]["name"], "InvalidKey")
                self.assertEqual(tx["state_before"], "locked")
                self.assertEqual(tx["state_after"], "locked")
                ecu = self.client.get("/api/live/poll").json()["ecu"]["security"]
                self.assertEqual(ecu["attempts"], attempt + 1)
                self.assertTrue(ecu["locked"])

            # the third wrong key starts the modeled delay
            s = seed()
            tx = send("security_send_key", security_key=hex(demo_security_key(s) ^ 1))
            self.assertEqual(tx["response"]["nrc"]["name"], "ExceededNumberOfAttempts")
            self.assertEqual(tx["state_after"], "locked")
            ecu = self.client.get("/api/live/poll").json()["ecu"]["security"]
            self.assertGreater(ecu["delay_remaining"], 0)
            for svc, params in (("security_request_seed", {}), ("security_send_key", {
                    "security_key": "0x0"
            })):
                tx = send(svc, **params)
                self.assertEqual(tx["response"]["hex"], "7f2737")
                self.assertEqual(tx["response"]["nrc"]["name"], "RequiredTimeDelayNotExpired")
                self.assertEqual(tx["state_after"], "locked")

            # let the modeled delay expire (same clock as tick())
            assert self.server._live is not None
            self.server._live.behavior._t -= 11
            s = seed()
            tx = send("security_send_key", security_key=hex(demo_security_key(s)))
            self.assertEqual(tx["response"]["hex"], "6702")
            self.assertEqual(tx["state_before"], "locked")
            self.assertEqual(tx["state_after"], "unlocked")
            ecu = self.client.get("/api/live/poll").json()["ecu"]["security"]
            self.assertFalse(ecu["locked"])
            self.assertEqual(ecu["attempts"], 0)

            # unlocked: the protected service passes the chart and the ECU answers
            tx = send("headstand", duration="3")
            self.assertFalse(tx["blocked"])
            self.assertEqual(tx["response"]["kind"], "positive")
            # an unlocked ECU answers a seed request with an all-zero seed
            self.assertEqual(seed(), 0)

            # session_stop re-locks
            tx = send("session_stop")
            self.assertEqual(tx["state_after"], "locked")
            self.assertTrue(self.client.get("/api/live/poll").json()["ecu"]["security"]["locked"])
            self.assertTrue(send("headstand", duration="3")["blocked"])

            # raw telegrams are identified as the 0x27 sub-function services
            tx = self.client.post("/api/live/send", json={"raw": "27 02 00 00 00 00"}).json()
            self.assertEqual(tx["service"], "security_send_key")
            self.assertEqual(tx["response"]["nrc"]["name"], "RequestSequenceError")
        finally:
            assert self.server._live is not None
            self.server._live.close()
            self.server._live = None


if __name__ == "__main__":
    unittest.main()
