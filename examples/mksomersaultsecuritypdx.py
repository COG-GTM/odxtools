#! /usr/bin/python3
#
# SPDX-License-Identifier: MIT
#
# This script derives a demo-only PDX file from the "somersault"
# database which adds UDS SecurityAccess (0x27) to the
# somersault_assiduous ECU variant: Seed/key services, a state chart
# which tracks the lock state and a pre-condition which protects the
# "headstand" service.
#
# The seed/key algorithm used by the virtual ECU of the web demo is a
# *demo algorithm* (key = rotl32(seed ^ 0x5A5A5A5A, 3)). It is not and
# does not resemble any real OEM algorithm.
import argparse
from copy import deepcopy
from pathlib import Path

import odxtools
import odxtools.uds as uds
from examples import somersaultecu
from odxtools.compumethods.compucategory import CompuCategory
from odxtools.compumethods.identicalcompumethod import IdenticalCompuMethod
from odxtools.database import Database
from odxtools.dataobjectproperty import DataObjectProperty
from odxtools.description import Description
from odxtools.diagservice import DiagService
from odxtools.docrevision import DocRevision
from odxtools.modification import Modification
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
REQUEST_SEED_LEVEL_1 = 0x01
SEND_KEY_LEVEL_1 = 0x02
SECURITY_NRCS = (
    uds.NegativeResponseCodes.RequestSequenceError,
    uds.NegativeResponseCodes.InvalidKey,
    uds.NegativeResponseCodes.ExceededNumberOfAttempts,
    uds.NegativeResponseCodes.RequiredTimeDelayNotExpired,
)
DEMO_ALGORITHM = "key = rotl32(seed XOR 0x5A5A5A5A, 3)"

doc_frags = somersaultecu.doc_frags
uint8 = somersaultecu.somersault_diagcodedtypes["uint8"]
uint32 = StandardLengthType(base_data_type=DataType.A_UINT32, bit_length=32)


def _const(name: str, value: int, byte_position: int) -> CodedConstParameter:
    return CodedConstParameter(
        short_name=name,
        diag_coded_type=uint8,
        byte_position=byte_position,
        coded_value_raw=str(value),
    )


def _dop(name: str, long_name: str) -> DataObjectProperty:
    return DataObjectProperty(
        odx_id=OdxLinkId(f"somersault_assiduous.DOP.{name}", doc_frags),
        short_name=name,
        long_name=long_name,
        diag_coded_type=uint32,
        physical_type=PhysicalType(base_data_type=DataType.A_UINT32),
        compu_method=IdenticalCompuMethod(
            category=CompuCategory.IDENTICAL,
            internal_type=DataType.A_UINT32,
            physical_type=DataType.A_UINT32),
    )


