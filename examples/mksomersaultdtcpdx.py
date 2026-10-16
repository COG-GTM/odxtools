#! /usr/bin/python3
#
# SPDX-License-Identifier: MIT
#
# Extend the somersault ECU by a fault memory: DTC-DOPs plus the UDS
# services ReadDTCInformation (0x19) and ClearDiagnosticInformation
# (0x14). The result is a demo-only PDX file which is used by the
# "Fault Memory" tab of the web demo (examples/webdemo).
import argparse
from copy import deepcopy
from typing import Any

import odxtools
import odxtools.uds as uds
from examples import somersaultecu
from odxtools.compumethods.compucategory import CompuCategory
from odxtools.compumethods.identicalcompumethod import IdenticalCompuMethod
from odxtools.database import Database
from odxtools.dataobjectproperty import DataObjectProperty
from odxtools.description import Description
from odxtools.diagnostictroublecode import DiagnosticTroubleCode
from odxtools.diagservice import DiagService
from odxtools.docrevision import DocRevision
from odxtools.dtcdop import DtcDop
from odxtools.endofpdufield import EndOfPduField
from odxtools.modification import Modification
from odxtools.nameditemlist import NamedItemList
from odxtools.odxlink import OdxLinkId, OdxLinkRef
from odxtools.odxtypes import DataType
from odxtools.parameters.codedconstparameter import CodedConstParameter
from odxtools.parameters.parameter import Parameter
from odxtools.parameters.valueparameter import ValueParameter
from odxtools.physicaltype import PhysicalType
from odxtools.request import Request
from odxtools.response import Response, ResponseType
from odxtools.standardlengthtype import StandardLengthType
from odxtools.structure import Structure
from odxtools.text import Text
from odxtools.unit import Unit

SID = uds.UDSSID
READ_DTC_BY_STATUS_MASK = 0x02
READ_DTC_SNAPSHOT_BY_DTC_NUMBER = 0x04

# trouble code, short name, text
DTCS = [
    (0x010001, "acrobat_overheated", "Acrobat overheated"),
    (0x010002, "flip_aborted_dizzy", "Flip aborted – too dizzy"),
    (0x010003, "fire_ring_malfunction", "Fire ring malfunction"),
]

# ISO 14229-1, DTCStatusMask bits 0..7
STATUS_BITS = [
    "test_failed",
    "test_failed_this_operation_cycle",
    "pending_dtc",
    "confirmed_dtc",
    "test_not_completed_since_last_clear",
    "test_failed_since_last_clear",
    "test_not_completed_this_operation_cycle",
    "warning_indicator_requested",
]


def _uint(bits: int) -> StandardLengthType:
    return StandardLengthType(base_data_type=DataType.A_UINT32, bit_length=bits)


def _passthrough() -> IdenticalCompuMethod:
    return IdenticalCompuMethod(
        category=CompuCategory.IDENTICAL,
        internal_type=DataType.A_UINT32,
        physical_type=DataType.A_UINT32)


def _const(name: str, value: int, byte_position: int, bits: int = 8) -> CodedConstParameter:
    return CodedConstParameter(
        short_name=name,
        diag_coded_type=_uint(bits),
        byte_position=byte_position,
        coded_value_raw=str(value))


def _value(name: str,
           dop_id: OdxLinkId,
           byte_position: int | None = None,
           bit_position: int | None = None,
           **kwargs: Any) -> ValueParameter:
    return ValueParameter(
        short_name=name,
        dop_ref=OdxLinkRef.from_id(dop_id),
        byte_position=byte_position,
        bit_position=bit_position,
        **kwargs)


