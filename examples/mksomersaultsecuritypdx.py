#! /usr/bin/python3
#
# SPDX-License-Identifier: MIT
#
# Creates a demo-only variant of the "somersault" PDX which adds UDS
# SecurityAccess (0x27, seed & key) to the "somersault_assiduous" ECU
# variant. The lock state is modeled as an ODX state chart and the
# "headstand" service may only be executed in the "unlocked" state.
#
# The key algorithm used by the web demo is a demo algorithm
# (rotl32(seed ^ 0x5A5A5A5A, 3)). It is *not* the algorithm of any
# real ECU.
import argparse
from copy import deepcopy
from pathlib import Path

import odxtools
import odxtools.uds as uds
from examples import somersaultecu
from odxtools.compumethods.compucategory import CompuCategory
from odxtools.compumethods.identicalcompumethod import IdenticalCompuMethod
from odxtools.dataobjectproperty import DataObjectProperty
from odxtools.description import Description
from odxtools.diagcomm import DiagComm
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

SECURITY_SID = uds.SID.SecurityAccess.value  # type: ignore[attr-defined]
REQUEST_SEED = 0x01
SEND_KEY = 0x02
SEED_KEY_BYTES = 4

# the NRCs which the security access services may answer with
SECURITY_NRCS = [
    uds.NegativeResponseCodes.InvalidKey,
    uds.NegativeResponseCodes.ExceededNumberOfAttempts,
    uds.NegativeResponseCodes.RequiredTimeDelayNotExpired,
    uds.NegativeResponseCodes.RequestSequenceError,
]

doc_frags = somersaultecu.doc_frags
uint8 = somersaultecu.somersault_diagcodedtypes["uint8"]


def _const(name: str, pos: int, value: int) -> CodedConstParameter:
    return CodedConstParameter(
        short_name=name, diag_coded_type=uint8, byte_position=pos, coded_value_raw=str(value))


def _service(diag_comms: list[OdxLinkRef | DiagComm], name: str) -> DiagService:
    service = next(s for s in diag_comms if isinstance(s, DiagService) and s.short_name == name)
    assert isinstance(service, DiagService)
    return service


