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

        self.client.post(
            "/api/live/start",
            json={
                "db": "somersault_security.pdx",
                "layer": "somersault_assiduous",
                "chart": "security_chart"
            })

        def send(service: str, **params: Any) -> Any:
            r = self.client.post("/api/live/send", json={"service": service, "params": params})
            self.assertEqual(r.status_code, 200)
            return r.json()

        def request_seed() -> int:
            tx = send("security_request_seed")
            self.assertEqual(tx["request"]["hex"], "2701")
            self.assertEqual(tx["response"]["coding_object"], "security_seed")
            return int(tx["response"]["params"]["seed"])

        try:
            assert self.server._live is not None
            behavior = self.server._live.behavior

            # the ODX precondition blocks the protected service while locked
            tx = send("headstand", duration="3")
            self.assertTrue(tx["blocked"])
            self.assertEqual(tx["state_after"], "locked")
            gates = self.client.get("/api/live/poll").json()["gates"]
            self.assertFalse(gates["headstand"])

            # a wrong key is refused and does not advance the chart
            seed = request_seed()
            tx = send("security_send_key", key=str(demo_security_key(seed) ^ 1))
            self.assertEqual(tx["response"]["coding_object"], "InvalidKey")
            self.assertEqual(tx["response"]["hex"], "7f2735")
            self.assertEqual(tx["state_before"], "locked")
            self.assertEqual(tx["state_after"], "locked")
            self.assertEqual(behavior.snapshot()["security"]["attempts"], 1)

            # three wrong keys lead to the lockout delay
            send("security_send_key", key=str(demo_security_key(seed) ^ 2))
            tx = send("security_send_key", key=str(demo_security_key(seed) ^ 3))
            self.assertEqual(tx["response"]["coding_object"], "ExceededNumberOfAttempts")
            self.assertGreater(behavior.snapshot()["security"]["delay_remaining"], 0)
            tx = send("security_request_seed")
            self.assertEqual(tx["response"]["coding_object"], "RequiredTimeDelayNotExpired")
            self.assertEqual(tx["response"]["hex"], "7f2737")
            tx = send("security_send_key", key=str(demo_security_key(seed)))
            self.assertEqual(tx["response"]["coding_object"], "RequiredTimeDelayNotExpired")
            self.assertEqual(tx["state_after"], "locked")

            # once the modeled delay (on the tick() clock) expired, the
            # correct key unlocks and the protected service runs
            behavior._t -= behavior.SECURITY_DELAY_S + 1
            seed = request_seed()
            self.assertNotEqual(seed, 0)
            tx = send("security_send_key", key=hex(demo_security_key(seed)))
            self.assertEqual(tx["response"]["coding_object"], "security_key_accepted")
            self.assertEqual(tx["state_before"], "locked")
            self.assertEqual(tx["state_after"], "unlocked")
            self.assertFalse(behavior.snapshot()["security"]["locked"])
            self.assertEqual(request_seed(), 0)
            tx = send("headstand", duration="3")
            self.assertFalse(tx["blocked"])
            self.assertEqual(tx["response"]["coding_object"], "headstand_done")

            # ending the session locks the ECU again
            tx = send("session_stop")
            self.assertEqual(tx["state_after"], "locked")
            self.assertTrue(behavior.snapshot()["security"]["locked"])
            self.assertTrue(send("headstand", duration="3")["blocked"])
        finally:
            assert self.server._live is not None
            self.server._live.close()
            self.server._live = None


if __name__ == "__main__":
    unittest.main()
