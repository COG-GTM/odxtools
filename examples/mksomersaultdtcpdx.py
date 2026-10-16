#! /usr/bin/python3
#
# SPDX-License-Identifier: MIT
#
# Generate a demo-only variant of the somersault PDX which adds fault
# memory (DTC-DOPs and UDS services 0x19 / 0x14) to the base variant.
# The bundled somersault.pdx and examples/somersaultecu.py stay untouched.
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
from odxtools.dtcdop import DtcDop
from odxtools.endofpdufield import EndOfPduField
from odxtools.nameditemlist import NamedItemList
from odxtools.odxlink import OdxLinkId, OdxLinkRef
from odxtools.odxtypes import DataType
from odxtools.parameters.codedconstparameter import CodedConstParameter
from odxtools.parameters.valueparameter import ValueParameter
from odxtools.physicaltype import PhysicalType
from odxtools.request import Request
from odxtools.response import Response, ResponseType
from odxtools.standardlengthtype import StandardLengthType
from odxtools.structure import Structure
from odxtools.text import Text
from odxtools.unit import Unit

SID = uds.SID

# (trouble code, short name, text)
SOMERSAULT_DTCS = [
    (0x010001, "acrobat_overheated", "Acrobat overheated"),
    (0x010002, "flip_aborted_dizzy", "Flip aborted – too dizzy"),
    (0x010003, "fire_ring_malfunction", "Fire ring malfunction"),
]