def build_database() -> odxtools.database.Database:
    db = deepcopy(somersaultecu.database)
    dlc = db.diag_layer_containers.somersault
    base_raw = dlc.base_variants.somersault_base_variant.diag_layer_raw
    ecu_raw = dlc.ecu_variants.somersault_assiduous.ecu_variant_raw

    ecu_raw.description = Description.from_string(
        "<p>Hard-working variant of the somersault ECU (lazy &lt; assiduous). "
        "Demo PDX extension: the headstand service is protected by UDS "
        "SecurityAccess (0x27) level 1.</p>")

    # 4 byte seeds and keys
    seed_key_dop = DataObjectProperty(
        odx_id=OdxLinkId("somersault.DOP.security_bytes4", doc_frags),
        short_name="security_bytes4",
        diag_coded_type=StandardLengthType(
            base_data_type=DataType.A_BYTEFIELD, bit_length=8 * SEED_KEY_BYTES),
        physical_type=PhysicalType(base_data_type=DataType.A_BYTEFIELD),
        compu_method=IdenticalCompuMethod(
            category=CompuCategory.IDENTICAL,
            internal_type=DataType.A_BYTEFIELD,
            physical_type=DataType.A_BYTEFIELD),
    )
    assert ecu_raw.diag_data_dictionary_spec is not None
    ecu_raw.diag_data_dictionary_spec.data_object_props.append(seed_key_dop)
    dop_ref = OdxLinkRef.from_id(seed_key_dop.odx_id)

    # requests
    rq_seed = Request(
        odx_id=OdxLinkId("somersault_assiduous.RQ.security_request_seed", doc_frags),
        short_name="RQ_security_request_seed",
        parameters=NamedItemList([
            _const("sid", 0, SECURITY_SID),
            _const("security_access_type", 1, REQUEST_SEED),
        ]),
    )
    rq_key = Request(
        odx_id=OdxLinkId("somersault_assiduous.RQ.security_send_key", doc_frags),
        short_name="RQ_security_send_key",
        parameters=NamedItemList([
            _const("sid", 0, SECURITY_SID),
            _const("security_access_type", 1, SEND_KEY),
            ValueParameter(short_name="security_key", byte_position=2, dop_ref=dop_ref),
        ]),
    )

    # positive responses
    pr_seed = Response(
        odx_id=OdxLinkId("somersault_assiduous.PR.security_seed", doc_frags),
        short_name="PR_security_seed",
        response_type=ResponseType.POSITIVE,
        parameters=NamedItemList([
            _const("sid", 0, uds.positive_response_id(SECURITY_SID)),
            _const("security_access_type", 1, REQUEST_SEED),
            ValueParameter(short_name="security_seed", byte_position=2, dop_ref=dop_ref),
        ]),
    )
    pr_key = Response(
        odx_id=OdxLinkId("somersault_assiduous.PR.security_key_accepted", doc_frags),
        short_name="PR_security_key_accepted",
        response_type=ResponseType.POSITIVE,
        parameters=NamedItemList([
            _const("sid", 0, uds.positive_response_id(SECURITY_SID)),
            # only present in the positive response, so the
            # "unlock" state transition below is conditional on it
            _const("security_access_granted", 1, SEND_KEY),
        ]),
    )

    # negative responses, one per NRC, named like uds.NegativeResponseCodes
    nrs = {
        nrc:
            Response(
                odx_id=OdxLinkId(f"somersault_assiduous.NR.security_{nrc.name}", doc_frags),
                short_name=nrc.name,
                response_type=ResponseType.NEGATIVE,
                parameters=NamedItemList([
                    _const("sid", 0, uds.NegativeResponseId),
                    _const("rq_sid", 1, SECURITY_SID),
                    _const("response_code", 2, int(nrc)),
                ]),
            )
        for nrc in SECURITY_NRCS
    }

    ecu_raw.requests.extend([rq_seed, rq_key])
    ecu_raw.positive_responses.extend([pr_seed, pr_key])
    ecu_raw.negative_responses.extend(nrs.values())

    # the security state chart
    chart = StateChart(
        semantic="security",
        odx_id=OdxLinkId("charts.security.chart", doc_frags),
        short_name="security_chart",
        description=Description.from_string(
            "<p>UDS SecurityAccess level 1 (demo PDX extension)</p>"),
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
                target_snref="unlocked",
            ),
            StateTransition(
                odx_id=OdxLinkId("charts.security.transitions.lock", doc_frags),
                short_name="lock",
                source_snref="unlocked",
                target_snref="locked",
            ),
        ],
    )
    ecu_raw.state_charts.append(chart)

    def state_ref(state: str) -> PreConditionStateRef:
        return PreConditionStateRef(ref_id=f"charts.security.states.{state}", ref_docs=doc_frags)

    ecu_raw.diag_comms_raw.extend([
        DiagService(
            odx_id=OdxLinkId("somersault_assiduous.service.security_request_seed", doc_frags),
            short_name="security_request_seed",
            long_name="SecurityAccess level 1: request seed",
            semantic="SECURITY",
            request_ref=OdxLinkRef.from_id(rq_seed.odx_id),
            pos_response_refs=[OdxLinkRef.from_id(pr_seed.odx_id)],
            neg_response_refs=[OdxLinkRef.from_id(nr.odx_id) for nr in nrs.values()],
        ),
        DiagService(
            odx_id=OdxLinkId("somersault_assiduous.service.security_send_key", doc_frags),
            short_name="security_send_key",
            long_name="SecurityAccess level 1: send key",
            semantic="SECURITY",
            request_ref=OdxLinkRef.from_id(rq_key.odx_id),
            pos_response_refs=[OdxLinkRef.from_id(pr_key.odx_id)],
            neg_response_refs=[OdxLinkRef.from_id(nr.odx_id) for nr in nrs.values()],
            state_transition_refs=[
                StateTransitionRef(
                    ref_id="charts.security.transitions.unlock",
                    ref_docs=doc_frags,
                    in_param_if_snref="security_access_granted",
                ),
            ],
        ),
    ])

    # the protected service
    headstand = _service(ecu_raw.diag_comms_raw, "headstand")
    headstand.pre_condition_state_refs.append(state_ref("unlocked"))

    # the session can be started in either security state ...
    session_start = _service(base_raw.diag_comms_raw, "session_start")
    session_start.pre_condition_state_refs.extend([state_ref("locked"), state_ref("unlocked")])

    # ... and stopping it re-locks the ECU
    session_stop = _service(base_raw.diag_comms_raw, "session_stop")
    session_stop.state_transition_refs.append(
        StateTransitionRef(ref_id="charts.security.transitions.lock", ref_docs=doc_frags))

    db.refresh()
    return db


database = build_database()

if __name__ == "__main__":
    argparser = argparse.ArgumentParser(
        description="Creates a demo PDX file for the 'somersault' ECU which adds "
        "UDS SecurityAccess (0x27) protecting the 'headstand' service.")
    argparser.add_argument(
        "output_pdx_file",
        metavar="OUTPUT_PDX_FILE",
        nargs="?",
        default=str(Path(__file__).parent / "somersault_security.pdx"),
        help="Path where the resulting .pdx file is written",
    )
    args = argparser.parse_args()
    odxtools.write_pdx_file(args.output_pdx_file, database)
