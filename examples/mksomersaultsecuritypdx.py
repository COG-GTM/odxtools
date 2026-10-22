#! /usr/bin/python3
#
# SPDX-License-Identifier: MIT
#
# Creates "somersault_security.pdx": a demo-only extension of the
# somersault database which adds UDS 0x27 SecurityAccess (seed/key)
# to the "somersault_assiduous" ECU variant. The lock state is
# modeled as an ODX state chart ("security_chart") and the
# "headstand" service may only be executed while it is "unlocked".
#
# Note that the bundled somersault PDX files are left untouched: this
# script works on a deep copy of `examples.somersaultecu.database`.
import argparse
from copy import deepcopy

import odxtools
import odxtools.uds as uds
from examples import somersaultecu
from odxtools.compumethods.identicalcompumethod import IdenticalCompuMethod
from odxtools.compumethods.compucategory import CompuCategory
from odxtools.database import Database
from odxtools.dataobjectproperty import DataObjectProperty
from odxtools.description import Description
from odxtools.diagservice import DiagService
from odxtools.docrevision import DocRevision
from odxtools.modification import Modification
from odxtools.nameditemlist import NamedItemList
from odxtools.odxlink import DocType, OdxDocFragment, OdxLinkId, OdxLinkRef
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

SID = uds.SID.SecurityAccess.value  # type: ignore[attr-defined]
REQUEST_SEED = 0x01
SEND_KEY = 0x02

# negative response codes which the SecurityAccess services may send
# (names as defined by `odxtools.uds.NegativeResponseCodes`)
SECURITY_NRCS = [
    uds.NegativeResponseCodes.RequestSequenceError,
    uds.NegativeResponseCodes.InvalidKey,
    uds.NegativeResponseCodes.ExceededNumberOfAttempts,
    uds.NegativeResponseCodes.RequiredTimeDelayNotExpired,
]

doc_frags = (OdxDocFragment(somersaultecu.dlc_short_name, DocType.CONTAINER),)
uint8 = somersaultecu.somersault_diagcodedtypes["uint8"]
uint32 = StandardLengthType(base_data_type=DataType.A_UINT32, bit_length=32)


