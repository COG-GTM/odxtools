# SPDX-License-Identifier: MIT
import sys
import time
import unittest
from typing import Any, cast
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


#####
# UDS 0x27 SecurityAccess (demo PDX extension somersault_security.pdx)
#####

SECURITY_PDX = WEBDEMO.parent / "somersault_security.pdx"


def _respond(executor: Any, response: bytes) -> None:
    try:
        executor.send(response)
    except StopIteration:
        pass


class TestSecurityPdx(unittest.TestCase):

    def test_state_machine(self) -> None:
        import odxtools
        from odxtools.statemachine import StateMachine

        db = odxtools.load_pdx_file(SECURITY_PDX)
        dl = db.ecu_variants.somersault_assiduous
        seed_svc = dl.services.security_request_seed
        key_svc = dl.services.security_send_key
        headstand = dl.services.headstand
        fsm = StateMachine(dl, dl.state_charts.security_chart)
        self.assertEqual(fsm.active_state.short_name, "locked")

        # the protected service is refused while locked
        with self.assertRaises(StopIteration):
            next(fsm.execute(headstand, duration=3))

        # seed/key en- and decoding
        rq = seed_svc.request.encode()
        self.assertEqual(bytes(rq), bytes.fromhex("2701"))
        msg = dl.decode_response(bytes.fromhex("6701deadbeef"), rq)[0]
        self.assertEqual(msg.param_dict["security_seed"], bytes.fromhex("deadbeef"))
        krq = key_svc.request.encode(security_key=bytes.fromhex("01020304"))
        self.assertEqual(bytes(krq), bytes.fromhex("270201020304"))
        self.assertEqual(dl.decode(krq)[0].service.short_name, "security_send_key")
        self.assertEqual(
            dl.decode_response(bytes.fromhex("6702"), krq)[0].coding_object.short_name,
            "PR_security_key_accepted")
        for code, name in (("35", "InvalidKey"), ("36", "ExceededNumberOfAttempts"),
                           ("37", "RequiredTimeDelayNotExpired")):
            msgs = dl.decode_response(bytes.fromhex("7f27" + code), krq)
            self.assertEqual([m.coding_object.short_name for m in msgs], [name])

        # the transition runs after security_send_key
        ex = fsm.execute(key_svc, security_key=bytes.fromhex("01020304"))
        next(ex)
        _respond(ex, bytes.fromhex("6702"))
        self.assertEqual(fsm.active_state.short_name, "unlocked")
        self.assertEqual(bytes(next(fsm.execute(headstand, duration=3))), bytes.fromhex("0303"))

        # session_stop locks again
        ex = fsm.execute(dl.services.session_stop)
        next(ex)
        _respond(ex, bytes.fromhex("5001"))
        self.assertEqual(fsm.active_state.short_name, "locked")

        # the bare state machine does not look at the response: a
        # rejected key still advances it, which is why the web demo
        # restores the state after a negative response (see below)
        ex = fsm.execute(key_svc, security_key=bytes(4))
        next(ex)
        _respond(ex, bytes.fromhex("7f2735"))
        self.assertEqual(fsm.active_state.short_name, "unlocked")

    def test_generator_is_up_to_date(self) -> None:
        import odxtools
        from examples.mksomersaultsecuritypdx import make_database
        from examples.somersaultecu import database as original

        names = lambda dl: sorted(s.short_name for s in dl.services)  # noqa: E731
        generated = make_database().ecu_variants.somersault_assiduous
        shipped = odxtools.load_pdx_file(SECURITY_PDX).ecu_variants.somersault_assiduous
        self.assertEqual(names(generated), names(shipped))
        self.assertEqual([sc.short_name for sc in shipped.state_charts], ["security_chart"])
        # the original somersault database is left untouched
        self.assertNotIn("security_send_key", names(original.ecu_variants.somersault_assiduous))
        self.assertFalse(original.ecu_variants.somersault_assiduous.state_charts)


