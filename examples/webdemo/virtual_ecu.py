# SPDX-License-Identifier: MIT
"""A behavioral model of the "somersault" ECU which speaks UDS over
ISO-TP on an in-process python-can virtual bus.

All telegrams are decoded and encoded by odxtools using the ODX
database; only the *behavior* (dizziness, temperature, ...) is
modeled here.
"""
import math
import threading
import time
from collections.abc import Callable
from typing import Any

import can
import isotp

import odxtools.uds as uds
from odxtools.diaglayers.diaglayer import DiagLayer
from odxtools.diagnostictroublecode import DiagnosticTroubleCode
from odxtools.exceptions import DecodeError, EncodeError
from odxtools.response import Response


def _nrc(sid: int, code: uds.NegativeResponseCodes) -> bytes:
    return bytes([uds.NegativeResponseId, sid, int(code)])


class SomersaultBehavior:
    """Physical state of the acrobat behind the somersault ECU."""

    SOBERNESS_LIMIT = 0x20
    DIZZY_LIMIT = 180
    HOT_LIMIT = 65
    MAX_FLIPS_PER_REQUEST = 10

    # services which the ECU still answers while it is too hot
    ALWAYS_AVAILABLE = ("tester_present", "report_status", "session_stop",
                        "read_dtc_by_status_mask", "read_dtc_snapshot", "clear_dtcs")

    # ISO 14229-1 statusOfDTC bits which are maintained by the model
    TEST_FAILED = 0x01
    PENDING_DTC = 0x04
    CONFIRMED_DTC = 0x08
    STATUS_AVAILABILITY_MASK = 0xFF
    SNAPSHOT_RECORD = 0x01

    # the DTCs (by short name) which are stored for the modeled fault events
    FAULT_DTCS = {
        "overheat": "acrobat_overheated",
        "dizzy": "flip_aborted_dizzy",
        "fire_ring": "fire_ring_malfunction",
    }

    def __init__(self, variant: DiagLayer) -> None:
        self.variant = variant
        self.connected_at = time.monotonic()
        # the trouble codes come from the ODX DTC-DOPs of the variant, if
        # there are any: without them, the ECU has no fault memory
        self.dtcs: dict[str, DiagnosticTroubleCode] = {}
        ddds = variant.diag_data_dictionary_spec
        for dtc_dop in ddds.dtc_dops:
            for dtc in dtc_dop.dtcs:
                self.dtcs.setdefault(dtc.short_name, dtc)
        self.reset()

    def reset(self) -> None:
        self.session_active = False
        self.dizziness = 0.0
        self.happiness = 120.0
        self.temperature = 36.0
        self.fire_ring = False
        self.total_flips = 0
        self.last_flip: tuple[str, dict[str, Any]] = ("none", {})
        self._t = time.monotonic()
        # trouble_code -> {"status", "snapshot", "occurrences", ...}
        self.fault_memory: dict[int, dict[str, Any]] = {}
        self.fault_events: list[dict[str, Any]] = []

    @property
    def has_fault_memory(self) -> bool:
        return all(name in self.dtcs for name in self.FAULT_DTCS.values())

    def uptime(self) -> float:
        return time.monotonic() - self.connected_at

    def _freeze_frame(self) -> dict[str, Any]:
        # dizziness is reported in percent of its 8 bit scale; the
        # value is quantized so that it encodes to an exact raw value
        raw_dizziness = int(min(255, round(self.dizziness)))
        return {
            "temperature": math.ceil(min(255.0, self.temperature)),
            "dizziness": raw_dizziness * 100 / 255,
            "total_flips": min(0xFFFF, self.total_flips),
            "timestamp": int(min(0xFFFF, self.uptime())),
        }

    def store_fault(self, fault: str, trigger: str) -> None:
        """Record a modeled fault event in the fault memory."""
        if not self.has_fault_memory:
            return
        code = self.dtcs[self.FAULT_DTCS[fault]].trouble_code
        entry = self.fault_memory.get(code)
        if entry is None:
            entry = self.fault_memory[code] = {
                "status": self.TEST_FAILED | self.PENDING_DTC,
                "occurrences": 0,
                "snapshot": self._freeze_frame(),
                "first_t": round(self.uptime(), 2),
            }
            kind = "stored"
        else:
            # a fault which re-occurs is confirmed (modeled debouncing)
            entry["status"] |= self.TEST_FAILED | self.PENDING_DTC | self.CONFIRMED_DTC
            entry["snapshot"] = self._freeze_frame()
            kind = "updated"
        entry["occurrences"] += 1
        entry["last_t"] = round(self.uptime(), 2)
        entry["trigger"] = trigger
        self.fault_events.append({
            "t": entry["last_t"],
            "code": code,
            "kind": kind,
            "fault": fault,
            "trigger": trigger,
            "status": entry["status"],
            "occurrences": entry["occurrences"],
        })

    def tick(self) -> None:
        now = time.monotonic()
        dt = now - self._t
        self._t = now
        self.dizziness = max(0.0, self.dizziness - 3.0 * dt)
        self.temperature = max(36.0, self.temperature - 0.5 * dt)
        overheat = self.dtcs.get(self.FAULT_DTCS["overheat"])
        entry = self.fault_memory.get(overheat.trouble_code) if overheat else None
        if entry is not None and self.temperature <= self.HOT_LIMIT:
            # the overheat test passes again once the acrobat cooled down
            entry["status"] &= ~self.TEST_FAILED

    @property
    def can_do_backward_flips(self) -> bool:
        return "do_backward_flips" in {s.short_name for s in self.variant.services}

    def snapshot(self) -> dict[str, Any]:
        self.tick()
        return {
            "session_active": self.session_active,
            "dizziness": round(self.dizziness, 1),
            "happiness": round(self.happiness, 1),
            "temperature": round(self.temperature, 1),
            "fire_ring": self.fire_ring,
            "total_flips": self.total_flips,
            "limits": {
                "dizziness": self.DIZZY_LIMIT,
                "temperature": self.HOT_LIMIT,
            },
            "uptime": round(self.uptime(), 2),
            "fault_memory": {
                "supported": self.has_fault_memory,
                "stored": len(self.fault_memory),
                "occurrences": {
                    str(k): v["occurrences"]
                    for k, v in self.fault_memory.items()
                },
                "events": list(self.fault_events),
            },
        }

    def handle(self, raw_req: bytes) -> bytes:
        """Return the raw response to a raw request."""
        self.tick()
        if not raw_req:
            return b""
        sid = raw_req[0]

        try:
            msgs = self.variant.decode(raw_req)
        except DecodeError:
            msgs = []
        if not msgs:
            # the request is not specified by this ECU variant's ODX
            known = any(
                s.request is not None and bytes(s.request.coded_const_prefix())[:1] == bytes([sid])
                for s in self.variant.services)
            code = (
                uds.NegativeResponseCodes.InvalidFormat
                if known else uds.NegativeResponseCodes.ServiceNotSupported)
            return _nrc(sid, code)

        msg = msgs[0]
        service = msg.service
        params = msg.param_dict
        name = service.short_name

        if self.temperature > self.HOT_LIMIT and name not in self.ALWAYS_AVAILABLE:
            gnr = self.variant.global_negative_responses.too_hot
            return bytes(gnr.encode(temperature=int(self.temperature)))

        handler: Callable[[Any, bytes, dict[str, Any]], bytes] | None = getattr(
            self, f"_on_{name}", None)
        if handler is None:
            return _nrc(sid, uds.NegativeResponseCodes.ServiceNotSupported)
        try:
            return handler(service, raw_req, params)
        except EncodeError:
            return _nrc(sid, uds.NegativeResponseCodes.GeneralReject)

    def _pos(self, service: Any, raw_req: bytes, **kwargs: Any) -> bytes:
        return bytes(service.encode_positive_response(raw_req, **kwargs))

    def _general_nrc(self, service: Any, raw_req: bytes, code: int) -> bytes:
        resp: Response = service.negative_responses.general_negative_response
        return bytes(resp.encode(raw_req, response_code=code))

    def _on_session_start(self, service: Any, raw_req: bytes, params: dict[str, Any]) -> bytes:
        bribe = int(params.get("bribe", 0))
        self.session_active = True
        self.happiness = min(255.0, self.happiness + 25 * bribe)
        return self._pos(
            service,
            raw_req,
            can_do_backward_flips="true" if self.can_do_backward_flips else "false")

    def _on_session_stop(self, service: Any, raw_req: bytes, params: dict[str, Any]) -> bytes:
        self.session_active = False
        return self._pos(
            service,
            raw_req,
            can_do_backward_flips="true" if self.can_do_backward_flips else "false")

    def _on_tester_present(self, service: Any, raw_req: bytes, params: dict[str, Any]) -> bytes:
        return self._pos(service, raw_req, status=0)

    def _on_set_operation_params(self, service: Any, raw_req: bytes, params: dict[str,
                                                                                  Any]) -> bytes:
        self.fire_ring = params.get("use_fire_ring") == "true"
        return self._pos(service, raw_req)

    def _flips(self, service: Any, raw_req: bytes, params: dict[str, Any], direction: str) -> bytes:
        if not self.session_active:
            return self._raw_nrc_flips(service, raw_req, 0, 0)
        soberness = int(params.get(f"{direction}_soberness_check", 0))
        n = int(params.get("num_flips", 0))
        if soberness >= self.SOBERNESS_LIMIT:
            if self.fire_ring:
                self.store_fault(
                    "fire_ring", f"{direction} flip through the fire ring refused: soberness "
                    f"check 0x{soberness:02X} ≥ 0x{self.SOBERNESS_LIMIT:02X}")
            return self._raw_nrc_flips(service, raw_req, 0, 0)

        done = 0
        stumbled = False
        for _ in range(n):
            if self.dizziness >= self.DIZZY_LIMIT:
                self.store_fault(
                    "dizzy", f"dizziness {self.dizziness:.0f} ≥ {self.DIZZY_LIMIT} limit: "
                    f"flip {done + 1} of {n} refused")
                if self.fire_ring:
                    self.store_fault(
                        "fire_ring", f"{direction} flip {done + 1} through the fire ring "
                        f"aborted (too dizzy)")
                return self._raw_nrc_flips(service, raw_req, 1, done)
            if done >= self.MAX_FLIPS_PER_REQUEST:
                stumbled = True
                break
            done += 1
            self.total_flips += 1
            self.dizziness += 14 if direction == "forward" else 20
            was_hot = self.temperature > self.HOT_LIMIT
            self.temperature += 2.5 if not self.fire_ring else 4.0
            self.happiness = max(0.0, self.happiness - 3)
            if not was_hot and self.temperature > self.HOT_LIMIT:
                self.store_fault(
                    "overheat",
                    f"temperature {math.ceil(self.temperature)} °C > {self.HOT_LIMIT} °C limit")
        if stumbled:
            if self.fire_ring:
                self.store_fault(
                    "fire_ring", f"stumbled through the fire ring after {done} of {n} "
                    f"{direction} flips (max {self.MAX_FLIPS_PER_REQUEST})")
            return self._raw_nrc_flips(service, raw_req, 2, done)

        sault_time = min(255, done * (3 if direction == "forward" else 5))
        if direction == "forward":
            self.last_flip = ("none", {})
            return self._pos(service, raw_req, sault_time=sault_time)
        self.last_flip = ("backward_grudging", {
            "num_flips_done": done,
            "grumpiness_level": min(255, int(255 - self.happiness))
        })
        return self._pos(
            service,
            raw_req,
            num_flips_done=done,
            grumpiness_level=min(255, int(255 - self.happiness)))

    def _raw_nrc_flips(self, service: Any, raw_req: bytes, reason: int, done: int) -> bytes:
        resp = service.negative_responses.flips_not_done
        # odxtools always encodes the first value of NRC-CONST
        # parameters, so the reason is patched in afterwards
        pdu = bytearray(resp.encode(raw_req, flips_successfully_done=done))
        reason_param = resp.parameters.reason
        if reason_param.byte_position is not None:
            pdu[reason_param.byte_position] = reason
        return bytes(pdu)

    def _on_do_forward_flips(self, service: Any, raw_req: bytes, params: dict[str, Any]) -> bytes:
        return self._flips(service, raw_req, params, "forward")

    def _on_do_backward_flips(self, service: Any, raw_req: bytes, params: dict[str, Any]) -> bytes:
        return self._flips(service, raw_req, params, "backward")

    def _on_report_status(self, service: Any, raw_req: bytes, params: dict[str, Any]) -> bytes:
        key, struct = self.last_flip
        if key == "none":
            last: Any = ("none", int(min(255, self.dizziness)) // 8)
        else:
            last = (key, struct)
        return self._pos(
            service,
            raw_req,
            dizzyness_level=int(min(255, self.dizziness)),
            happiness_level=int(min(255, self.happiness)),
            last_pos_response=last)

    def _on_headstand(self, service: Any, raw_req: bytes, params: dict[str, Any]) -> bytes:
        duration = int(params.get("duration", 0))
        if self.dizziness > self.DIZZY_LIMIT / 2:
            resp = service.negative_responses.fell_over
            return bytes(resp.encode(raw_req))
        self.dizziness += duration / 2
        return self._pos(service, raw_req)

    def _status_bits(self, status: int) -> dict[str, int]:
        dtc_and_status = self.variant.diag_data_dictionary_spec.structures.dtc_status
        return {
            p.short_name: (status >> (p.bit_position or 0)) & 1
            for p in dtc_and_status.parameters
        }

    def _on_read_dtc_by_status_mask(self, service: Any, raw_req: bytes, params: dict[str,
                                                                                     Any]) -> bytes:
        mask = int(params.get("status_mask", self.STATUS_AVAILABILITY_MASK))
        records = [{
            "dtc": code,
            "status": self._status_bits(entry["status"])
        } for code, entry in sorted(self.fault_memory.items()) if entry["status"] & mask]
        return self._pos(
            service, raw_req, status_availability_mask=self.STATUS_AVAILABILITY_MASK, dtcs=records)

    def _on_read_dtc_snapshot(self, service: Any, raw_req: bytes, params: dict[str, Any]) -> bytes:
        dtc = params.get("dtc")
        code = dtc.trouble_code if isinstance(dtc, DiagnosticTroubleCode) else None
        entry = self.fault_memory.get(code) if code is not None else None
        if entry is None or int(params.get("record_number", 0)) != self.SNAPSHOT_RECORD:
            return self._general_nrc(service, raw_req,
                                     int(uds.NegativeResponseCodes.RequestOutOfRange))
        return self._pos(
            service,
            raw_req,
            dtc=code,
            status=self._status_bits(entry["status"]),
            record_number=self.SNAPSHOT_RECORD,
            snapshot=entry["snapshot"])

    def _on_clear_dtcs(self, service: Any, raw_req: bytes, params: dict[str, Any]) -> bytes:
        cleared = sorted(self.fault_memory)
        self.fault_memory.clear()
        self.fault_events.append({
            "t": round(self.uptime(), 2),
            "code": None,
            "kind": "cleared",
            "fault": None,
            "trigger": f"ClearDiagnosticInformation: {len(cleared)} DTC(s) erased",
            "cleared": cleared,
        })
        return self._pos(service, raw_req)


class CanNetwork:
    """A virtual CAN bus with a tester, the virtual ECU and a passive
    sniffer that records every frame."""

    def __init__(self, ecu_rx_id: int, ecu_tx_id: int, behavior: SomersaultBehavior,
                 on_frame: Callable[[can.Message, str], None], channel: str) -> None:
        self.ecu_rx_id = ecu_rx_id
        self.ecu_tx_id = ecu_tx_id
        self.behavior = behavior
        self.on_frame = on_frame
        self.lock = threading.Lock()
        self.channel = channel

        params = {"stmin": 2, "blocksize": 4, "tx_padding": 0xCC, "rx_flowcontrol_timeout": 1500}
        self._ecu_bus = can.Bus(interface="virtual", channel=channel)
        self._tester_bus = can.Bus(interface="virtual", channel=channel)
        self._sniff_bus = can.Bus(interface="virtual", channel=channel)

        self.ecu_stack = isotp.CanStack(
            self._ecu_bus,
            address=isotp.Address(
                isotp.AddressingMode.Normal_11bits, rxid=ecu_rx_id, txid=ecu_tx_id),
            params=params)
        self.tester_stack = isotp.CanStack(
            self._tester_bus,
            address=isotp.Address(
                isotp.AddressingMode.Normal_11bits, rxid=ecu_tx_id, txid=ecu_rx_id),
            params=params)
        self.ecu_stack.start()
        self.tester_stack.start()

        self._running = True
        self._sniffer = threading.Thread(target=self._sniff, daemon=True)
        self._sniffer.start()
        self._ecu_thread = threading.Thread(target=self._ecu_loop, daemon=True)
        self._ecu_thread.start()

    def _sniff(self) -> None:
        while self._running:
            msg = self._sniff_bus.recv(timeout=0.2)
            if msg is None:
                continue
            node = "ECU" if msg.arbitration_id == self.ecu_tx_id else "Tester"
            self.on_frame(msg, node)

    def _ecu_loop(self) -> None:
        while self._running:
            req = self.ecu_stack.recv(block=True, timeout=0.2)
            if req is None:
                continue
            try:
                resp = self.behavior.handle(bytes(req))
            except Exception:
                # the behavior model does not understand this ECU
                # variant's services: reply with a generalReject
                # instead of silently dying
                resp = bytes([uds.NegativeResponseId, req[0] if req else 0, 0x10])
            if resp:
                self.ecu_stack.send(resp)

    def request(self, payload: bytes, timeout: float = 3.0) -> bytes | None:
        with self.lock:
            while self.tester_stack.available():
                self.tester_stack.recv()
            self.tester_stack.send(payload)
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                resp = self.tester_stack.recv(block=True, timeout=0.1)
                if resp is None:
                    continue
                if uds.is_response_pending(bytes(resp)):
                    continue
                return bytes(resp)
            return None

    def shutdown(self) -> None:
        self._running = False
        self.ecu_stack.stop()
        self.tester_stack.stop()
        self._sniffer.join(1)
        self._ecu_thread.join(1)
        for b in (self._ecu_bus, self._tester_bus, self._sniff_bus):
            b.shutdown()
