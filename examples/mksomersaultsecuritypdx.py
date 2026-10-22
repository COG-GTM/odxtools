#! /usr/bin/python3
#
# SPDX-License-Identifier: MIT
#
# Demo-only extension of the "somersault" ECU: adds UDS 0x27
# SecurityAccess (seed & key) services and a "security_chart" ODX
# STATE-CHART which gates the "headstand" service of the assiduous
# variant. The key algorithm used by the accompanying virtual ECU
# (examples/webdemo/virtual_ecu.py) is a demo algorithm, not a real
# OEM algorithm.
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

PROTECTED_SERVICE = "headstand"
SECURITY_LEVEL = 1
REQUEST_SEED = 2 * SECURITY_LEVEL - 1  # 0x01
SEND_KEY = 2 * SECURITY_LEVEL  # 0x02
SEED_LEN = 4

doc_frags = somersaultecu.doc_frags
uint8 = somersaultecu.somersault_diagcodedtypes["uint8"]

database: Database = deepcopy(somersaultecu.database)
dlc = database.diag_layer_containers[0]
base_raw = dlc.base_variants.somersault_base_variant.diag_layer_raw
assiduous_raw = dlc.ecu_variants.somersault_assiduous.diag_layer_raw


def _sid(value: int, name: str = "sid", pos: int = 0) -> CodedConstParameter:
    return CodedConstParameter(
        short_name=name, diag_coded_type=uint8, byte_position=pos, coded_value_raw=str(int(value)))


def _id(name: str) -> OdxLinkId:
    return OdxLinkId(f"somersault_assiduous.security.{name}", doc_frags)


# 4 byte seed/key, transported as a byte field
bytes4 = DataObjectProperty(
    odx_id=_id("DOP.bytes4"),
    short_name="security_bytes4",
    long_name="4 byte security access seed or key",
    diag_coded_type=StandardLengthType(
        base_data_type=DataType.A_BYTEFIELD, bit_length=8 * SEED_LEN),
    physical_type=PhysicalType(base_data_type=DataType.A_BYTEFIELD),
    compu_method=IdenticalCompuMethod(
        category=CompuCategory.IDENTICAL,
        internal_type=DataType.A_BYTEFIELD,
        physical_type=DataType.A_BYTEFIELD),
)
assert assiduous_raw.diag_data_dictionary_spec is not None
assiduous_raw.diag_data_dictionary_spec.data_object_props.append(bytes4)

requests = {
    "request_seed":
        Request(
            odx_id=_id("RQ.request_seed"),
            short_name="security_request_seed_rq",
            long_name=f"SecurityAccess requestSeed (level {SECURITY_LEVEL})",
            parameters=NamedItemList([
                _sid(uds.UDSSID.SecurityAccess),
                _sid(REQUEST_SEED, "security_access_type", 1),
            ]),
        ),
    "send_key":
        Request(
            odx_id=_id("RQ.send_key"),
            short_name="security_send_key_rq",
            long_name=f"SecurityAccess sendKey (level {SECURITY_LEVEL})",
            parameters=NamedItemList([
                _sid(uds.UDSSID.SecurityAccess),
                _sid(SEND_KEY, "security_access_type", 1),
                ValueParameter(
                    short_name="security_key",
                    byte_position=2,
                    dop_ref=OdxLinkRef.from_id(bytes4.odx_id)),
            ]),
        ),
}

positive_responses = {
    "seed":
        Response(
            odx_id=_id("PR.seed"),
            short_name="security_seed",
            response_type=ResponseType.POSITIVE,
            parameters=NamedItemList([
                _sid(uds.positive_response_id(uds.UDSSID.SecurityAccess)),
                _sid(REQUEST_SEED, "security_access_type", 1),
                ValueParameter(
                    short_name="security_seed",
                    byte_position=2,
                    dop_ref=OdxLinkRef.from_id(bytes4.odx_id)),
            ]),
        ),
    "key_accepted":
        Response(
            odx_id=_id("PR.key_accepted"),
            short_name="security_key_accepted",
            response_type=ResponseType.POSITIVE,
            parameters=NamedItemList([
                _sid(uds.positive_response_id(uds.UDSSID.SecurityAccess)),
                _sid(SEND_KEY, "security_access_type", 1),
            ]),
        ),
}