def build_database() -> Database:
    db = deepcopy(somersaultecu.database)
    dlc = db.diag_layer_containers.somersault
    base = dlc.base_variants.somersault_base_variant.diag_layer_raw
    ddds = base.diag_data_dictionary_spec
    assert ddds is not None and ddds.unit_spec is not None
    doc_frags = base.odx_id.doc_fragments

    def oid(name: str) -> OdxLinkId:
        return OdxLinkId(f"somersault.dtc_demo.{name}", doc_frags)

    percent = Unit(odx_id=oid("unit.percent"), short_name="percent", display_name="%")
    ddds.unit_spec.units.append(percent)

    def dop(name: str, bits: int, unit: Unit | None = None) -> DataObjectProperty:
        return DataObjectProperty(
            odx_id=oid(f"DOP.{name}"),
            short_name=name,
            diag_coded_type=_uint(bits),
            physical_type=PhysicalType(base_data_type=DataType.A_UINT32),
            compu_method=_passthrough(),
            unit_ref=OdxLinkRef.from_id(unit.odx_id) if unit is not None else None)

    dops = {
        "status_bit": dop("dtc_status_bit", 1),
        "status_mask": dop("dtc_status_mask", 8),
        "record_number": dop("dtc_snapshot_record_number", 8),
        "dizziness_pct": dop("dizziness_percent", 8, percent),
        "flip_count": dop("total_flip_count", 16),
        "timestamp": dop("seconds_since_connect", 16, ddds.unit_spec.units.second),
    }
    temperature_dop = ddds.data_object_props.temperature

    dtc_dop = DtcDop(
        odx_id=oid("DOP.somersault_dtc"),
        short_name="somersault_dtc",
        long_name="Somersault diagnostic trouble code",
        diag_coded_type=_uint(24),
        physical_type=PhysicalType(base_data_type=DataType.A_UINT32),
        compu_method=_passthrough(),
        dtcs_raw=[
            DiagnosticTroubleCode(
                odx_id=oid(f"DTC.{sn}"),
                short_name=sn,
                trouble_code=code,
                display_trouble_code=f"{code:06X}",
                text=Text.from_string(text),
                level=2,
            ) for code, sn, text in DTCS
        ],
    )

    status_struct = Structure(
        odx_id=oid("STRUCT.dtc_status"),
        short_name="dtc_status",
        long_name="ISO 14229 DTC status byte",
        byte_size=1,
        parameters=NamedItemList([
            _value(name, dops["status_bit"].odx_id, byte_position=0, bit_position=i)
            for i, name in enumerate(STATUS_BITS)
        ]),
    )
    dtc_and_status = Structure(
        odx_id=oid("STRUCT.dtc_and_status"),
        short_name="dtc_and_status",
        byte_size=4,
        parameters=NamedItemList([
            _value("dtc", dtc_dop.odx_id, byte_position=0),
            _value("status", status_struct.odx_id, byte_position=3),
        ]),
    )
    dtc_records = EndOfPduField(
        odx_id=oid("EOPF.dtc_records"),
        short_name="dtc_records",
        structure_ref=OdxLinkRef.from_id(dtc_and_status.odx_id),
        is_visible_raw=True,
    )
    snapshot_struct = Structure(
        odx_id=oid("STRUCT.snapshot_record"),
        short_name="snapshot_record",
        long_name="Snapshot record 0x01: acrobat condition when the fault was stored",
        byte_size=6,
        parameters=NamedItemList([
            _value("temperature", temperature_dop.odx_id, byte_position=0),
            _value("dizziness", dops["dizziness_pct"].odx_id, byte_position=1),
            _value("total_flips", dops["flip_count"].odx_id, byte_position=2),
            _value("timestamp", dops["timestamp"].odx_id, byte_position=4),
        ]),
    )

    ddds.dtc_dops.append(dtc_dop)
    for d in dops.values():
        ddds.data_object_props.append(d)
    for s in (status_struct, dtc_and_status, snapshot_struct):
        ddds.structures.append(s)
    ddds.end_of_pdu_fields.append(dtc_records)

    sid_read = SID.ReadDtcInformation.value  # type: ignore[attr-defined]
    sid_clear = SID.ClearDiagnosticInformation.value  # type: ignore[attr-defined]

    def positive(name: str, params: list[Parameter]) -> Response:
        return Response(
            odx_id=oid(f"PR.{name}"),
            short_name=name,
            response_type=ResponseType.POSITIVE,
            parameters=NamedItemList(params))

    requests = [
        Request(
            odx_id=oid("RQ.read_dtc_by_status_mask"),
            short_name="read_dtc_by_status_mask",
            parameters=NamedItemList([
                _const("sid", sid_read, 0),
                _const("report_type", READ_DTC_BY_STATUS_MASK, 1),
                _value("status_mask", dops["status_mask"].odx_id, 2),
            ])),
        Request(
            odx_id=oid("RQ.read_dtc_snapshot"),
            short_name="read_dtc_snapshot",
            parameters=NamedItemList([
                _const("sid", sid_read, 0),
                _const("report_type", READ_DTC_SNAPSHOT_BY_DTC_NUMBER, 1),
                _value("dtc", dtc_dop.odx_id, 2),
                _value("record_number", dops["record_number"].odx_id, 5),
            ])),
        Request(
            odx_id=oid("RQ.clear_dtcs"),
            short_name="clear_dtcs",
            parameters=NamedItemList([
                _const("sid", sid_clear, 0),
                _const("group_of_dtc", 0xFFFFFF, 1, bits=24),
            ])),
    ]
    responses = [
        positive("dtc_list", [
            _const("sid", sid_read | 0x40, 0),
            _const("report_type", READ_DTC_BY_STATUS_MASK, 1),
            _value("status_availability_mask", dops["status_mask"].odx_id, 2),
            _value("dtc_records", dtc_records.odx_id, 3),
        ]),
        positive("dtc_snapshot", [
            _const("sid", sid_read | 0x40, 0),
            _const("report_type", READ_DTC_SNAPSHOT_BY_DTC_NUMBER, 1),
            _value("dtc", dtc_dop.odx_id, 2),
            _value("status", status_struct.odx_id, 5),
            _value("record_number", dops["record_number"].odx_id, 6),
            _value("snapshot", snapshot_struct.odx_id, 7),
        ]),
        positive("dtcs_cleared", [_const("sid", sid_clear | 0x40, 0)]),
    ]
    general_nr = base.negative_responses.general_negative_response

    services = []
    semantics = ("FAULTREAD", "FAULTREAD", "CLEARFAULTMEM")
    descriptions = (
        "Report all DTCs whose status matches the mask (ISO 14229 0x19 0x02).",
        "Report a snapshot record of a DTC (ISO 14229 0x19 0x04).",
        "Clear the complete fault memory (ISO 14229 0x14 0xFFFFFF).",
    )
    for rq, pr, semantic, desc in zip(requests, responses, semantics, descriptions, strict=True):
        base.requests.append(rq)
        base.positive_responses.append(pr)
        services.append(
            DiagService(
                odx_id=oid(f"service.{rq.short_name}"),
                short_name=rq.short_name,
                semantic=semantic,
                description=Description.from_string(f"<p>{desc}</p>"),
                request_ref=OdxLinkRef.from_id(rq.odx_id),
                pos_response_refs=[OdxLinkRef.from_id(pr.odx_id)],
                neg_response_refs=[OdxLinkRef.from_id(general_nr.odx_id)],
            ))
    base.diag_comms_raw.extend(services)

    if dlc.admin_data is not None:
        dlc.admin_data.doc_revisions.append(
            DocRevision(
                revision_label="1.2-dtc-demo",
                state="draft",
                date="2026-10-16T00:00:00+00:00",
                tool="examples/mksomersaultdtcpdx.py",
                modifications=[
                    Modification(
                        change="add fault memory: DTC-DOP, status and snapshot structures",
                        reason="demo-only extension for the ODX Diagnostic Workbench"),
                    Modification(
                        change="add read_dtc_by_status_mask, read_dtc_snapshot, clear_dtcs"),
                ],
            ))

    db.short_name = "somersault_dtc_database"
    db.refresh()
    return db


database = build_database()

if __name__ == "__main__":
    argparser = argparse.ArgumentParser(
        description="Write the somersault ECU extended by a fault memory to a PDX file.")
    argparser.add_argument(
        "output_pdx_file",
        metavar="OUTPUT_PDX_FILE",
        nargs="?",
        default="somersault_dtc.pdx",
        help="Name of the output PDX file")
    args = argparser.parse_args()
    odxtools.write_pdx_file(args.output_pdx_file, database)
