#! /usr/bin/env python3
#
# SPDX-License-Identifier: MIT
"""ODX Diagnostic Workbench: a web UI on top of odxtools.

Run with ``python3 examples/webdemo/server.py`` and open
http://localhost:8000.
"""
import argparse
import io
import itertools
import math
import os
import re
import sys
import tempfile
import threading
import time
import warnings
from collections import deque
from pathlib import Path
from typing import Any, cast

import can
import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent))

import odxtools  # noqa: E402
import odxtools.uds as uds  # noqa: E402
from odxtools.cli.compare import DiffEngine  # noqa: E402
from odxtools.compumethods.compucategory import CompuCategory  # noqa: E402
from odxtools.database import Database  # noqa: E402
from odxtools.dataobjectproperty import DataObjectProperty  # noqa: E402
from odxtools.diaglayers.diaglayer import DiagLayer  # noqa: E402
from odxtools.diaglayers.hierarchyelement import HierarchyElement  # noqa: E402
from odxtools.diagservice import DiagService  # noqa: E402
from odxtools.isotp_state_machine import IsoTpStateMachine  # noqa: E402
from odxtools.message import Message  # noqa: E402
from odxtools.parameters.codedconstparameter import CodedConstParameter  # noqa: E402
from odxtools.odxtypes import DataType  # noqa: E402
from odxtools.parameters.parameter import Parameter  # noqa: E402
from odxtools.response import Response, ResponseType  # noqa: E402
from odxtools.statemachine import StateMachine  # noqa: E402
from virtual_ecu import CanNetwork, SomersaultBehavior  # noqa: E402

warnings.simplefilter("ignore")
odxtools.exceptions.strict_mode = False

EXAMPLES = HERE.parent
UPLOAD_DIR = Path(tempfile.gettempdir()) / "odx-workbench-uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
MAX_UPLOAD_BYTES = 50 * 1024 * 1024

app = FastAPI(title="ODX Diagnostic Workbench")

_db_cache: dict[str, Database] = {}
_db_lock = threading.Lock()


def _pdx_files() -> dict[str, Path]:
    files = {p.name: p for p in sorted(EXAMPLES.glob("*.pdx"))}
    files.update({p.name: p for p in sorted(UPLOAD_DIR.glob("*.pdx"))})
    return files


def get_db(name: str) -> Database:
    with _db_lock:
        if name not in _db_cache:
            files = _pdx_files()
            if name not in files:
                raise HTTPException(404, f"unknown database {name}")
            t0 = time.perf_counter()
            db = odxtools.load_pdx_file(files[name])
            db._load_time_ms = (time.perf_counter() - t0) * 1000  # type: ignore[attr-defined]
            _db_cache[name] = db
        return _db_cache[name]


def get_layer(db: Database, layer: str) -> DiagLayer:
    for dl in db.diag_layers:
        if dl.short_name == layer:
            return dl
    raise HTTPException(404, f"unknown diagnostic layer {layer}")


def get_service(dl: DiagLayer, name: str) -> DiagService:
    for s in dl.services:
        if s.short_name == name:
            return s
    raise HTTPException(404, f"service {name} not available in {dl.short_name}")


_RICH = re.compile(r"\[/?[a-z_ #0-9]+\]")


