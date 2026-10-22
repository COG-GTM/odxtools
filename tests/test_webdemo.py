# SPDX-License-Identifier: MIT
import sys
import tempfile
import unittest
from typing import Any
from pathlib import Path

import odxtools
from odxtools.diagnostictroublecode import DiagnosticTroubleCode

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

    def test_dtc_pdx_generator(self) -> None:
        from examples.mksomersaultdtcpdx import build_database

        with tempfile.TemporaryDirectory() as tmp:
            pdx = Path(tmp) / "somersault_dtc.pdx"
            odxtools.write_pdx_file(str(pdx), build_database())
            db = odxtools.load_pdx_file(pdx)
        # the DTC services are defined by the base variant and inherited
        for ecu in ("somersault_lazy", "somersault_assiduous"):
            names = {s.short_name for s in db.ecus[ecu].services}
            self.assertTrue({"read_dtc_by_status_mask", "read_dtc_snapshot", "clear_dtcs"} <= names)
        dl = db.ecus.somersault_lazy
        req = dl.services.read_dtc_by_status_mask.encode_request()
        self.assertEqual(req.hex(), "1902ff")
        self.assertEqual(dl.services.clear_dtcs.encode_request().hex(), "14ffffff")
        self.assertEqual(
            dl.services.read_dtc_snapshot.encode_request(dtc=0x010003).hex(), "190401000301")
        msg = dl.decode_response(bytes.fromhex("5902ff01000209"), req)[0]
        records: Any = msg.param_dict["dtcs"]
        dtc = records[0]["dtc"]
        self.assertIsInstance(dtc, DiagnosticTroubleCode)
        self.assertEqual(dtc.trouble_code, 0x010002)
        self.assertEqual(dtc.text.text, "Flip aborted – too dizzy")
        self.assertEqual(records[0]["status"]["test_failed"], 1)
        self.assertEqual(records[0]["status"]["confirmed_dtc"], 1)

        # the bundled somersault database stays without fault memory
        plain = {
            s.short_name
            for s in self.server.get_db("somersault.pdx").ecus.somersault_lazy.services
        }
        self.assertNotIn("read_dtc_by_status_mask", plain)

    def test_fault_memory(self) -> None:
        self.assertIn("somersault_dtc.pdx",
                      [d["name"] for d in self.client.get("/api/databases").json()])
        self.client.post(
            "/api/live/start",
            json={
                "db": "somersault_dtc.pdx",
                "layer": "somersault_lazy",
                "chart": "angry_chart"
            })

        def send(**body: Any) -> Any:
            r = self.client.post("/api/live/send", json=body)
            self.assertEqual(r.status_code, 200)
            return r.json()

        try:
            tx = send(raw="19 02 ff")
            self.assertEqual(tx["service"], "read_dtc_by_status_mask")
            self.assertEqual(tx["response"]["kind"], "positive")
            self.assertEqual(tx["response"]["params"]["dtcs"], [])

            send(service="session_start", params={"bribe": "1"})
            for _ in range(3):
                tx = send(
                    service="do_forward_flips",
                    params={
                        "forward_soberness_check": "0x12",
                        "num_flips": "5"
                    })
            ecu = self.client.get("/api/live/poll?after=0").json()["ecu"]
            self.assertGreater(ecu["temperature"], ecu["limits"]["temperature"])
            events = ecu["fault_memory"]["events"]
            self.assertEqual(events[0]["kind"], "stored")
            self.assertIn("°C limit", events[0]["trigger"])

            # the fault memory may be read while the ECU is too hot for anything else
            tx = send(service="read_dtc_by_status_mask", params={"status_mask": "0xff"})
            self.assertEqual(tx["request"]["hex"], "1902ff")
            self.assertEqual(tx["response"]["kind"], "positive")
            records = tx["response"]["params"]["dtcs"]
            codes = {r["dtc"]["trouble_code"]: r for r in records}
            self.assertIn(0x010001, codes)
            overheat = codes[0x010001]
            self.assertEqual(overheat["dtc"]["text"], "Acrobat overheated")
            self.assertEqual(overheat["status"]["test_failed"], 1)
            self.assertEqual(overheat["status"]["pending_dtc"], 1)
            spans = [s["param"] for s in tx["response"]["detail_spans"]]
            self.assertIn("dtcs[0].dtc", spans)
            self.assertIn("dtcs[0].status", spans)

            # snapshot (freeze frame) of the stored DTC
            tx = send(
                service="read_dtc_snapshot",
                params={
                    "dtc": overheat["dtc"]["short_name"],
                    "record_number": "1"
                })
            self.assertEqual(tx["request"]["hex"], "190401000101")
            self.assertEqual(tx["response"]["kind"], "positive")
            snap = tx["response"]["params"]["snapshot"]
            self.assertGreater(snap["temperature"], 65)
            self.assertGreater(snap["total_flips"], 0)
            self.assertEqual(tx["response"]["params"]["dtc"]["trouble_code"], 0x010001)

            # snapshots of DTCs which are not stored are refused
            tx = send(raw="19 04 01 00 03 01")
            self.assertEqual(tx["service"], "read_dtc_snapshot")
            self.assertEqual(tx["response"]["kind"], "negative")
            self.assertEqual(tx["response"]["params"]["response_code"], 0x31)

            tx = send(service="clear_dtcs")
            self.assertEqual(tx["request"]["hex"], "14ffffff")
            self.assertEqual(tx["response"]["hex"], "54")
            tx = send(service="read_dtc_by_status_mask")
            self.assertEqual(tx["response"]["params"]["dtcs"], [])

            # the UDS traffic went over the virtual CAN bus
            poll = self.client.get("/api/live/poll?after=0").json()
            self.assertIn("14ffffff", {t for f in poll["frames"] for t in f["telegram"]})
            self.assertEqual(poll["ecu"]["fault_memory"]["events"][-1]["kind"], "cleared")

            # resetting the ECU empties the fault memory and its timeline
            send(service="session_start", params={"bribe": "1"})
            self.client.post("/api/live/reset")
            ecu = self.client.get("/api/live/poll?after=0").json()["ecu"]
            self.assertEqual(ecu["fault_memory"]["events"], [])
        finally:
            assert self.server._live is not None
            self.server._live.close()
            self.server._live = None


if __name__ == "__main__":
    unittest.main()
