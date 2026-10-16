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

    def _start_security(self) -> None:
        st = self.client.post(
            "/api/live/start",
            json={
                "db": "somersault_security.pdx",
                "layer": "somersault_assiduous",
                "chart": "security_chart"
            }).json()
        self.assertEqual(st["chart"], "security_chart")
        self.assertEqual(st["charts"]["security_chart"], "locked")
        self.assertTrue(st["ecu"]["security"]["locked"])

    def _stop_live(self) -> None:
        assert self.server._live is not None
        self.server._live.close()
        self.server._live = None

    def _send(self, service: str, **params: Any) -> Any:
        r = self.client.post("/api/live/send", json={"service": service, "params": params})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _request_seed(self) -> bytes:
        tx = self._send("security_request_seed")
        self.assertEqual(tx["response"]["kind"], "positive")
        self.assertEqual(tx["response"]["hex"][:4], "6701")
        return bytes.fromhex(tx["response"]["params"]["security_seed"].removeprefix("0x"))

    def _key(self, seed: bytes) -> str:
        import virtual_ecu
        return virtual_ecu.demo_security_key(seed).hex()

    def test_security_access_blocks_protected_service(self) -> None:
        self._start_security()
        try:
            tx = self._send("headstand", duration="3")
            self.assertTrue(tx["blocked"])
            self.assertIsNone(tx["response"])
            self.assertEqual(tx["state_after"], "locked")
            # raw telegrams are gated by the chart as well
            tx = self.client.post("/api/live/send", json={"raw": "03 03"}).json()
            self.assertEqual(tx["service"], "headstand")
            self.assertTrue(tx["blocked"])
        finally:
            self._stop_live()

    def test_security_access_wrong_key(self) -> None:
        self._start_security()
        try:
            seed = self._request_seed()
            wrong = bytes(b ^ 0xFF for b in bytes.fromhex(self._key(seed))).hex()
            tx = self._send("security_send_key", security_key=wrong)
            self.assertEqual(tx["response"]["hex"], "7f2735")
            self.assertEqual(tx["response"]["kind"], "negative")
            self.assertEqual(tx["response"]["coding_object"], "InvalidKey")
            # the negative response did not advance the state chart
            self.assertEqual(tx["state_before"], "locked")
            self.assertEqual(tx["state_after"], "locked")
            st = self.client.get("/api/live/poll").json()
            self.assertEqual(st["charts"]["security_chart"], "locked")
            self.assertEqual(st["ecu"]["security"]["attempts"], 1)
            self.assertTrue(self._send("headstand", duration="3")["blocked"])
            # a key without a preceding seed is a sequence error
            tx = self._send("security_send_key", security_key=self._key(seed))
            self.assertEqual(tx["response"]["coding_object"], "RequestSequenceError")
            self.assertEqual(tx["state_after"], "locked")
        finally:
            self._stop_live()

    def test_security_access_lockout(self) -> None:
        self._start_security()
        try:
            codes = []
            for _ in range(3):
                self._request_seed()
                tx = self._send("security_send_key", security_key="00000000")
                codes.append(tx["response"]["hex"])
                self.assertEqual(tx["state_after"], "locked")
            self.assertEqual(codes, ["7f2735", "7f2735", "7f2736"])
            sec = self.client.get("/api/live/poll").json()["ecu"]["security"]
            self.assertEqual(sec["attempts"], 3)
            self.assertGreater(sec["delay_remaining"], 9)
            # while the modeled delay runs, all requests get NRC 0x37
            tx = self._send("security_request_seed")
            self.assertEqual(tx["response"]["hex"], "7f2737")
            self.assertEqual(tx["response"]["coding_object"], "RequiredTimeDelayNotExpired")
            tx = self._send("security_send_key", security_key="00000000")
            self.assertEqual(tx["response"]["hex"], "7f2737")
            self.assertEqual(tx["state_after"], "locked")
            # let the modeled delay expire
            assert self.server._live is not None
            behavior = self.server._live.behavior
            behavior._security_delay_until = behavior._t
            seed = self._request_seed()
            tx = self._send("security_send_key", security_key=self._key(seed))
            self.assertEqual(tx["response"]["hex"], "6702")
            self.assertEqual(tx["state_after"], "unlocked")
        finally:
            self._stop_live()

    def test_security_access_unlock_and_relock(self) -> None:
        self._start_security()
        try:
            seed = self._request_seed()
            self.assertEqual(len(seed), 4)
            tx = self._send("security_send_key", security_key=self._key(seed))
            self.assertEqual(tx["response"]["kind"], "positive")
            self.assertEqual(tx["response"]["hex"], "6702")
            self.assertEqual(tx["state_before"], "locked")
            self.assertEqual(tx["state_after"], "unlocked")
            st = self.client.get("/api/live/poll").json()
            self.assertFalse(st["ecu"]["security"]["locked"])
            # an unlocked ECU answers with an all-zero seed
            self.assertEqual(self._request_seed(), bytes(4))
            tx = self._send("headstand", duration="3")
            self.assertFalse(tx["blocked"])
            self.assertEqual(tx["response"]["kind"], "positive")
            self.assertEqual(tx["state_after"], "unlocked")
            # stopping the session re-locks the ECU
            tx = self._send("session_stop")
            self.assertEqual(tx["state_after"], "locked")
            st = self.client.get("/api/live/poll").json()
            self.assertTrue(st["ecu"]["security"]["locked"])
            self.assertTrue(self._send("headstand", duration="3")["blocked"])
            # reset restores the locked start state and clears the ECU
            self.client.post("/api/live/reset")
            st = self.client.get("/api/live/poll").json()
            self.assertEqual(st["charts"]["security_chart"], "locked")
            self.assertEqual(st["ecu"]["security"]["attempts"], 0)
            self.assertEqual(st["ecu"]["security"]["delay_remaining"], 0)
        finally:
            self._stop_live()

    def test_security_pdx_statemachine(self) -> None:
        import odxtools
        from odxtools.statemachine import StateMachine
        db = odxtools.load_pdx_file(WEBDEMO.parent / "somersault_security.pdx")
        dl = db.ecu_variants.somersault_assiduous
        fsm = StateMachine(dl, dl.state_charts.security_chart)
        self.assertIsNone(next(fsm.execute(dl.services.headstand, duration=3), None))
        key_svc = dl.services.security_send_key
        ex = fsm.execute(key_svc, security_key=bytes(4))
        raw_req = next(ex)
        self.assertEqual(bytes(raw_req), bytes.fromhex("270200000000"))
        resp = key_svc.encode_positive_response(raw_req)
        self.assertEqual(
            dl.decode_response(resp, raw_req)[0].coding_object.short_name,
            "PR_security_key_accepted")
        self.assertEqual(ex.send(resp), b"")
        self.assertEqual(fsm.active_state.short_name, "unlocked")
        self.assertIsNotNone(next(fsm.execute(dl.services.headstand, duration=3), None))
        # the bundled somersault ECU variants are unaffected
        self.assertNotIn("security_chart",
                         [sc.short_name for sc in db.ecu_variants.somersault_lazy.state_charts])


if __name__ == "__main__":
    unittest.main()