def make_database() -> Database:
    db = deepcopy(somersaultecu.database)
    dlc = db.diag_layer_containers[0]
    base_raw = dlc.base_variants.somersault_base_variant.diag_layer_raw
    ecu_raw = dlc.ecu_variants.somersault_assiduous.diag_layer_raw

    assert dlc.admin_data is not None
    dlc.admin_data.doc_revisions.append(
        DocRevision(
            team_member_ref=OdxLinkRef("TM.Doggy", doc_frags),
            revision_label="1.2-security-demo",
            state="draft",
            date="2026-10-22T00:00:00+00:00",
            tool="examples/mksomersaultsecuritypdx.py",
            modifications=[
                Modification(
                    change="add UDS 0x27 SecurityAccess (demo seed/key) to somersault_assiduous",
                    reason="demo PDX extension: headstands now require an unlocked ECU"),
            ],
        ))

    # data object properties for the 4 byte seed and key
    passthrough = IdenticalCompuMethod(
        category=CompuCategory.IDENTICAL,
        internal_type=DataType.A_UINT32,
        physical_type=DataType.A_UINT32)
    dops = {
        name:
            DataObjectProperty(
                odx_id=OdxLinkId(f"somersault_assiduous.DOP.{name}", doc_frags),
                short_name=name,
                description=Description.from_string(f"<p>4 byte SecurityAccess {desc}</p>"),
                diag_coded_type=uint32,
                physical_type=PhysicalType(base_data_type=DataType.A_UINT32),
                compu_method=passthrough,
            )
        for name, desc in (("security_seed", "seed sent by the ECU"),
                           ("security_key", "key computed by the tester"))
    }
    assert ecu_raw.diag_data_dictionary_spec is not None
    ecu_raw.diag_data_dictionary_spec.data_object_props.extend(dops.values())

    def sid_param(value: int) -> CodedConstParameter:
        return CodedConstParameter(
            short_name="sid", diag_coded_type=uint8, byte_position=0, coded_value_raw=str(value))

    def sub_function(value: int) -> CodedConstParameter:
        return CodedConstParameter(
            short_name="security_access_type",
            diag_coded_type=uint8,
            byte_position=1,
            coded_value_raw=str(value))

    # requests and positive responses
    rq_seed = Request(
        odx_id=OdxLinkId("somersault_assiduous.RQ.security_request_seed", doc_frags),
        short_name="RQ_security_request_seed",
        parameters=NamedItemList([sid_param(SID), sub_function(REQUEST_SEED)]),
    )
    rq_key = Request(
        odx_id=OdxLinkId("somersault_assiduous.RQ.security_send_key", doc_frags),
        short_name="RQ_security_send_key",
        parameters=NamedItemList([
            sid_param(SID),
            sub_function(SEND_KEY),
            ValueParameter(
                short_name="key",
                byte_position=2,
                dop_ref=OdxLinkRef.from_id(dops["security_key"].odx_id)),
        ]),
    )
    pr_seed = Response(
        odx_id=OdxLinkId("somersault_assiduous.PR.security_seed", doc_frags),
        short_name="security_seed",
        response_type=ResponseType.POSITIVE,
        parameters=NamedItemList([
            sid_param(uds.positive_response_id(SID)),
            sub_function(REQUEST_SEED),
            ValueParameter(
                short_name="seed",
                byte_position=2,
                dop_ref=OdxLinkRef.from_id(dops["security_seed"].odx_id)),
        ]),
    )
    pr_key = Response(
        odx_id=OdxLinkId("somersault_assiduous.PR.security_key_accepted", doc_frags),
        short_name="security_key_accepted",
        response_type=ResponseType.POSITIVE,
        parameters=NamedItemList([sid_param(uds.positive_response_id(SID)),
                                  sub_function(SEND_KEY)]),
    )

    # one ODX negative response per NRC, so that decoding identifies them
    neg_responses = [
        Response(
            odx_id=OdxLinkId(f"somersault_assiduous.NR.security.{nrc.name}", doc_frags),
            short_name=nrc.name,
            description=Description.from_string(
                f"<p>UDS negative response 0x{nrc.value:02x} {nrc.name}</p>"),
            response_type=ResponseType.NEGATIVE,
            parameters=NamedItemList([
                sid_param(uds.NegativeResponseId),
                CodedConstParameter(
                    short_name="rq_sid",
                    diag_coded_type=uint8,
                    byte_position=1,
                    coded_value_raw=str(SID)),
                CodedConstParameter(
                    short_name="response_code",
                    diag_coded_type=uint8,
                    byte_position=2,
                    coded_value_raw=str(nrc.value)),
            ]),
        ) for nrc in SECURITY_NRCS
    ]
    neg_refs = [OdxLinkRef.from_id(nr.odx_id) for nr in neg_responses]

    # the lock state of the ECU as an ODX state chart
    security_chart = StateChart(
        odx_id=OdxLinkId("charts.security.chart", doc_frags),
        short_name="security_chart",
        semantic="SECURITY",
        description=Description.from_string(
            "<p>UDS SecurityAccess level 1 (demo seed/key algorithm)</p>"),
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
    ecu_raw.state_charts.append(security_chart)

    seed_service = DiagService(
        odx_id=OdxLinkId("somersault_assiduous.service.security_request_seed", doc_frags),
        short_name="security_request_seed",
        long_name="SecurityAccess requestSeed (level 1)",
        semantic="SECURITY",
        request_ref=OdxLinkRef.from_id(rq_seed.odx_id),
        pos_response_refs=[OdxLinkRef.from_id(pr_seed.odx_id)],
        neg_response_refs=neg_refs,
    )
    key_service = DiagService(
        odx_id=OdxLinkId("somersault_assiduous.service.security_send_key", doc_frags),
        short_name="security_send_key",
        long_name="SecurityAccess sendKey (level 1)",
        semantic="SECURITY",
        request_ref=OdxLinkRef.from_id(rq_key.odx_id),
        pos_response_refs=[OdxLinkRef.from_id(pr_key.odx_id)],
        neg_response_refs=neg_refs,
        state_transition_refs=[
            StateTransitionRef(ref_id="charts.security.transitions.unlock", ref_docs=doc_frags),
        ],
    )

    ecu_raw.requests.extend([rq_seed, rq_key])
    ecu_raw.positive_responses.extend([pr_seed, pr_key])
    ecu_raw.negative_responses.extend(neg_responses)
    ecu_raw.diag_comms_raw.extend([seed_service, key_service])

    # headstands are protected by the security chart...
    headstand = next(
        x for x in ecu_raw.diag_comms_raw if getattr(x, "short_name", None) == "headstand")
    assert isinstance(headstand, DiagService)
    headstand.pre_condition_state_refs.append(
        PreConditionStateRef(ref_id="charts.security.states.unlocked", ref_docs=doc_frags))

    # odxtools' StateMachine only executes a service with
    # PRE-CONDITION-STATE-REFs if one of them applies to the active
    # chart, so session_start must explicitly be allowed in both states
    session_start = next(
        x for x in base_raw.diag_comms_raw if getattr(x, "short_name", None) == "session_start")
    assert isinstance(session_start, DiagService)
    session_start.pre_condition_state_refs.extend(
        PreConditionStateRef(ref_id=f"charts.security.states.{state}", ref_docs=doc_frags)
        for state in ("locked", "unlocked"))

    # ... and ending the session locks the ECU again
    session_stop = next(
        x for x in base_raw.diag_comms_raw if getattr(x, "short_name", None) == "session_stop")
    assert isinstance(session_stop, DiagService)
    session_stop.state_transition_refs.append(
        StateTransitionRef(ref_id="charts.security.transitions.relock", ref_docs=doc_frags))

    db.refresh()
    return db


database = make_database()

if __name__ == "__main__":
    argparser = argparse.ArgumentParser(
        description="\n".join([
            "Creates the demo-only 'somersault_security' PDX file which adds UDS 0x27",
            "SecurityAccess (seed/key) and a 'security_chart' state chart to the",
            "somersault_assiduous ECU. The key algorithm is a demo algorithm.",
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