def _plain(x: Any) -> Any:
    if isinstance(x, (bytes, bytearray)):
        return "0x" + bytes(x).hex()
    if isinstance(x, dict):
        return {k: _plain(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_plain(v) for v in x]
    if isinstance(x, float) and not math.isfinite(x):
        return str(x)
    if isinstance(x, str):
        return _RICH.sub("", x)
    if x is None or isinstance(x, (int, float, bool)):
        return x
    return str(x)


#####
# description of database objects
#####


def _desc(obj: Any) -> str | None:
    d = getattr(obj, "description", None)
    if d is None:
        return None
    return re.sub(r"<[^>]+>", "", getattr(d, "text", str(d))).strip() or None


def dop_info(dop: Any) -> dict[str, Any] | None:
    if dop is None:
        return None
    info: dict[str, Any] = {"name": dop.short_name, "kind": type(dop).__name__}
    if isinstance(dop, DataObjectProperty):
        cm = dop.compu_method
        info["compu_method"] = cm.category.value
        info["physical_type"] = dop.physical_type.base_data_type.value
        dct = dop.diag_coded_type
        info["coded_type"] = f"{type(dct).__name__}({dct.base_data_type.value}" + (
            f", {bit_length} bit)" if (bit_length := getattr(dct, "bit_length", None)) else ")")
        info["unit"] = dop.unit.display_name if dop.unit is not None else None
        if cm.category == CompuCategory.TEXTTABLE:
            vals = []
            itp = cm.compu_internal_to_phys
            for scale in itp.compu_scales if itp is not None else []:
                lo = scale.lower_limit.value if scale.lower_limit else None
                vt = scale.compu_const.vt if scale.compu_const else None
                vals.append({"internal": lo, "physical": vt})
            info["texttable"] = vals
        if dop.internal_constr is not None:
            c = dop.internal_constr
            info["range"] = [
                c.lower_limit.value if c.lower_limit else None,
                c.upper_limit.value if c.upper_limit else None
            ]
    return info


def param_info(p: Parameter) -> dict[str, Any]:
    info: dict[str, Any] = {
        "name": p.short_name,
        "long_name": p.long_name,
        "description": _desc(p),
        "type": type(p).__name__.replace("Parameter", ""),
        "byte_position": p.byte_position,
        "bit_position": p.bit_position,
        "bit_length": p.get_static_bit_length(),
        "required": p.is_required,
        "settable": p.is_settable,
    }
    for attr in ("coded_value", "coded_values"):
        if hasattr(p, attr):
            try:
                info["coded_value"] = _plain(getattr(p, attr))
            except Exception:
                pass
    if hasattr(p, "physical_default_value"):
        info["default"] = _plain(getattr(p, "physical_default_value", None))
    dop = getattr(p, "dop", None)
    info["dop"] = dop_info(dop)
    if type(p).__name__ == "TableKeyParameter":
        info["table"] = {
            "name": p.table.short_name,  # type: ignore[attr-defined]
            "rows": [r.short_name for r in p.table.table_rows],  # type: ignore[attr-defined]
        }
    return info


def coding_object_info(obj: Any) -> dict[str, Any] | None:
    if obj is None:
        return None
    rt = None
    if isinstance(obj, Response):
        rt = obj.response_type.value
    return {
        "name": obj.short_name,
        "response_type": rt,
        "params": [param_info(p) for p in obj.parameters],
    }


def layer_summary(dl: DiagLayer) -> dict[str, Any]:
    own = {getattr(x, "short_name", None) for x in dl.diag_comms_raw}
    comparams: dict[str, Any] = {}
    for key, fn in (("can_receive_id", "get_can_receive_id"), ("can_send_id", "get_can_send_id"),
                    ("can_func_req_id", "get_can_func_req_id"), ("baudrate", "get_can_baudrate"),
                    ("tester_present_time", "get_tester_present_time")):
        try:
            v = getattr(dl, fn)() if hasattr(dl, fn) else None
        except Exception:
            v = None
        if v is not None:
            comparams[key] = v
    not_inherited: list[str] = []
    parent_refs: list[Any] = list(getattr(dl, "parent_refs", []))
    for pr in parent_refs:
        not_inherited += list(getattr(pr, "not_inherited_diag_comms", []))

    charts = []
    for sc in dl.state_charts:
        triggers: dict[str, list[str]] = {}
        for s in dl.services:
            for r in s.state_transition_refs:
                st = r.state_transition
                if st is not None:
                    triggers.setdefault(st.short_name, []).append(s.short_name)
        charts.append({
            "name":
                sc.short_name,
            "semantic":
                sc.semantic,
            "start":
                sc.start_state.short_name,
            "states": [s.short_name for s in sc.states],
            "transitions": [{
                "name": t.short_name,
                "from": t.source_snref,
                "to": t.target_snref,
                "services": triggers.get(t.short_name, [])
            } for t in sc.state_transitions],
        })

    return {
        "name": dl.short_name,
        "long_name": dl.long_name,
        "description": _desc(dl),
        "variant_type": dl.variant_type.value,
        "parents": [pr.layer.short_name for pr in parent_refs],
        "not_inherited": not_inherited,
        "services": [{
            "name":
                s.short_name,
            "semantic":
                s.semantic,
            "own":
                s.short_name in own,
            "request_hex":
                bytes(s.request.coded_const_prefix()).hex() if s.request is not None else None,
            "description":
                _desc(s),
        } for s in dl.services],
        "single_ecu_jobs": [j.short_name for j in dl.single_ecu_jobs],
        "global_negative_responses": [r.short_name for r in dl.global_negative_responses],
        "dops": len(dl.diag_data_dictionary_spec.all_data_object_properties),
        "comparams": comparams,
        "state_charts": charts,
    }


@app.get("/api/databases")
def list_databases() -> list[dict[str, Any]]:
    return [{
        "name": n,
        "size": p.stat().st_size,
        "bundled": p.parent == EXAMPLES
    } for n, p in _pdx_files().items()]


@app.post("/api/upload")
async def upload(file: UploadFile) -> dict[str, Any]:
    if not file.filename or not file.filename.lower().endswith(".pdx"):
        raise HTTPException(400, "please upload a .pdx file")
    dest = UPLOAD_DIR / Path(file.filename).name
    tmp = UPLOAD_DIR / f".{dest.name}.{threading.get_ident()}.{time.monotonic_ns()}.part"
    try:
        size = 0
        with tmp.open("wb") as f:
            while chunk := await file.read(1 << 20):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "PDX file too large")
                f.write(chunk)
        try:
            t0 = time.perf_counter()
            # load from memory so that no handle to the temporary
            # file stays open (os.replace fails on Windows otherwise)
            db = Database()
            db.add_pdx_file(io.BytesIO(tmp.read_bytes()))
            db.refresh()
            db._load_time_ms = (time.perf_counter() - t0) * 1000  # type: ignore[attr-defined]
        except Exception as e:
            raise HTTPException(400, f"could not load PDX: {e}") from e
        with _db_lock:
            os.replace(tmp, dest)
            _db_cache[dest.name] = db
    finally:
        tmp.unlink(missing_ok=True)
    return {"name": dest.name}


