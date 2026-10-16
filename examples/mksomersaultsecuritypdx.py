#! /usr/bin/python3
#
# SPDX-License-Identifier: MIT
#
# Derive a demo-only variant of the somersault database which adds UDS
# 0x27 SecurityAccess (seed & key) to the "somersault_assiduous" ECU:
#
# - services "security_request_seed" (27 01) and "security_send_key"
#   (27 02 <key>) including ODX negative responses for invalidKey,
#   exceededNumberOfAttempts and requiredTimeDelayNotExpired
# - a STATE-CHART "security_chart" (locked -> unlocked) whose state
#   is required by the PRE-CONDITION-STATE-REF of the "headstand" service
# - "session_stop" locks the ECU again
#
# The bundled somersault.pdx is left untouched.
import argparse
from copy import deepcopy

import odxtools
import odxtools.uds as uds
from examples import somersaultecu
from odxtools.compumethods.compucategory import CompuCategory
from odxtools.compumethods.identicalcompumethod import IdenticalCompuMethod
from odxtools.database import Database
from odxtools.dataobjectproperty import DataObjectProperty
from odxtools.description import Description
from odxtools.diagservice import DiagService
from odxtools.nameditemlist import NamedItemList
from odxtools.odxlink import OdxLinkId, OdxLinkRef
from odxtools.odxtypes import DataType
from odxtools.parameters.codedconstparameter import CodedConstParameter
from odxtools.parameters.valueparameter import ValueParameter
from odxtools.physicaltype import PhysicalType
from odxtools.preconditionstateref import PreConditionStateRef
from odxtools.request import Request
from odxtools.response import Response, ResponseType
from odxtools.standardlengthtype import StandardLengthType
from odxtools.state import State
from odxtools.statechart import StateChart
from odxtools.statetransition import StateTransition
from odxtools.statetransitionref import StateTransitionRef

SECURITY_ACCESS = int(uds.SID.SecurityAccess.value)  # type: ignore[attr-defined]
SECURITY_LEVEL = 1
REQUEST_SEED = 2 * SECURITY_LEVEL - 1
SEND_KEY = 2 * SECURITY_LEVEL
SEED_BYTES = 4

PROTECTED_SERVICE = "headstand"
NEGATIVE_RESPONSE_CODES = (
    uds.NegativeResponseCodes.InvalidKey,
    uds.NegativeResponseCodes.ExceededNumberOfAttempts,
    uds.NegativeResponseCodes.RequiredTimeDelayNotExpired,
    # sendKey without a preceding requestSeed
    uds.NegativeResponseCodes.RequestSequenceError,
)

doc_frags = somersaultecu.doc_frags
uint8 = somersaultecu.somersault_diagcodedtypes["uint8"]


def _const(name: str, pos: int, value: int) -> CodedConstParameter:
    return CodedConstParameter(
        short_name=name, diag_coded_type=uint8, byte_position=pos, coded_value_raw=str(value))


def _find_service(services: list, name: str) -> DiagService:  # type: ignore[type-arg]
    for s in services:
        if isinstance(s, DiagService) and s.short_name == name:
            return s
    raise KeyError(name)


