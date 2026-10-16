# SPDX-License-Identifier: MIT
"""A behavioral model of the "somersault" ECU which speaks UDS over
ISO-TP on an in-process python-can virtual bus.

All telegrams are decoded and encoded by odxtools using the ODX
database; only the *behavior* (dizziness, temperature, ...) is
modeled here.
"""
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
    # ISO 14229 status bits which this ECU supports (DTCStatusAvailabilityMask)
    STATUS_AVAILABILITY_MASK = 0xFF
    # testFailed | pendingDTC | confirmedDTC
    STORED_STATUS = 0x01 | 0x04 | 0x08
    SNAPSHOT_RECORD = 0x01
    # fault memory services which are answered even if the ECU is too hot
    ALWAYS_ALLOWED = ("tester_present", "report_status", "session_stop", "read_dtc_by_status_mask",
                      "read_dtc_snapshot", "clear_dtcs")
    # ODX DTC short names of the modeled fault triggers
    DTC_OVERHEATED = "acrobat_overheated"
    DTC_DIZZY = "flip_aborted_dizzy"
    DTC_FIRE_RING = "fire_ring_malfunction"

    def __init__(self, variant: DiagLayer) -> None:
        self.variant = variant
        self.connected_at = time.monotonic()
        self.dtcs: dict[str, DiagnosticTroubleCode] = {
            dtc.short_name: dtc
            for dop in variant.diag_data_dictionary_spec.dtc_dops
            for dtc in dop.dtcs
        }
        self.reset()

    @property
    def has_fault_memory(self) -> bool:
        return bool(self.dtcs)

    def reset(self) -> None:
        self.rest()
        self.fire_ring = False
        self.total_flips = 0
        # trouble code -> {status, snapshot, occurrences, ...}
        self.fault_memory: dict[int, dict[str, Any]] = {}
        self.fault_events: list[dict[str, Any]] = []

    def rest(self) -> None:
        """Let the acrobat recover (temperature, dizziness, happiness)
        without touching the fault memory."""
        self.session_active = False
        self.dizziness = 0.0
        self.happiness = 120.0
        self.temperature = 36.0
        self.last_flip: tuple[str, dict[str, Any]] = ("none", {})
        self._t = time.monotonic()

    def _now(self) -> float:
        return time.monotonic() - self.connected_at

    def store_fault(self, dtc_name: str, trigger: str) -> None:
        """Store (or update) a DTC together with snapshot record 0x01."""
        dtc = self.dtcs.get(dtc_name)
        if dtc is None:
            return
        now = self._now()
        snapshot = {
            "temperature": int(min(255, round(self.temperature))),
            "dizziness": int(min(100, round(self.dizziness * 100 / 255))),
            "total_flips": min(0xFFFF, self.total_flips),
            "timestamp": min(0xFFFF, int(now)),
        }
        entry = self.fault_memory.get(dtc.trouble_code)
        kind = "updated" if entry is not None else "stored"
        if entry is None:
            entry = self.fault_memory[dtc.trouble_code] = {"occurrences": 0, "first_seen": now}
        entry.update(
            status=self.STORED_STATUS,
            snapshot=snapshot,
            occurrences=entry["occurrences"] + 1,
            last_seen=now,
            trigger=trigger)
        self.fault_events.append({
            "t": round(now, 2),
            "kind": kind,
            "trouble_code": dtc.trouble_code,
            "dtc": dtc.short_name,
            "text": dtc.text.text if dtc.text is not None else None,
            "trigger": trigger,
            "occurrences": entry["occurrences"],
        })
        del self.fault_events[:-200]

    def tick(self) -> None:
        now = time.monotonic()
        dt = now - self._t
        self._t = now
        self.dizziness = max(0.0, self.dizziness - 3.0 * dt)
        self.temperature = max(36.0, self.temperature - 0.5 * dt)

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
            "fault_memory": {
                "supported": self.has_fault_memory,
                "stored": len(self.fault_memory),
                "events": list(self.fault_events),
                "uptime": round(self._now(), 2),
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

        if self.temperature > self.HOT_LIMIT and name not in self.ALWAYS_ALLOWED:
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
            return self._failed_flips(service, raw_req, 0, 0, "no diagnostic session")
        soberness = int(params.get(f"{direction}_soberness_check", 0))
        n = int(params.get("num_flips", 0))
        if soberness >= self.SOBERNESS_LIMIT:
            return self._failed_flips(
                service, raw_req, 0, 0,
                f"soberness check 0x{soberness:02x} ≥ 0x{self.SOBERNESS_LIMIT:02x}")

        done = 0
        stumbled = False
        for _ in range(n):
            if self.dizziness >= self.DIZZY_LIMIT:
                trigger = f"dizziness {self.dizziness:.0f} ≥ {self.DIZZY_LIMIT} limit"
                self.store_fault(self.DTC_DIZZY, f"{direction} flip refused: {trigger}")
                return self._failed_flips(service, raw_req, 1, done, trigger)
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
                    self.DTC_OVERHEATED, f"temperature {self.temperature:.0f} °C > "
                    f"{self.HOT_LIMIT} °C limit after flip {self.total_flips}")
        if stumbled:
            return self._failed_flips(service, raw_req, 2, done,
                                      f"more than {self.MAX_FLIPS_PER_REQUEST} flips requested")

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

    def _failed_flips(self, service: Any, raw_req: bytes, reason: int, done: int,
                      why: str) -> bytes:
        if self.fire_ring:
            self.store_fault(self.DTC_FIRE_RING, f"flip through the fire ring failed: {why}")
        return self._raw_nrc_flips(service, raw_req, reason, done)

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
        """Expand a status byte into the bit parameters of the ODX
        status structure."""
        struct = self.variant.diag_data_dictionary_spec.structures.dtc_status
        return {p.short_name: (status >> (p.bit_position or 0)) & 1 for p in struct.parameters}

    def _on_read_dtc_by_status_mask(self, service: Any, raw_req: bytes, params: dict[str,
                                                                                     Any]) -> bytes:
        mask = int(params.get("status_mask", 0))
        records = [{
            "dtc": code,
            "status": self._status_bits(entry["status"])
        } for code, entry in sorted(self.fault_memory.items()) if entry["status"] & mask]
        return self._pos(
            service,
            raw_req,
            status_availability_mask=self.STATUS_AVAILABILITY_MASK,
            dtc_records=records)

    def _on_read_dtc_snapshot(self, service: Any, raw_req: bytes, params: dict[str, Any]) -> bytes:
        dtc = params.get("dtc")
        code = getattr(dtc, "trouble_code", dtc)
        entry = self.fault_memory.get(code) if isinstance(code, int) else None
        if entry is None or params.get("record_number") != self.SNAPSHOT_RECORD:
            return self._general_nrc(service, raw_req, uds.NegativeResponseCodes.RequestOutOfRange)
        return self._pos(
            service,
            raw_req,
            dtc=code,
            status=self._status_bits(entry["status"]),
            record_number=self.SNAPSHOT_RECORD,
            snapshot=entry["snapshot"])

    def _on_clear_dtcs(self, service: Any, raw_req: bytes, params: dict[str, Any]) -> bytes:
        cleared = len(self.fault_memory)
        self.fault_memory.clear()
        self.fault_events.append({
            "t": round(self._now(), 2),
            "kind": "cleared",
            "trouble_code": None,
            "dtc": None,
            "text": None,
            "trigger": f"ClearDiagnosticInformation: {cleared} DTC(s) erased",
            "occurrences": 0,
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