# one NEG-RESPONSE per NRC, the NRC is a CODED-CONST so that
# odxtools can tell them apart
NRCS = {
    "invalid_key": uds.NegativeResponseCodes.InvalidKey,
    "exceeded_number_of_attempts": uds.NegativeResponseCodes.ExceededNumberOfAttempts,
    "required_time_delay_not_expired": uds.NegativeResponseCodes.RequiredTimeDelayNotExpired,
    # sendKey without a preceding requestSeed
    "request_sequence_error": uds.NegativeResponseCodes.RequestSequenceError,
}
negative_responses = {
    name:
        Response(
            odx_id=_id(f"NR.{name}"),
            short_name=f"security_{name}",
            long_name=f"NRC 0x{int(code):02X} {code.name}",
            response_type=ResponseType.NEGATIVE,
            parameters=NamedItemList([
                _sid(uds.NegativeResponseId),
                _sid(uds.UDSSID.SecurityAccess, "rq_sid", 1),
                _sid(int(code), "response_code", 2),
            ]),
        )
    for name, code in NRCS.items()
}

# the state chart which tracks the security access level of the ECU
chart = StateChart(
    semantic="SECURITY",
    odx_id=_id("chart"),
    short_name="security_chart",
    long_name=f"SecurityAccess level {SECURITY_LEVEL}",
    description=Description.from_string(
        "<p>Demo PDX extension: UDS 0x27 SecurityAccess lock state</p>"),
    states=NamedItemList([
        State(odx_id=_id("states.locked"), short_name="locked"),
        State(odx_id=_id("states.unlocked"), short_name="unlocked"),
    ]),
    start_state_snref="locked",
    state_transitions=[
        StateTransition(
            odx_id=_id("transitions.unlock"),
            short_name="unlock",
            source_snref="locked",
            target_snref="unlocked"),
        StateTransition(
            odx_id=_id("transitions.relock"),
            short_name="relock",
            source_snref="unlocked",
            target_snref="locked"),
    ],
)
assiduous_raw.state_charts.append(chart)


def _state_ref(name: str) -> PreConditionStateRef:
    return PreConditionStateRef(ref_id=_id(f"states.{name}").local_id, ref_docs=doc_frags)


def _transition_ref(name: str) -> StateTransitionRef:
    return StateTransitionRef(ref_id=_id(f"transitions.{name}").local_id, ref_docs=doc_frags)


nr_refs = [OdxLinkRef.from_id(r.odx_id) for r in negative_responses.values()]
services = {
    "request_seed":
        DiagService(
            odx_id=_id("service.request_seed"),
            short_name="security_request_seed",
            long_name="SecurityAccess: request seed",
            semantic="SECURITY",
            request_ref=OdxLinkRef.from_id(requests["request_seed"].odx_id),
            pos_response_refs=[OdxLinkRef.from_id(positive_responses["seed"].odx_id)],
            neg_response_refs=nr_refs,
        ),
    "send_key":
        DiagService(
            odx_id=_id("service.send_key"),
            short_name="security_send_key",
            long_name="SecurityAccess: send key",
            semantic="SECURITY",
            request_ref=OdxLinkRef.from_id(requests["send_key"].odx_id),
            pos_response_refs=[OdxLinkRef.from_id(positive_responses["key_accepted"].odx_id)],
            neg_response_refs=nr_refs,
            state_transition_refs=[_transition_ref("unlock")],
        ),
}

assiduous_raw.requests.extend(requests.values())
assiduous_raw.positive_responses.extend(positive_responses.values())
assiduous_raw.negative_responses.extend(negative_responses.values())
assiduous_raw.diag_comms_raw.extend(services.values())

# the protected service may only be executed while unlocked
protected = next(
    s for s in assiduous_raw.diag_comms_raw
    if isinstance(s, DiagService) and s.short_name == PROTECTED_SERVICE)
protected.pre_condition_state_refs.append(_state_ref("unlocked"))

# ending the session re-locks the ECU
session_stop = next(
    s for s in base_raw.diag_comms_raw
    if isinstance(s, DiagService) and s.short_name == "session_stop")
session_stop.state_transition_refs.append(_transition_ref("relock"))

# odxtools' StateMachine requires one PRE-CONDITION-STATE-REF to apply
# to the active state chart, so starting a session stays possible
# regardless of the security level
session_start = next(
    s for s in base_raw.diag_comms_raw
    if isinstance(s, DiagService) and s.short_name == "session_start")
session_start.pre_condition_state_refs.extend([_state_ref("locked"), _state_ref("unlocked")])

database.refresh()

if __name__ == "__main__":
    argparser = argparse.ArgumentParser(
        description="\n".join([
            "Creates a demo-only PDX file for a 'somersault' ECU with UDS 0x27 SecurityAccess.",
            "",
            "The seed/key services and the 'security_chart' STATE-CHART are a demo",
            "extension used by the ODX Diagnostic Workbench (examples/webdemo).",
        ]),
        formatter_class=argparse.RawTextHelpFormatter,
    )
    argparser.add_argument(
        "output_pdx_file",
        metavar="OUTPUT_PDX_FILE",
        help="Path where the resulting .pdx file is written",
    )
    args = argparser.parse_args()
    odxtools.write_pdx_file(args.output_pdx_file, database)