@app.get("/api/db/{name}")
def db_summary(name: str) -> dict[str, Any]:
    db = get_db(name)
    revisions = []
    for dlc in db.diag_layer_containers:
        ad = dlc.admin_data
        for rev in (ad.doc_revisions if ad else []):
            revisions.append({
                "container": dlc.short_name,
                "label": rev.revision_label,
                "state": rev.state,
                "date": rev.date,
                "tool": rev.tool,
                "changes": [{
                    "change": m.change,
                    "reason": m.reason
                } for m in rev.modifications],
            })
    return {
        "name": name,
        "load_time_ms": round(getattr(db, "_load_time_ms", 0.0), 1),
        "containers": [c.short_name for c in db.diag_layer_containers],
        "comparam_subsets": [c.short_name for c in db.comparam_subsets],
        "layers": [layer_summary(dl) for dl in db.diag_layers],
        "revisions": revisions,
        "auxiliary_files": sorted(db.auxiliary_files.keys()),
    }


@app.get("/api/db/{name}/layer/{layer}/service/{service}")
def service_detail(name: str, layer: str, service: str) -> dict[str, Any]:
    dl = get_layer(get_db(name), layer)
    s = get_service(dl, service)
    return {
        "name": s.short_name,
        "long_name": s.long_name,
        "description": _desc(s),
        "semantic": s.semantic,
        "request": coding_object_info(s.request),
        "positive_responses": [coding_object_info(r) for r in s.positive_responses],
        "negative_responses": [coding_object_info(r) for r in s.negative_responses],
        "global_negative_responses": [coding_object_info(r) for r in dl.global_negative_responses],
        "preconditions": [r.ref_id for r in s.pre_condition_state_refs],
    }


#####
# en- and decoding
#####


def _coerce(p: Parameter, value: Any) -> Any:
    if isinstance(value, (dict, list)) or value is None:
        return value
    dop = getattr(p, "dop", None)
    ptype = None
    if isinstance(dop, DataObjectProperty):
        ptype = dop.physical_type.base_data_type
    sval = str(value).strip()
    if ptype in (DataType.A_INT32, DataType.A_UINT32):
        return int(sval, 0)
    if ptype in (DataType.A_FLOAT32, DataType.A_FLOAT64):
        return float(sval)
    if ptype == DataType.A_BYTEFIELD:
        return bytes.fromhex(sval.removeprefix("0x"))
    return sval