# ISO 14229-1 DTC status bits, bit 0 first
DTC_STATUS_BITS = [
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


def _const(name: str, value: int, pos: int, bits: int = 8) -> CodedConstParameter:
    return CodedConstParameter(
        short_name=name, diag_coded_type=_uint(bits), byte_position=pos, coded_value_raw=str(value))


def _value(name: str, dop: Any, pos: int, bit_pos: int | None = None) -> ValueParameter:
    return ValueParameter(
        short_name=name,
        byte_position=pos,
        bit_position=bit_pos,
        dop_ref=OdxLinkRef.from_id(dop.odx_id))


def add_fault_memory(db: Database) -> Database:
    db = deepcopy(db)
    dlc = db.diag_layer_containers.somersault
    dlr = dlc.base_variants.somersault_base_variant.diag_layer_raw
    ddds = dlr.diag_data_dictionary_spec
    assert ddds is not None and ddds.unit_spec is not None
    doc_frags = dlr.odx_id.doc_fragments

    def oid(local: str) -> OdxLinkId:
        return OdxLinkId(f"somersault.dtc_ext.{local}", doc_frags)

    units = ddds.unit_spec.units
    percent = Unit(
        odx_id=oid("unit.percent"),
        short_name="percent",
        display_name="%",
        long_name="Percent",
        factor_si_to_unit=1,
        offset_si_to_unit=0)
    units.append(percent)

    dtc_dop = DtcDop(
        odx_id=oid("DTC-DOP.somersault_dtcs"),
        short_name="somersault_dtcs",
        long_name="Somersault diagnostic trouble codes (demo PDX extension)",
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
                level=1,
            ) for code, sn, text in SOMERSAULT_DTCS
        ],
    )
    ddds.dtc_dops.append(dtc_dop)

    bit_dop = DataObjectProperty(
        odx_id=oid("DOP.dtc_status_bit"),
        short_name="dtc_status_bit",
        diag_coded_type=_uint(1),
        physical_type=PhysicalType(base_data_type=DataType.A_UINT32),
        compu_method=_passthrough())
    mask_dop = DataObjectProperty(
        odx_id=oid("DOP.dtc_status_mask"),
        short_name="dtc_status_mask",
        long_name="DTC status mask (ISO 14229-1)",
        diag_coded_type=_uint(8),
        physical_type=PhysicalType(base_data_type=DataType.A_UINT32),
        compu_method=_passthrough())
    percent_dop = DataObjectProperty(
        odx_id=oid("DOP.dizziness_percent"),
        short_name="dizziness_percent",
        long_name="Dizziness relative to the flip limit",
        diag_coded_type=_uint(8),
        physical_type=PhysicalType(base_data_type=DataType.A_UINT32),
        compu_method=_passthrough(),
        unit_ref=OdxLinkRef.from_id(percent.odx_id))
    seconds_dop = DataObjectProperty(
        odx_id=oid("DOP.seconds_since_connect"),
        short_name="seconds_since_connect",
        diag_coded_type=_uint(16),
        physical_type=PhysicalType(base_data_type=DataType.A_UINT32),
        compu_method=_passthrough(),
        unit_ref=OdxLinkRef.from_id(somersaultecu.somersault_units["second"].odx_id))
    for dop in (bit_dop, mask_dop, percent_dop, seconds_dop):
        ddds.data_object_props.append(dop)

    status_struct = Structure(
        odx_id=oid("STRUCT.dtc_status"),
        short_name="dtc_status",
        long_name="DTC status byte (ISO 14229-1)",
        byte_size=1,
        parameters=NamedItemList(
            [_value(name, bit_dop, 0, bit) for bit, name in enumerate(DTC_STATUS_BITS)]),
    )
    record_struct = Structure(
        odx_id=oid("STRUCT.dtc_and_status"),
        short_name="dtc_and_status",
        byte_size=4,
        parameters=NamedItemList([
            _value("dtc", dtc_dop, 0),
            _value("status", status_struct, 3),
        ]),
    )
    temperature_dop = somersaultecu.somersault_dops["temperature"]
    uint16_dop = somersaultecu.somersault_dops["uint16"]
    snapshot_struct = Structure(
        odx_id=oid("STRUCT.snapshot_record_01"),
        short_name="snapshot_record_01",
        long_name="Snapshot record 0x01: ECU state when the fault was stored",
        byte_size=6,
        parameters=NamedItemList([
            _value("temperature", temperature_dop, 0),
            _value("dizziness", percent_dop, 1),
            _value("total_flips", uint16_dop, 2),
            _value("timestamp", seconds_dop, 4),
        ]),
    )
    for s in (status_struct, record_struct, snapshot_struct):
        ddds.structures.append(s)
    dtc_list = EndOfPduField(
        odx_id=oid("EOPF.dtc_and_status_list"),
        short_name="dtc_and_status_list",
        structure_ref=OdxLinkRef.from_id(record_struct.odx_id),
        is_visible_raw=True,
    )
    ddds.end_of_pdu_fields.append(dtc_list)

    rdtci = SID.ReadDtcInformation.value  # type: ignore[attr-defined]
    cdtci = SID.ClearDiagnosticInformation.value  # type: ignore[attr-defined]
    requests = [
        Request(
            odx_id=oid("RQ.read_dtc_by_status_mask"),
            short_name="read_dtc_by_status_mask",
            long_name="ReadDTCInformation: reportDTCByStatusMask",
            parameters=NamedItemList([
                _const("sid", rdtci, 0),
                _const("report_type", 0x02, 1),
                _value("status_mask", mask_dop, 2),
            ])),
        Request(
            odx_id=oid("RQ.read_dtc_snapshot"),
            short_name="read_dtc_snapshot",
            long_name="ReadDTCInformation: reportDTCSnapshotRecordByDTCNumber",
            parameters=NamedItemList([
                _const("sid", rdtci, 0),
                _const("report_type", 0x04, 1),
                _value("dtc", dtc_dop, 2),
                _value("record_number", somersaultecu.somersault_dops["uint8"], 5),
            ])),
        Request(
            odx_id=oid("RQ.clear_dtcs"),
            short_name="clear_dtcs",
            long_name="ClearDiagnosticInformation: all groups",
            parameters=NamedItemList([
                _const("sid", cdtci, 0),
                _const("group_of_dtc", 0xFFFFFF, 1, 24),
            ])),
    ]
    responses = [
        Response(
            odx_id=oid("PR.dtcs_by_status_mask"),
            short_name="dtcs_by_status_mask",
            response_type=ResponseType.POSITIVE,
            parameters=NamedItemList([
                _const("sid", rdtci + 0x40, 0),
                _const("report_type", 0x02, 1),
                _value("availability_mask", mask_dop, 2),
                _value("dtc_records", dtc_list, 3),
            ])),
        Response(
            odx_id=oid("PR.dtc_snapshot"),
            short_name="dtc_snapshot",
            response_type=ResponseType.POSITIVE,
            parameters=NamedItemList([
                _const("sid", rdtci + 0x40, 0),
                _const("report_type", 0x04, 1),
                _value("dtc", dtc_dop, 2),
                _value("status", status_struct, 5),
                _value("record_number", somersaultecu.somersault_dops["uint8"], 6),
                _value("snapshot", snapshot_struct, 7),
            ])),
        Response(
            odx_id=oid("PR.dtcs_cleared"),
            short_name="dtcs_cleared",
            response_type=ResponseType.POSITIVE,
            parameters=NamedItemList([
                _const("sid", cdtci + 0x40, 0),
            ])),
    ]
    for rq in requests:
        dlr.requests.append(rq)
    for pr in responses:
        dlr.positive_responses.append(pr)

    general_nr = dlr.negative_responses.general_negative_response
    for rq, pr, desc in zip(
            requests,
            responses, [
                "Report all stored DTCs whose status matches the given mask.",
                "Report the environment snapshot stored with a DTC.",
                "Clear the complete fault memory.",
            ],
            strict=True):
        dlr.diag_comms_raw.append(
            DiagService(
                odx_id=oid(f"service.{rq.short_name}"),
                short_name=rq.short_name,
                description=Description.from_string(f"<p>{desc} (demo PDX extension)</p>"),
                semantic="FAULTREAD" if rq.short_name.startswith("read") else "FAULTCLEAR",
                request_ref=OdxLinkRef.from_id(rq.odx_id),
                pos_response_refs=[OdxLinkRef.from_id(pr.odx_id)],
                neg_response_refs=[OdxLinkRef.from_id(general_nr.odx_id)],
            ))

    db.refresh()
    return db


if __name__ == "__main__":
    argparser = argparse.ArgumentParser(
        description="Generate examples/somersault_dtc.pdx: the somersault demo database "
        "extended with fault memory (DTC-DOPs, 0x19 ReadDTCInformation, "
        "0x14 ClearDiagnosticInformation)")
    argparser.add_argument(
        "output_pdx_file",
        metavar="OUTPUT_PDX_FILE",
        nargs="?",
        default="somersault_dtc.pdx",
        help="Name of the output PDX file")
    args = argparser.parse_args()
    odxtools.write_pdx_file(args.output_pdx_file, add_fault_memory(somersaultecu.database))