def add_security_access(db: Database) -> None:
    dlc = db.diag_layer_containers.somersault
    base_raw = dlc.base_variants.somersault_base_variant.diag_layer_raw
    ecu_raw = dlc.ecu_variants.somersault_assiduous.diag_layer_raw

    # data object properties for the 4-byte seed and key
    seed_dop = _dop("security_seed", "SecurityAccess seed (4 bytes)")
    key_dop = _dop("security_key", "SecurityAccess key (4 bytes)")
    assert ecu_raw.diag_data_dictionary_spec is not None
    ecu_raw.diag_data_dictionary_spec.data_object_props.extend([seed_dop, key_dop])

    # requests: 27 01 (requestSeed) and 27 02 <key> (sendKey)
    rq_seed = Request(
        odx_id=OdxLinkId("somersault_assiduous.RQ.security_request_seed", doc_frags),
        short_name="RQ_security_request_seed",
        parameters=NamedItemList([
            _const("sid", SECURITY_SID, 0),
            _const("security_access_type", REQUEST_SEED_LEVEL_1, 1),
        ]),
    )
    rq_key = Request(
        odx_id=OdxLinkId("somersault_assiduous.RQ.security_send_key", doc_frags),
        short_name="RQ_security_send_key",
        parameters=NamedItemList([
            _const("sid", SECURITY_SID, 0),
            _const("security_access_type", SEND_KEY_LEVEL_1, 1),
            ValueParameter(
                short_name="security_key",
                byte_position=2,
                dop_ref=OdxLinkRef.from_id(key_dop.odx_id),
            ),
        ]),
    )
    ecu_raw.requests.extend([rq_seed, rq_key])

    # positive responses: 67 01 <seed> and 67 02
    pr_seed = Response(
        odx_id=OdxLinkId("somersault_assiduous.PR.security_seed", doc_frags),
        short_name="security_seed",
        response_type=ResponseType.POSITIVE,
        parameters=NamedItemList([
            _const("sid", uds.positive_response_id(SECURITY_SID), 0),
            _const("security_access_type", REQUEST_SEED_LEVEL_1, 1),
            ValueParameter(
                short_name="security_seed",
                byte_position=2,
                dop_ref=OdxLinkRef.from_id(seed_dop.odx_id),
            ),
        ]),
    )
    pr_key = Response(
        odx_id=OdxLinkId("somersault_assiduous.PR.security_key_accepted", doc_frags),
        short_name="security_key_accepted",
        response_type=ResponseType.POSITIVE,
        parameters=NamedItemList([
            _const("sid", uds.positive_response_id(SECURITY_SID), 0),
            _const("security_access_type", SEND_KEY_LEVEL_1, 1),
        ]),
    )
    ecu_raw.positive_responses.extend([pr_seed, pr_key])

    # negative responses: 7F 27 <NRC>, one per NRC so that the
    # decoded coding object names the reason
    nrcs = {}
    for code in SECURITY_NRCS:
        nrcs[code] = Response(
            odx_id=OdxLinkId(f"somersault_assiduous.NR.security_{code.name}", doc_frags),
            short_name=f"nrc_{code.name}",
            long_name=f"NRC 0x{int(code):02X} {code.name}",
            response_type=ResponseType.NEGATIVE,
            parameters=NamedItemList([
                _const("sid", uds.NegativeResponseId, 0),
                _const("rq_sid", SECURITY_SID, 1),
                _const("response_code", int(code), 2),
            ]),
        )
    ecu_raw.negative_responses.extend(nrcs.values())

    # the lock state is an ODX state chart
    chart = StateChart(
        semantic="security",
        odx_id=OdxLinkId("charts.security.chart", doc_frags),
        short_name="security_chart",
        description=Description.from_string(
            "<p>SecurityAccess level 1 of the somersault ECU (demo PDX extension)</p>"),
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
                odx_id=OdxLinkId("charts.security.transitions.relock", doc_frags),
                short_name="relock",
                source_snref="unlocked",
                target_snref="locked",
            ),
        ],
    )
    ecu_raw.state_charts.append(chart)

    def _state_ref(state: str) -> PreConditionStateRef:
        return PreConditionStateRef(ref_id=f"charts.security.states.{state}", ref_docs=doc_frags)

    def _transition_ref(transition: str) -> StateTransitionRef:
        return StateTransitionRef(
            ref_id=f"charts.security.transitions.{transition}", ref_docs=doc_frags)

    neg_refs = [OdxLinkRef.from_id(nr.odx_id) for nr in nrcs.values()]
    ecu_raw.diag_comms_raw.extend([
        DiagService(
            odx_id=OdxLinkId("somersault_assiduous.service.security_request_seed", doc_frags),
            short_name="security_request_seed",
            long_name="SecurityAccess: request seed (level 1)",
            description=Description.from_string(
                "<p>UDS 0x27 0x01. Returns a 4-byte seed, or all zeros if already unlocked.</p>"),
            semantic="SECURITY",
            request_ref=OdxLinkRef.from_id(rq_seed.odx_id),
            pos_response_refs=[OdxLinkRef.from_id(pr_seed.odx_id)],
            neg_response_refs=neg_refs,
        ),
        DiagService(
            odx_id=OdxLinkId("somersault_assiduous.service.security_send_key", doc_frags),
            short_name="security_send_key",
            long_name="SecurityAccess: send key (level 1)",
            description=Description.from_string(
                "<p>UDS 0x27 0x02. Demo algorithm, not a real OEM algorithm: "
                f"{DEMO_ALGORITHM}</p>"),
            semantic="SECURITY",
            request_ref=OdxLinkRef.from_id(rq_key.odx_id),
            pos_response_refs=[OdxLinkRef.from_id(pr_key.odx_id)],
            neg_response_refs=neg_refs,
            state_transition_refs=[_transition_ref("unlock")],
        ),
    ])

    # the headstand is only allowed once the ECU is unlocked
    headstand = next(
        s for s in ecu_raw.diag_comms_raw
        if isinstance(s, DiagService) and s.short_name == "headstand")
    headstand.pre_condition_state_refs.append(_state_ref("unlocked"))

    # session_stop locks the ECU again. session_start, whose existing
    # pre-conditions refer to the charts of somersault_lazy, may be
    # executed in either security state.
    services = {s.short_name: s for s in base_raw.diag_comms_raw if isinstance(s, DiagService)}
    services["session_stop"].state_transition_refs.append(_transition_ref("relock"))
    services["session_start"].pre_condition_state_refs.extend(
        [_state_ref("locked"), _state_ref("unlocked")])

    assert dlc.admin_data is not None
    dlc.admin_data.doc_revisions.append(
        DocRevision(
            team_member_ref=OdxLinkRef("TM.Doggy", doc_frags),
            revision_label="1.2-security-demo",
            state="draft",
            date="2026-10-22T12:00:00+00:00",
            tool="examples/mksomersaultsecuritypdx.py",
            modifications=[
                Modification(
                    change="demo PDX extension: add SecurityAccess (0x27) and security_chart "
                    "to somersault_assiduous",
                    reason="demonstrate seed/key gating through an ODX state chart"),
                Modification(change="protect headstand by a security_chart pre-condition"),
            ],
        ))

    db.refresh()


db = deepcopy(somersaultecu.database)
add_security_access(db)

if __name__ == "__main__":
    argparser = argparse.ArgumentParser(
        description="\n".join([
            "Creates a demo-only PDX file which adds UDS SecurityAccess (0x27) to the",
            "'somersault_assiduous' ECU of the 'somersault' database.",
        ]),
        formatter_class=argparse.RawTextHelpFormatter,
    )
    argparser.add_argument(
        "output_pdx_file",
        metavar="OUTPUT_PDX_FILE",
        nargs="?",
        default=str(Path(__file__).parent / "somersault_security.pdx"),
        help="Path where the resulting .pdx file is written",
    )
    args = argparser.parse_args()

    odxtools.write_pdx_file(args.output_pdx_file, db)