def make_database() -> Database:
    db = deepcopy(somersaultecu.database)
    dlc = db.diag_layer_containers[0]
    base_raw = dlc.base_variants.somersault_base_variant.diag_layer_raw
    ecu_raw = dlc.ecu_variants.somersault_assiduous.diag_layer_raw

    ecu_raw.description = Description.from_string(
        "<p>Hard-working variant of the somersault ECU (lazy &lt; assiduous). "
        "Demo PDX extension: headstands require UDS 0x27 SecurityAccess level 1.</p>")

    bytefield = IdenticalCompuMethod(
        category=CompuCategory.IDENTICAL,
        internal_type=DataType.A_BYTEFIELD,
        physical_type=DataType.A_BYTEFIELD)
    dops = {
        name:
            DataObjectProperty(
                odx_id=OdxLinkId(f"somersault_assiduous.DOP.{name}", doc_frags),
                short_name=name,
                diag_coded_type=StandardLengthType(
                    base_data_type=DataType.A_BYTEFIELD, bit_length=8 * SEED_BYTES),
                physical_type=PhysicalType(base_data_type=DataType.A_BYTEFIELD),
                compu_method=bytefield,
            )
        for name in ("security_seed", "security_key")
    }
    assert ecu_raw.diag_data_dictionary_spec is not None
    ecu_raw.diag_data_dictionary_spec.data_object_props.extend(dops.values())

    rq_seed = Request(
        odx_id=OdxLinkId("somersault_assiduous.RQ.security_request_seed", doc_frags),
        short_name="RQ_security_request_seed",
        parameters=NamedItemList([
            _const("sid", 0, SECURITY_ACCESS),
            _const("security_access_type", 1, REQUEST_SEED),
        ]))
    rq_key = Request(
        odx_id=OdxLinkId("somersault_assiduous.RQ.security_send_key", doc_frags),
        short_name="RQ_security_send_key",
        parameters=NamedItemList([
            _const("sid", 0, SECURITY_ACCESS),
            _const("security_access_type", 1, SEND_KEY),
            ValueParameter(
                short_name="security_key",
                byte_position=2,
                dop_ref=OdxLinkRef.from_id(dops["security_key"].odx_id)),
        ]))
    pr_seed = Response(
        odx_id=OdxLinkId("somersault_assiduous.PR.security_seed", doc_frags),
        short_name="PR_security_seed",
        response_type=ResponseType.POSITIVE,
        parameters=NamedItemList([
            _const("sid", 0, uds.positive_response_id(SECURITY_ACCESS)),
            _const("security_access_type", 1, REQUEST_SEED),
            ValueParameter(
                short_name="security_seed",
                byte_position=2,
                dop_ref=OdxLinkRef.from_id(dops["security_seed"].odx_id)),
        ]))
    pr_key = Response(
        odx_id=OdxLinkId("somersault_assiduous.PR.security_key_accepted", doc_frags),
        short_name="PR_security_key_accepted",
        response_type=ResponseType.POSITIVE,
        parameters=NamedItemList([
            _const("sid", 0, uds.positive_response_id(SECURITY_ACCESS)),
            _const("security_access_type", 1, SEND_KEY),
        ]))
    nrs = [
        Response(
            odx_id=OdxLinkId(f"somersault_assiduous.NR.{code.name}", doc_frags),
            short_name=code.name,
            response_type=ResponseType.NEGATIVE,
            parameters=NamedItemList([
                _const("sid", 0, uds.NegativeResponseId),
                _const("rq_sid", 1, SECURITY_ACCESS),
                _const("response_code", 2, int(code)),
            ])) for code in NEGATIVE_RESPONSE_CODES
    ]
    neg_refs = [OdxLinkRef.from_id(r.odx_id) for r in nrs]

    chart = StateChart(
        odx_id=OdxLinkId("charts.security.chart", doc_frags),
        short_name="security_chart",
        semantic="SECURITY",
        description=Description.from_string(
            "<p>UDS 0x27 SecurityAccess level 1 (demo PDX extension)</p>"),
        states=NamedItemList([
            State(
                odx_id=OdxLinkId("charts.security.states.locked", doc_frags), short_name="locked"),
            State(
                odx_id=OdxLinkId("charts.security.states.unlocked", doc_frags),
                short_name="unlocked"),
        ]),
        start_state_snref="locked",
        state_transitions=[
            StateTransition(
                odx_id=OdxLinkId("charts.security.transitions.unlock", doc_frags),
                short_name="unlock",
                source_snref="locked",
                target_snref="unlocked"),
            StateTransition(
                odx_id=OdxLinkId("charts.security.transitions.relock", doc_frags),
                short_name="relock",
                source_snref="unlocked",
                target_snref="locked"),
        ],
    )

    svc_seed = DiagService(
        odx_id=OdxLinkId("somersault_assiduous.service.security_request_seed", doc_frags),
        short_name="security_request_seed",
        long_name="SecurityAccess requestSeed (level 1)",
        semantic="SECURITY",
        request_ref=OdxLinkRef.from_id(rq_seed.odx_id),
        pos_response_refs=[OdxLinkRef.from_id(pr_seed.odx_id)],
        neg_response_refs=neg_refs,
    )
    svc_key = DiagService(
        odx_id=OdxLinkId("somersault_assiduous.service.security_send_key", doc_frags),
        short_name="security_send_key",
        long_name="SecurityAccess sendKey (level 1)",
        semantic="SECURITY",
        request_ref=OdxLinkRef.from_id(rq_key.odx_id),
        pos_response_refs=[OdxLinkRef.from_id(pr_key.odx_id)],
        neg_response_refs=neg_refs,
        state_transition_refs=[
            StateTransitionRef(ref_id="charts.security.transitions.unlock", ref_docs=doc_frags)
        ],
    )

    ecu_raw.requests.extend([rq_seed, rq_key])
    ecu_raw.positive_responses.extend([pr_seed, pr_key])
    ecu_raw.negative_responses.extend(nrs)
    ecu_raw.diag_comms_raw.extend([svc_seed, svc_key])
    ecu_raw.state_charts.append(chart)

    # the protected service may only be executed once the ECU is unlocked
    protected = _find_service(ecu_raw.diag_comms_raw, PROTECTED_SERVICE)
    protected.pre_condition_state_refs.append(
        PreConditionStateRef(ref_id="charts.security.states.unlocked", ref_docs=doc_frags))

    # session_start stays possible in either security state (pre-condition
    # states are OR-ed), session_stop locks the ECU again
    session_start = _find_service(base_raw.diag_comms_raw, "session_start")
    for state in ("locked", "unlocked"):
        session_start.pre_condition_state_refs.append(
            PreConditionStateRef(ref_id=f"charts.security.states.{state}", ref_docs=doc_frags))
    session_stop = _find_service(base_raw.diag_comms_raw, "session_stop")
    session_stop.state_transition_refs.append(
        StateTransitionRef(ref_id="charts.security.transitions.relock", ref_docs=doc_frags))

    db.refresh()
    return db


if __name__ == "__main__":
    argparser = argparse.ArgumentParser(
        description="Creates a demo-only somersault PDX file which adds UDS 0x27 "
        "SecurityAccess (seed & key) to the somersault_assiduous ECU.")
    argparser.add_argument(
        "output_pdx_file",
        metavar="OUTPUT_PDX_FILE",
        nargs="?",
        default="examples/somersault_security.pdx",
        help="Path where the resulting .pdx file is written")
    args = argparser.parse_args()
    odxtools.write_pdx_file(args.output_pdx_file, make_database())
