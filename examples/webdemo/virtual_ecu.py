# SPDX-License-Identifier: MIT
"""A behavioral model of the "somersault" ECU which speaks UDS over
ISO-TP on an in-process python-can virtual bus.

All telegrams are decoded and encoded by odxtools using the ODX
database; only the *behavior* (dizziness, temperature, ...) is
modeled here.
"""
import secrets
import threading
import time
from collections.abc import Callable
from typing import Any

import can
import isotp

import odxtools.uds as uds
from odxtools.diaglayers.diaglayer import DiagLayer
from odxtools.exceptions import DecodeError, EncodeError
from odxtools.response import Response


def _nrc(sid: int, code: uds.NegativeResponseCodes) -> bytes:
    return bytes([uds.NegativeResponseId, sid, int(code)])


#####
# UDS 0x27 SecurityAccess (demo PDX extension, somersault_security.pdx)
#####

DEMO_KEY_XOR = 0x5A5A5A5A
DEMO_KEY_ROTATE = 3


def demo_security_key(seed: bytes) -> bytes:
    """MODELED demo algorithm, not a real OEM algorithm:
    ``key = rotl32(seed ^ 0x5A5A5A5A, 3)``"""
    x = int.from_bytes(seed, "big") ^ DEMO_KEY_XOR
    x = ((x << DEMO_KEY_ROTATE) | (x >> (32 - DEMO_KEY_ROTATE))) & 0xFFFFFFFF
    return x.to_bytes(4, "big")


class SomersaultBehavior:
    """Physical state of the acrobat behind the somersault ECU."""

    SOBERNESS_LIMIT = 0x20
    DIZZY_LIMIT = 180
    HOT_LIMIT = 65
    MAX_FLIPS_PER_REQUEST = 10

    def __init__(self, variant: DiagLayer) -> None:
        self.variant = variant
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
        self._security_reset()

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
            **self._security_snapshot(),
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

        if self.temperature > self.HOT_LIMIT and name not in ("tester_present", "report_status",
                                                              "session_stop"):
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
        self._security_relock()
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
            return self._raw_nrc_flips(service, raw_req, 0, 0)

        done = 0
        stumbled = False
        for _ in range(n):
            if self.dizziness >= self.DIZZY_LIMIT:
                return self._raw_nrc_flips(service, raw_req, 1, done)
            if done >= self.MAX_FLIPS_PER_REQUEST:
                stumbled = True
                break
            done += 1
            self.total_flips += 1
            self.dizziness += 14 if direction == "forward" else 20
            self.temperature += 2.5 if not self.fire_ring else 4.0
            self.happiness = max(0.0, self.happiness - 3)
        if stumbled:
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

    #####
    # UDS 0x27 SecurityAccess (demo PDX extension)
    #####

    SECURITY_MAX_ATTEMPTS = 3
    SECURITY_DELAY_S = 10.0

    @property
    def has_security_access(self) -> bool:
        return "security_send_key" in {s.short_name for s in self.variant.services}

    def _security_reset(self) -> None:
        self.locked = True
        self.seed: bytes | None = None
        self.attempts = 0
        self.delay_until = 0.0

    def _security_relock(self) -> None:
        # a session change locks the ECU again; failed attempts and a
        # running delay are kept so they can't be circumvented this way
        self.locked = True
        self.seed = None

    def _security_delay_remaining(self) -> float:
        remaining = max(0.0, self.delay_until - self._t)
        if remaining == 0.0 and self.delay_until:
            # the modeled delay ran out: the tester gets a fresh set of attempts
            self.delay_until = 0.0
            self.attempts = 0
        return remaining

    def _security_snapshot(self) -> dict[str, Any]:
        if not self.has_security_access:
            return {}
        remaining = self._security_delay_remaining()
        return {
            "locked": self.locked,
            "attempts": self.attempts,
            "max_attempts": self.SECURITY_MAX_ATTEMPTS,
            "delay_remaining": round(remaining, 2),
            "delay_total": self.SECURITY_DELAY_S,
            "seed_pending": self.seed is not None,
        }

    def _security_nrc(self, service: Any, raw_req: bytes, code: uds.NegativeResponseCodes) -> bytes:
        resp: Response = service.negative_responses[code.name]
        return bytes(resp.encode(raw_req))

    def _on_security_request_seed(self, service: Any, raw_req: bytes, params: dict[str,
                                                                                   Any]) -> bytes:
        if self._security_delay_remaining() > 0:
            return self._security_nrc(service, raw_req,
                                      uds.NegativeResponseCodes.RequiredTimeDelayNotExpired)
        if not self.locked:
            # ISO 14229-1: an unlocked ECU answers with an all-zero seed
            return self._pos(service, raw_req, security_seed=bytes(4))
        self.seed = secrets.token_bytes(4)
        while self.seed == bytes(4):
            self.seed = secrets.token_bytes(4)
        return self._pos(service, raw_req, security_seed=self.seed)

    def _on_security_send_key(self, service: Any, raw_req: bytes, params: dict[str, Any]) -> bytes:
        nrc = uds.NegativeResponseCodes
        if self._security_delay_remaining() > 0:
            return self._security_nrc(service, raw_req, nrc.RequiredTimeDelayNotExpired)
        if self.seed is None:
            return self._security_nrc(service, raw_req, nrc.RequestSequenceError)
        if bytes(params.get("security_key", b"")) == demo_security_key(self.seed):
            self.locked = False
            self.seed = None
            self.attempts = 0
            return self._pos(service, raw_req)
        self.attempts += 1
        if self.attempts >= self.SECURITY_MAX_ATTEMPTS:
            self.seed = None
            self.delay_until = self._t + self.SECURITY_DELAY_S
            return self._security_nrc(service, raw_req, nrc.ExceededNumberOfAttempts)
        return self._security_nrc(service, raw_req, nrc.InvalidKey)


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
