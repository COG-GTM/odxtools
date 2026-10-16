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

    def test_dtc_pdx_generator(self) -> None:
        import tempfile

        import odxtools
        from odxtools.diagnostictroublecode import DiagnosticTroubleCode
        sys.path.insert(0, str(WEBDEMO.parent.parent))
        from examples import mksomersaultdtcpdx, somersaultecu

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "somersault_dtc.pdx"
            odxtools.write_pdx_file(
                str(out), mksomersaultdtcpdx.add_fault_memory(somersaultecu.database))
            db = odxtools.load_pdx_file(str(out))
        # the upstream example database is not modified
        self.assertNotIn("read_dtc_by_status_mask", [
            s.short_name for s in somersaultecu.database.ecus.somersault_lazy.services
        ])
        for variant in ("somersault_lazy", "somersault_assiduous"):
            dl = db.ecus[variant]
            req = dl.services.read_dtc_by_status_mask(status_mask=0xFF)
            self.assertEqual(req.hex(), "1902ff")
            self.assertEqual(
                dl.services.read_dtc_snapshot(dtc=0x010003, record_number=1).hex(), "190401000301")
            self.assertEqual(dl.services.clear_dtcs().hex(), "14ffffff")
            msg = dl.decode_response(bytes.fromhex("5902ff0100020d"), req)[0]
            dtc = msg.param_dict["dtc_records"][0]["dtc"]  # type: ignore[index]
            self.assertIsInstance(dtc, DiagnosticTroubleCode)
            self.assertEqual(dtc.trouble_code, 0x010002)
            self.assertEqual(dtc.text.text, "Flip aborted – too dizzy")

    def test_fault_memory(self) -> None:
        dbs = {d["name"]: d for d in self.client.get("/api/databases").json()}
        self.assertTrue(dbs["somersault_dtc.pdx"]["demo_extension"])
        self.assertFalse(dbs["somersault.pdx"]["demo_extension"])
        self.assertEqual(next(iter(dbs)), "somersault.pdx")
        r = self.client.post(
            "/api/live/start", json={
                "db": "somersault_dtc.pdx",
                "layer": "somersault_assiduous"
            })
        self.assertEqual(r.status_code, 200, r.text)

        def send(**body: Any) -> dict[str, Any]:
            r = self.client.post("/api/live/send", json=body)
            self.assertEqual(r.status_code, 200, r.text)
            return r.json()  # type: ignore[no-any-return]

        try:
            tx = send(raw="19 02 ff")
            self.assertEqual(tx["service"], "read_dtc_by_status_mask")
            self.assertEqual(tx["response"]["params"]["dtc_records"], [])

            # overheat the acrobat: 12 forward flips heat it up by 30 °C
            send(service="session_start", params={"bribe": "1"})
            for n in ("10", "2"):
                send(
                    service="do_forward_flips",
                    params={
                        "forward_soberness_check": "0x12",
                        "num_flips": n
                    })
            ecu = self.client.get("/api/live/poll").json()["ecu"]
            self.assertGreater(ecu["temperature"], ecu["limits"]["temperature"])
            self.assertEqual([e["kind"] for e in ecu["fault_memory"]["events"]], ["stored"])

            # the fault memory is readable although the ECU is too hot
            tx = send(service="read_dtc_by_status_mask", params={"status_mask": "0xff"})
            self.assertEqual(tx["response"]["kind"], "positive")
            self.assertGreaterEqual(tx["frames"], 1)
            records = tx["response"]["params"]["dtc_records"]
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["dtc"]["trouble_code"], 0x010001)
            self.assertEqual(records[0]["dtc"]["text"], "Acrobat overheated")
            self.assertEqual(records[0]["status"]["test_failed"], 1)
            self.assertEqual(records[0]["status"]["confirmed_dtc"], 1)
            paths = [s["path"] for s in tx["response"]["detail_spans"]]
            self.assertIn("dtc_records[0].dtc", paths)

            tx = send(service="read_dtc_snapshot", params={"dtc": "0x010001", "record_number": "1"})
            self.assertEqual(tx["response"]["kind"], "positive")
            snap = tx["response"]["params"]["snapshot"]
            self.assertGreaterEqual(snap["temperature"], ecu["limits"]["temperature"])
            self.assertEqual(snap["total_flips"], 12)
            self.assertEqual(tx["response"]["params"]["dtc"]["text"], "Acrobat overheated")

            # snapshot of a DTC which is not stored
            tx = send(raw="19 04 01 00 03 01")
            self.assertEqual(tx["service"], "read_dtc_snapshot")
            self.assertEqual(tx["response"]["kind"], "negative")
            self.assertEqual(tx["response"]["nrc"]["name"], "RequestOutOfRange")

            # clearing while still too hot re-detects the active overheat
            tx = send(service="clear_dtcs")
            self.assertEqual(tx["response"]["hex"], "54")
            tx = send(service="read_dtc_by_status_mask", params={"status_mask": "0xff"})
            self.assertEqual([
                r["dtc"]["trouble_code"] for r in tx["response"]["params"]["dtc_records"]
            ], [0x010001])

            assert self.server._live is not None
            self.server._live.behavior.temperature = 40.0
            tx = send(service="clear_dtcs")
            self.assertEqual(tx["response"]["hex"], "54")
            tx = send(service="read_dtc_by_status_mask", params={"status_mask": "0xff"})
            self.assertEqual(tx["response"]["params"]["dtc_records"], [])
        finally:
            assert self.server._live is not None
            self.server._live.close()
            self.server._live = None


if __name__ == "__main__":
    unittest.main()