def byte_spans(obj: Any, pdu: bytes) -> list[dict[str, Any]]:
    """Map each top-level parameter onto the byte range it occupies."""
    spans = []
    params = list(obj.parameters)
    cursor = 0
    for i, p in enumerate(params):
        start = p.byte_position if p.byte_position is not None else cursor
        bl = p.get_static_bit_length()
        if bl is not None:
            length = max(1, ((p.bit_position or 0) + bl + 7) // 8)
        else:
            nxt = [q.byte_position for q in params[i + 1:] if q.byte_position is not None]
            length = (min(nxt) if nxt else len(pdu)) - start
        if type(p).__name__ == "TableKeyParameter" and start >= len(pdu):
            continue
        length = max(0, min(length, len(pdu) - start))
        if length == 0 and type(p).__name__ == "TableStructParameter":
            continue
        spans.append({"param": p.short_name, "start": start, "length": length})
        cursor = start + length
    return spans


def describe_message(msg: Any) -> dict[str, Any]:
    obj = msg.coding_object
    kind = "request"
    if isinstance(obj, Response):
        kind = {
            ResponseType.POSITIVE: "positive",
            ResponseType.NEGATIVE: "negative",
            ResponseType.GLOBAL_NEGATIVE: "global_negative",
        }.get(obj.response_type, "response")
    pdu = bytes(msg.coded_message)
    return {
        "service": msg.service.short_name if msg.service is not None else None,
        "coding_object": obj.short_name,
        "kind": kind,
        "hex": pdu.hex(),
        "params": _plain(msg.param_dict),
        "spans": byte_spans(obj, pdu),
    }


def describe_raw_uds(pdu: bytes) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": "unknown", "hex": pdu.hex(), "params": {}, "spans": []}
    if not pdu:
        return out
    if pdu[0] == uds.NegativeResponseId and len(pdu) >= 3:
        try:
            nrc = uds.NegativeResponseCodes(pdu[2]).name
        except ValueError:
            nrc = f"0x{pdu[2]:02x}"
        out.update(
            kind="negative",
            coding_object="UDS negative response (not in ODX)",
            params={
                "rq_sid": f"0x{pdu[1]:02x} ({uds.sid_to_name(pdu[1]) or '?'})",
                "nrc": nrc
            },
            spans=[{
                "param": "sid",
                "start": 0,
                "length": 1
            }, {
                "param": "rq_sid",
                "start": 1,
                "length": 1
            }, {
                "param": "nrc",
                "start": 2,
                "length": 1
            }])
    else:
        out["coding_object"] = f"SID 0x{pdu[0]:02x}: {uds.sid_to_name(pdu[0]) or 'unknown'}"
    return out


class EncodeBody(BaseModel):
    layer: str
    service: str
    params: dict[str, Any] = {}


def _encode(dl: DiagLayer, s: DiagService, raw_params: dict[str,
                                                            Any]) -> tuple[bytes, dict[str, Any]]:
    if s.request is None:
        raise HTTPException(400, "service has no request")
    params = {}
    for p in s.request.parameters:
        if p.short_name in raw_params and raw_params[p.short_name] not in ("", None):
            try:
                params[p.short_name] = _coerce(p, raw_params[p.short_name])
            except ValueError as e:
                raise HTTPException(400, f"{p.short_name}: {e}") from e
    return bytes(s.request.encode(**params)), params


@app.post("/api/db/{name}/encode")
def encode(name: str, body: EncodeBody) -> dict[str, Any]:
    dl = get_layer(get_db(name), body.layer)
    s = get_service(dl, body.service)
    try:
        pdu, _ = _encode(dl, s, body.params)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}") from e
    msg = dl.decode(pdu)[0]
    return describe_message(msg)


class DecodeBody(BaseModel):
    layer: str
    hex: str
    request_hex: str | None = None


def _hex(s: str) -> bytes:
    s = re.sub(r"[\s:,]|0x", "", s)
    try:
        return bytes.fromhex(s)
    except ValueError as e:
        raise HTTPException(400, f"invalid hex: {e}") from e


def decode_pdu(dl: DiagLayer, pdu: bytes, req: bytes | None) -> list[dict[str, Any]]:
    try:
        msgs = dl.decode_response(pdu, req) if req else dl.decode(pdu)
    except Exception:
        msgs = []
    msgs = [m for m in msgs if m.coding_object is not None]
    if not msgs and req:
        # responses which may be sent for any request
        for gnr in getattr(dl, "global_negative_responses", []):
            try:
                param_dict = gnr.decode(pdu)
            except Exception:
                continue
            # the decoder does not verify CODED-CONSTs (which may be
            # bit-packed), so compare the decoded values
            if any(
                    isinstance(p, CodedConstParameter) and
                    param_dict.get(p.short_name) != p.coded_value for p in gnr.parameters):
                continue
            msgs = [
                Message(
                    coded_message=pdu,
                    service=cast(Any, None),
                    coding_object=gnr,
                    param_dict=param_dict)
            ]
            break
    if not msgs:
        return [describe_raw_uds(pdu)]
    return [describe_message(m) for m in msgs]


