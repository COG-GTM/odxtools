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

    def _security_session(self) -> Any:
        self.client.post(
            "/api/live/start",
            json={
                "db": "somersault_security.pdx",
                "layer": "somersault_assiduous",
                "chart": "security_chart"
            })

        def send(service: str, **params: Any) -> Any:
            return self.client.post(
                "/api/live/send", json={
                    "service": service,
                    "params": params
                }).json()

        return send

    def _close_live(self) -> None:
        assert self.server._live is not None
        self.server._live.close()
        self.server._live = None

    def test_security_demo_key(self) -> None:
        from virtual_ecu import demo_security_key
        self.assertEqual(demo_security_key(bytes.fromhex("12345678")).hex(), "43706112")
        self.assertEqual(demo_security_key(bytes(4)).hex(), "d2d2d2d2")

    def test_security_access_lockout(self) -> None:
        send = self._security_session()
        try:
            summary = self.client.get("/api/db/somersault_security.pdx").json()
            self.assertTrue(summary["demo_extension"])
            self.assertFalse(self.client.get("/api/db/somersault.pdx").json()["demo_extension"])

            # the protected service is blocked by the ODX pre-condition while locked
            tx = send("headstand", duration="3")
            self.assertTrue(tx["blocked"])
            self.assertEqual(tx["state_before"], "locked")
            st = self.client.get("/api/live/poll?after=0").json()
            self.assertEqual(st["gates"]["headstand"], {"allowed": False, "requires": ["unlocked"]})

            # sendKey without a seed
            tx = send("security_send_key", security_key="00000000")
            self.assertEqual(tx["response"]["coding_object"], "security_request_sequence_error")

            for attempt in range(1, 4):
                tx = send("security_request_seed")
                self.assertEqual(tx["response"]["coding_object"], "security_seed")
                self.assertEqual(tx["response"]["hex"][:4], "6701")
                tx = send("security_send_key", security_key="00000000")
                self.assertEqual(tx["request"]["hex"], "270200000000")
                # the ECU's negative response rolls back the locked -> unlocked transition
                self.assertEqual(tx["state_before"], "locked")
                self.assertEqual(tx["state_after"], "locked")
                nrc = tx["response"]["hex"]
                if attempt < 3:
                    self.assertEqual(nrc, "7f2735")
                    self.assertEqual(tx["response"]["coding_object"], "security_invalid_key")
                else:
                    self.assertEqual(nrc, "7f2736")
                self.assertEqual(
                    self.client.get("/api/live/poll?after=0").json()["ecu"]["security"]["attempts"],
                    attempt)

            # the modeled delay is running: both sub-functions answer 0x37
            for service, params in (("security_request_seed", {}), ("security_send_key", {
                    "security_key": "00000000"
            })):
                tx = send(service, **params)
                self.assertEqual(tx["response"]["hex"], "7f2737")
                self.assertEqual(tx["response"]["coding_object"],
                                 "security_required_time_delay_not_expired")
            sec = self.client.get("/api/live/poll?after=0").json()["ecu"]["security"]
            self.assertTrue(sec["locked"])
            self.assertGreater(sec["delay_remaining"], 0)
            self.assertEqual(sec["delay_total"], 10.0)

            # the delay timer runs on the tick() clock, reset() clears it
            self.client.post("/api/live/reset")
            sec = self.client.get("/api/live/poll?after=0").json()["ecu"]["security"]
            self.assertEqual((sec["attempts"], sec["delay_remaining"]), (0, 0))
        finally:
            self._close_live()

    def test_security_access_unlock_and_relock(self) -> None:
        from virtual_ecu import demo_security_key
        send = self._security_session()
        try:
            tx = send("security_request_seed")
            seed = bytes.fromhex(tx["response"]["params"]["security_seed"][2:])
            self.assertEqual(len(seed), 4)
            self.assertEqual([s["param"] for s in tx["response"]["spans"]],
                             ["sid", "security_access_type", "security_seed"])
            key = demo_security_key(seed)
            tx = send("security_send_key", security_key=key.hex())
            self.assertEqual(tx["request"]["hex"], "2702" + key.hex())
            self.assertEqual(tx["response"]["hex"], "6702")
            self.assertEqual((tx["state_before"], tx["state_after"]), ("locked", "unlocked"))
            st = self.client.get("/api/live/poll?after=0").json()
            self.assertFalse(st["ecu"]["security"]["locked"])
            self.assertTrue(st["gates"]["headstand"]["allowed"])

            tx = send("headstand", duration="3")
            self.assertFalse(tx["blocked"])
            self.assertEqual(tx["response"]["kind"], "positive")

            # an unlocked ECU answers requestSeed with an all-zero seed
            tx = send("security_request_seed")
            self.assertEqual(tx["response"]["hex"], "670100000000")

            # raw 0x27 telegrams are identified and decoded, too
            tx = self.client.post("/api/live/send", json={"raw": "27 01"}).json()
            self.assertEqual(tx["service"], "security_request_seed")

            tx = send("session_stop")
            self.assertEqual((tx["state_before"], tx["state_after"]), ("unlocked", "locked"))
            self.assertTrue(
                self.client.get("/api/live/poll?after=0").json()["ecu"]["security"]["locked"])
            self.assertTrue(send("headstand", duration="3")["blocked"])
        finally:
            self._close_live()

    def test_security_pdx_state_machine(self) -> None:
        import odxtools
        from odxtools.statemachine import StateMachine
        db = odxtools.load_pdx_file(str(WEBDEMO.parent / "somersault_security.pdx"))
        dl = db.ecu_variants.somersault_assiduous
        chart = dl.state_charts.security_chart
        self.assertEqual(chart.start_state.short_name, "locked")
        fsm = StateMachine(dl, chart)
        with self.assertRaises(StopIteration):
            next(fsm.execute(dl.services.headstand, duration=3))
        self.assertFalse(fsm.succeeded)
        seed_rq = dl.services.security_request_seed.request.encode()
        self.assertEqual(seed_rq.hex(), "2701")
        for nrc, name in ((0x35, "invalid_key"), (0x36, "exceeded_number_of_attempts"),
                          (0x37, "required_time_delay_not_expired")):
            msgs = dl.decode_response(bytes([0x7f, 0x27, nrc]), seed_rq)
            self.assertEqual([m.coding_object.short_name for m in msgs], [f"security_{name}"])
        ex = fsm.execute(dl.services.security_send_key, security_key=bytes(4))
        self.assertEqual(next(ex).hex(), "270200000000")
        try:
            ex.send(bytes.fromhex("6702"))
        except StopIteration:
            pass
        self.assertEqual(fsm.active_state.short_name, "unlocked")
        self.assertEqual(next(fsm.execute(dl.services.headstand, duration=3)).hex(), "0303")
        # the bundled PDX is untouched: no security services there
        orig = odxtools.load_pdx_file(str(WEBDEMO.parent / "somersault.pdx"))
        self.assertNotIn("security_request_seed",
                         [s.short_name for s in orig.ecu_variants.somersault_assiduous.services])


if __name__ == "__main__":
    unittest.main()