@unittest.skipUnless(HAVE_DEPS, "webdemo dependencies are not installed")
class TestWebDemoSecurityAccess(unittest.TestCase):
    server: Any
    client: Any

    @classmethod
    def setUpClass(cls) -> None:
        sys.path.insert(0, str(WEBDEMO))
        import server
        cls.server = server
        cls.client = TestClient(server.app)

    def setUp(self) -> None:
        st = self.client.post(
            "/api/live/start",
            json={
                "db": "somersault_security.pdx",
                "layer": "somersault_assiduous"
            }).json()
        self.assertEqual(st["chart"], "security_chart")
        self.assertEqual(st["charts"], {"security_chart": "locked"})
        self.assertTrue(st["ecu"]["locked"])

    def tearDown(self) -> None:
        assert self.server._live is not None
        self.server._live.close()
        self.server._live = None

    def send(self, service: str, **params: Any) -> dict[str, Any]:
        r = self.client.post("/api/live/send", json={"service": service, "params": params})
        self.assertEqual(r.status_code, 200, r.text)
        return cast(dict[str, Any], r.json())

    def seed(self) -> bytes:
        tx = self.send("security_request_seed")
        self.assertEqual(tx["response"]["coding_object"], "PR_security_seed")
        return bytes.fromhex(tx["response"]["hex"][4:])

    def ecu(self) -> dict[str, Any]:
        return cast(dict[str, Any], self.client.get("/api/live/poll?after=0").json()["ecu"])

    def test_listed_as_demo_extension(self) -> None:
        dbs = {d["name"]: d for d in self.client.get("/api/databases").json()}
        self.assertTrue(dbs["somersault_security.pdx"]["demo_extension"])
        self.assertIsNone(dbs["somersault.pdx"]["demo_extension"])

    def test_locked_and_wrong_keys(self) -> None:
        from virtual_ecu import demo_security_key

        tx = self.send("headstand", duration=3)
        self.assertTrue(tx["blocked"])
        self.assertIsNone(tx["response"])

        # sendKey without a seed
        tx = self.send("security_send_key", security_key="00000000")
        self.assertEqual(tx["response"]["coding_object"], "RequestSequenceError")

        seed = self.seed()
        wrong = bytes(b ^ 0xFF for b in demo_security_key(seed)).hex()
        for attempt in (1, 2):
            tx = self.send("security_send_key", security_key=wrong)
            self.assertEqual(tx["response"]["hex"], "7f2735")
            self.assertEqual(tx["response"]["coding_object"], "InvalidKey")
            # the state machine took the transition for the request, but
            # the negative response restored it
            self.assertEqual((tx["state_before"], tx["state_after"]), ("locked", "locked"))
            self.assertEqual(self.ecu()["attempts"], attempt)
        tx = self.send("security_send_key", security_key=wrong)
        self.assertEqual(tx["response"]["coding_object"], "ExceededNumberOfAttempts")
        self.assertEqual(tx["state_after"], "locked")
        ecu = self.ecu()
        self.assertTrue(ecu["locked"])
        self.assertGreater(ecu["delay_remaining"], 0)

        # the modeled delay: even the correct key is refused
        for service, params in (("security_request_seed", {}), ("security_send_key", {
                "security_key": demo_security_key(seed).hex()
        })):
            tx = self.send(service, **params)
            self.assertEqual(tx["response"]["hex"], "7f2737")
            self.assertEqual(tx["response"]["coding_object"], "RequiredTimeDelayNotExpired")
            self.assertEqual(tx["state_after"], "locked")
        self.assertTrue(self.send("headstand", duration=3)["blocked"])

        # reset() clears attempts and timer
        self.client.post("/api/live/reset")
        ecu = self.ecu()
        self.assertEqual((ecu["attempts"], ecu["delay_remaining"]), (0, 0))

    def test_delay_expires(self) -> None:
        assert self.server._live is not None
        self.server._live.behavior.SECURITY_DELAY_S = 0.2
        self.seed()
        for _ in range(3):
            self.send("security_send_key", security_key="00000000")
        self.assertEqual(self.send("security_request_seed")["response"]["hex"], "7f2737")
        time.sleep(0.3)
        self.assertEqual(self.ecu()["attempts"], 0)
        self.assertEqual(len(self.seed()), 4)

    def test_unlock_and_relock(self) -> None:
        from virtual_ecu import demo_security_key

        seed = self.seed()
        self.assertNotEqual(seed, bytes(4))
        tx = self.send("security_send_key", security_key=demo_security_key(seed).hex())
        self.assertEqual(tx["response"]["hex"], "6702")
        self.assertEqual((tx["state_before"], tx["state_after"]), ("locked", "unlocked"))
        self.assertFalse(self.ecu()["locked"])

        tx = self.send("headstand", duration=3)
        self.assertFalse(tx["blocked"])
        self.assertEqual(tx["response"]["kind"], "positive")

        # an unlocked ECU answers with an all-zero seed
        self.assertEqual(self.seed(), bytes(4))

        tx = self.send("session_stop")
        self.assertEqual(tx["response"]["kind"], "positive")
        self.assertEqual((tx["state_before"], tx["state_after"]), ("unlocked", "locked"))
        self.assertTrue(self.ecu()["locked"])
        self.assertTrue(self.send("headstand", duration=3)["blocked"])

    def test_demo_key_algorithm(self) -> None:
        from virtual_ecu import demo_security_key

        # rotl32(0x12345678 ^ 0x5a5a5a5a, 3) = rotl32(0x486e0c22, 3)
        self.assertEqual(demo_security_key(bytes.fromhex("12345678")).hex(), "43706112")


if __name__ == "__main__":
    unittest.main()