@app.post("/api/db/{name}/decode")
def decode(name: str, body: DecodeBody) -> list[dict[str, Any]]:
    dl = get_layer(get_db(name), body.layer)
    return decode_pdu(dl, _hex(body.hex), _hex(body.request_hex) if body.request_hex else None)


@app.get("/api/compare")
def compare(old: str, new: str) -> dict[str, Any]:
    t0 = time.perf_counter()
    changes = DiffEngine().compare_databases(get_db(new), get_db(old))
    dt = (time.perf_counter() - t0) * 1000
    if changes is None:
        return {"changes": None, "summary": {}, "time_ms": dt}
    return {"changes": _plain(changes.to_dict()), "summary": changes.summary, "time_ms": dt}


#####
# live virtual vehicle network
#####


class LiveSession:

    def __init__(self, db_name: str, layer: str) -> None:
        self.db_name = db_name
        self.dl = get_layer(get_db(db_name), layer)
        if self.dl.variant_type.value != "ECU-VARIANT":
            raise HTTPException(400, "please select an ECU variant")
        assert isinstance(self.dl, HierarchyElement)
        self.rx_id = self.dl.get_can_receive_id()
        self.tx_id = self.dl.get_can_send_id()
        if self.rx_id is None or self.tx_id is None:
            raise HTTPException(400, "ECU variant does not specify CAN IDs")
        self.seq = itertools.count(1)
        self.frames: deque[dict[str, Any]] = deque(maxlen=2000)
        self.transactions: deque[dict[str, Any]] = deque(maxlen=500)
        self.t0 = time.monotonic()
        self.behavior = SomersaultBehavior(self.dl)
        self.fsms = {sc.short_name: StateMachine(self.dl, sc) for sc in self.dl.state_charts}
        self.chart = next(iter(self.fsms), None)
        # passive ISO-TP reassembly of the sniffed traffic, like `odxtools snoop`
        self.snooper = IsoTpStateMachine([self.rx_id, self.tx_id])
        self.net = CanNetwork(self.rx_id, self.tx_id, self.behavior, self._on_frame,
                              f"odxdemo-{id(self)}")

    def _on_frame(self, msg: can.Message, node: str) -> None:
        data = bytes(msg.data)
        pci = data[0] >> 4 if data else -1
        kind = {0: "SF", 1: "FF", 2: "CF", 3: "FC"}.get(pci, "?")
        telegrams = list(self.snooper.decode_rx_frame(msg.arbitration_id, data))
        self.frames.append({
            "seq": next(self.seq),
            "t": round((time.monotonic() - self.t0) * 1000, 2),
            "id": msg.arbitration_id,
            "node": node,
            "dlc": msg.dlc,
            "data": data.hex(),
            "isotp": kind,
            "telegram": [bytes(t[1]).hex() for t in telegrams],
        })

    def send(self, pdu: bytes, service: DiagService | None, params: dict[str,
                                                                         Any]) -> dict[str, Any]:
        fsm = self.fsms.get(self.chart) if self.chart else None
        executor = None
        state_obj_before = fsm.active_state if fsm else None
        state_before = fsm.active_state.short_name if fsm else None
        if fsm is not None and service is not None:
            fsm.succeeded = True
            executor = fsm.execute(service, **params)
            try:
                next(executor)
            except StopIteration:
                # odxtools refused to execute the service because none
                # of its PRE-CONDITION-STATE-REFs applies
                return self._record(pdu, None, service, 0.0, state_before, blocked=True)

        frames_before = len(self.frames)
        t = time.perf_counter()
        resp = self.net.request(pdu)
        latency = (time.perf_counter() - t) * 1000
        if executor is not None and resp is not None:
            try:
                executor.send(resp)
            except (StopIteration, Exception):
                pass
            # the ECU refused the request: it must not change the tester's
            # view of the ECU state
            if fsm is not None and state_obj_before is not None and resp[:1] == bytes(
                [uds.NegativeResponseId]):
                fsm.active_state = state_obj_before
        tx = self._record(pdu, resp, service, latency, state_before)
        tx["frames"] = len(self.frames) - frames_before
        return tx

    def identify_request(self, pdu: bytes) -> tuple[DiagService | None, dict[str, Any]]:
        """Map a raw telegram to the ODX service it unambiguously encodes
        so that it runs through the state chart like a named request."""
        try:
            msgs = self.dl.decode(pdu)
        except Exception:
            return None, {}
        if len(msgs) != 1 or not isinstance(msgs[0].service, DiagService):
            return None, {}
        service = msgs[0].service
        if service.request is None or msgs[0].coding_object is not service.request:
            return None, {}
        settable = {p.short_name for p in service.request.parameters if p.is_settable}
        params = {k: v for k, v in msgs[0].param_dict.items() if k in settable}
        # telegrams with trailing bytes still decode (and are executed
        # by the ECU), so they are subject to the state chart as well
        return service, params

    def _record(self,
                pdu: bytes,
                resp: bytes | None,
                service: DiagService | None,
                latency: float,
                state_before: str | None,
                blocked: bool = False) -> dict[str, Any]:
        fsm = self.fsms.get(self.chart) if self.chart else None
        tx = {
            "seq": next(self.seq),
            "t": round((time.monotonic() - self.t0) * 1000, 2),
            "service": service.short_name if service else None,
            "request": decode_pdu(self.dl, pdu, None)[0],
            "response": decode_pdu(self.dl, resp, pdu)[0] if resp else None,
            "latency_ms": round(latency, 2),
            "blocked": blocked,
            "chart": self.chart,
            "state_before": state_before,
            "state_after": fsm.active_state.short_name if fsm else None,
        }
        self.transactions.append(tx)
        return tx

    def status(self, after: int) -> dict[str, Any]:
        return {
            "db": self.db_name,
            "layer": self.dl.short_name,
            "rx_id": self.rx_id,
            "tx_id": self.tx_id,
            "frames": [f for f in list(self.frames) if f["seq"] > after],
            "transactions": [t for t in list(self.transactions) if t["seq"] > after],
            "ecu": self.behavior.snapshot(),
            "chart": self.chart,
            "charts": {
                k: v.active_state.short_name
                for k, v in self.fsms.items()
            },
            "frame_count": len(self.frames),
        }

    def close(self) -> None:
        self.net.shutdown()


_live: LiveSession | None = None
_live_lock = threading.Lock()


class LiveStartBody(BaseModel):
    db: str
    layer: str
    chart: str | None = None


@app.post("/api/live/start")
def live_start(body: LiveStartBody) -> dict[str, Any]:
    global _live
    with _live_lock:
        if _live is not None:
            _live.close()
            _live = None
        _live = LiveSession(body.db, body.layer)
        if body.chart and body.chart in _live.fsms:
            _live.chart = body.chart
        return _live.status(0)


def _require_live() -> LiveSession:
    """Must be called while holding `_live_lock`."""
    if _live is None:
        raise HTTPException(409, "virtual network not running")
    return _live


class LiveSendBody(BaseModel):
    service: str | None = None
    params: dict[str, Any] = {}
    raw: str | None = None


@app.post("/api/live/send")
def live_send(body: LiveSendBody) -> dict[str, Any]:
    with _live_lock:
        live = _require_live()
        if body.raw:
            pdu = _hex(body.raw)
            service, params = live.identify_request(pdu)
            return live.send(pdu, service, params)
        if not body.service:
            raise HTTPException(400, "service or raw required")
        s = get_service(live.dl, body.service)
        try:
            pdu, params = _encode(live.dl, s, body.params)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(400, f"{type(e).__name__}: {e}") from e
        return live.send(pdu, s, params)


class ChartBody(BaseModel):
    chart: str


@app.post("/api/live/chart")
def live_chart(body: ChartBody) -> dict[str, Any]:
    with _live_lock:
        live = _require_live()
        if body.chart not in live.fsms:
            raise HTTPException(404, "unknown state chart")
        live.chart = body.chart
        return live.status(10**12)


@app.post("/api/live/reset")
def live_reset() -> dict[str, Any]:
    with _live_lock:
        live = _require_live()
        live.behavior.reset()
        for fsm in live.fsms.values():
            fsm.active_state = fsm.state_chart.start_state
        return live.status(10**12)


@app.get("/api/live/poll")
def live_poll(after: int = 0) -> dict[str, Any]:
    if _live is None:
        return {"running": False}
    return {"running": True, **_live.status(after)}


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(HERE / "static" / "index.html")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
