#! /usr/bin/python3
#
# SPDX-License-Identifier: MIT
#
# Generate a demo-only variant of the somersault PDX which adds ECU
# fault memory: a DTC-DOP with three trouble codes, an ISO 14229 DTC
# status byte, a snapshot record and the UDS services
# ReadDTCInformation (0x19, sub-functions 0x02 and 0x04) and
# ClearDiagnosticInformation (0x14).
#
# The original definitions in somersaultecu.py are left untouched;
# everything is added to a deep copy of the base variant so that the
# lazy and the assiduous ECU variants inherit it.
import argparse
from copy import deepcopy
from pathlib import Path

import odxtools
import odxtools.uds as uds
from examples import somersaultecu
from odxtools.compumethods.compucategory import CompuCategory
from odxtools.compumethods.compuinternaltophys import CompuInternalToPhys
from odxtools.compumethods.compurationalcoeffs import CompuRationalCoeffs
from odxtools.compumethods.compuscale import CompuScale
from odxtools.compumethods.identicalcompumethod import IdenticalCompuMethod
from odxtools.compumethods.linearcompumethod import LinearCompuMethod
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
from odxtools.parameters.matchingrequestparameter import MatchingRequestParameter
from odxtools.parameters.parameter import Parameter
from odxtools.parameters.valueparameter import ValueParameter
from odxtools.physicaltype import PhysicalType
from odxtools.request import Request
from odxtools.response import Response, ResponseType
from odxtools.standardlengthtype import StandardLengthType
from odxtools.structure import Structure
from odxtools.text import Text
from odxtools.unit import Unit

doc_frags = somersaultecu.doc_frags
SID = uds.UDSSID

#: (short name, trouble code, text) of the demo DTCs
DTCS = [
    ("acrobat_overheated", 0x010001, "Acrobat overheated"),
    ("flip_aborted_dizzy", 0x010002, "Flip aborted – too dizzy"),
    ("fire_ring_malfunction", 0x010003, "Fire ring malfunction"),
]

#: ISO 14229-1 DTC status bits (bit position, short name, long name)
STATUS_BITS = [
    (0, "test_failed", "testFailed"),
    (1, "test_failed_this_operation_cycle", "testFailedThisOperationCycle"),
    (2, "pending_dtc", "pendingDTC"),
    (3, "confirmed_dtc", "confirmedDTC"),
    (4, "test_not_completed_since_last_clear", "testNotCompletedSinceLastClear"),
    (5, "test_failed_since_last_clear", "testFailedSinceLastClear"),
    (6, "test_not_completed_this_operation_cycle", "testNotCompletedThisOperationCycle"),
    (7, "warning_indicator_requested", "warningIndicatorRequested"),
]


def _id(name: str) -> OdxLinkId:
    return OdxLinkId(f"somersault.dtc_ext.{name}", doc_frags)


def _ref(name: str) -> OdxLinkRef:
    return OdxLinkRef.from_id(_id(name))


def _uint(bits: int) -> StandardLengthType:
    return StandardLengthType(base_data_type=DataType.A_UINT32, bit_length=bits)


def _uint_compu() -> IdenticalCompuMethod:
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
           dop: str,
           byte_position: int,
           default: str | None = None,
           long_name: str | None = None,
           bit_position: int | None = None) -> ValueParameter:
    return ValueParameter(
        short_name=name,
        long_name=long_name,
        byte_position=byte_position,
        bit_position=bit_position,
        physical_default_value_raw=default,
        dop_ref=_ref(dop))


def _uint_dop(name: str, bits: int, unit: OdxLinkRef | None = None) -> DataObjectProperty:
    return DataObjectProperty(
        odx_id=_id(name),
        short_name=name,
        diag_coded_type=_uint(bits),
        physical_type=PhysicalType(base_data_type=DataType.A_UINT32),
        compu_method=_uint_compu(),
        unit_ref=unit)


def build_database() -> Database:
    db = deepcopy(somersaultecu.database)
    dlc = db.diag_layer_containers[0]
    base = dlc.base_variants.somersault_base_variant.diag_layer_raw
    ddds = base.diag_data_dictionary_spec
    assert ddds is not None

    # units and simple data object properties
    percent = Unit(
        odx_id=_id("unit.percent"),
        short_name="percent",
        display_name="%",
        long_name="Percent",
        factor_si_to_unit=1,
        offset_si_to_unit=0)
    assert ddds.unit_spec is not None
    ddds.unit_spec.units.append(percent)
    celsius = OdxLinkRef.from_id(somersaultecu.somersault_units["celsius"].odx_id)
    second = OdxLinkRef.from_id(somersaultecu.somersault_units["second"].odx_id)
    for dop in [
            _uint_dop("dtc_status_bit", 1),
            _uint_dop("status_mask", 8),
            _uint_dop("snapshot_record_number", 8),
            _uint_dop("snapshot_temperature", 8, celsius),
            _uint_dop("snapshot_total_flips", 16),
            _uint_dop("snapshot_timestamp", 16, second),
    ]:
        ddds.data_object_props.append(dop)
    # the raw dizziness level (0..255) is reported in percent
    ddds.data_object_props.append(
        DataObjectProperty(
            odx_id=_id("snapshot_dizziness"),
            short_name="snapshot_dizziness",
            diag_coded_type=_uint(8),
            physical_type=PhysicalType(base_data_type=DataType.A_FLOAT64),
            compu_method=LinearCompuMethod(
                category=CompuCategory.LINEAR,
                compu_internal_to_phys=CompuInternalToPhys(compu_scales=[
                    CompuScale(
                        compu_rational_coeffs=CompuRationalCoeffs(
                            value_type=DataType.A_FLOAT64, numerators=[0, 100], denominators=[255]),
                        domain_type=DataType.A_UINT32,
                        range_type=DataType.A_FLOAT64)
                ]),
                internal_type=DataType.A_UINT32,
                physical_type=DataType.A_FLOAT64),
            unit_ref=OdxLinkRef.from_id(percent.odx_id)))

    # the DTC-DOP: three byte DTC numbers which are mapped to trouble codes
    ddds.dtc_dops.append(
        DtcDop(
            odx_id=_id("dtc_dop"),
            short_name="somersault_dtc",
            long_name="Somersault diagnostic trouble code",
            diag_coded_type=_uint(24),
            physical_type=PhysicalType(base_data_type=DataType.A_UINT32),
            compu_method=_uint_compu(),
            dtcs_raw=[
                DiagnosticTroubleCode(
                    odx_id=_id(f"dtc.{name}"),
                    short_name=name,
                    trouble_code=code,
                    display_trouble_code=f"{code:06X}",
                    text=Text.from_string(text),
                    level=1,
                ) for name, code, text in DTCS
            ]))

    # structures
    status_struct = Structure(
        odx_id=_id("struct.dtc_status"),
        short_name="dtc_status",
        long_name="ISO 14229 DTC status byte",
        byte_size=1,
        parameters=NamedItemList([
            _value(name, "dtc_status_bit", 0, long_name=long_name, bit_position=bit)
            for bit, name, long_name in STATUS_BITS
        ]))
    record_struct = Structure(
        odx_id=_id("struct.dtc_and_status"),
        short_name="dtc_and_status",
        long_name="DTC and its status",
        byte_size=4,
        parameters=NamedItemList([
            _value("dtc", "dtc_dop", 0),
            _value("status", "struct.dtc_status", 3),
        ]))
    snapshot_struct = Structure(
        odx_id=_id("struct.snapshot_record"),
        short_name="snapshot_record",
        long_name="Snapshot record 0x01: environment at the time of the fault",
        parameters=NamedItemList([
            _value("temperature", "snapshot_temperature", 0, long_name="Temperature"),
            _value("dizziness", "snapshot_dizziness", 1, long_name="Dizziness"),
            _value("total_flips", "snapshot_total_flips", 2, long_name="Total flips"),
            _value("timestamp", "snapshot_timestamp", 4, long_name="Seconds since tester connect"),
        ]))
    for s in (status_struct, record_struct, snapshot_struct):
        ddds.structures.append(s)
    ddds.end_of_pdu_fields.append(
        EndOfPduField(
            odx_id=_id("field.dtc_records"),
            short_name="dtc_records",
            long_name="DTC records until the end of the PDU",
            structure_ref=_ref("struct.dtc_and_status")))

    rdi = SID.ReadDtcInformation.value
    cdi = SID.ClearDiagnosticInformation.value

    def request(name: str, long_name: str, params: list[Parameter]) -> Request:
        return Request(
            odx_id=_id(f"RQ.{name}"),
            short_name=name,
            long_name=long_name,
            parameters=NamedItemList(params))

    def response(name: str, params: list[Parameter]) -> Response:
        return Response(
            odx_id=_id(f"PR.{name}"),
            short_name=name,
            response_type=ResponseType.POSITIVE,
            parameters=NamedItemList(params))

    requests = [
        request("read_dtc_by_status_mask", "Report DTCs by status mask", [
            _const("sid", rdi, 0),
            _const("sub_function", 0x02, 1),
            _value("status_mask", "status_mask", 2, default="255"),
        ]),
        request("read_dtc_snapshot", "Report DTC snapshot record by DTC number", [
            _const("sid", rdi, 0),
            _const("sub_function", 0x04, 1),
            _value("dtc", "dtc_dop", 2),
            _value("record_number", "snapshot_record_number", 5, default="1"),
        ]),
        request("clear_dtcs", "Clear all diagnostic information", [
            _const("sid", cdi, 0),
            _const("group_of_dtc", 0xFFFFFF, 1, bits=24),
        ]),
    ]
    responses = [
        response("dtcs_by_status_mask", [
            _const("sid", uds.positive_response_id(rdi), 0),
            _const("sub_function", 0x02, 1),
            _value("availability_mask", "status_mask", 2),
            _value("dtc_records", "field.dtc_records", 3),
        ]),
        response("dtc_snapshot", [
            _const("sid", uds.positive_response_id(rdi), 0),
            _const("sub_function", 0x04, 1),
            _value("dtc", "dtc_dop", 2),
            _value("status", "struct.dtc_status", 5),
            MatchingRequestParameter(
                short_name="record_number", request_byte_position=5, byte_position=6,
                byte_length=1),
            _value("snapshot", "struct.snapshot_record", 7),
        ]),
        response("dtcs_cleared", [
            _const("sid", uds.positive_response_id(cdi), 0),
        ]),
    ]
    for rq in requests:
        base.requests.append(rq)
    for pr in responses:
        base.positive_responses.append(pr)

    general_nr = OdxLinkRef("somersault.NR.general_negative_response", doc_frags)
    for name, rq_name, pr_name, text in [
        ("read_dtc_by_status_mask", "read_dtc_by_status_mask", "dtcs_by_status_mask",
         "Read the DTCs whose status matches the mask."),
        ("read_dtc_snapshot", "read_dtc_snapshot", "dtc_snapshot",
         "Read the snapshot record stored together with a DTC."),
        ("clear_dtcs", "clear_dtcs", "dtcs_cleared", "Clear the fault memory."),
    ]:
        base.diag_comms_raw.append(
            DiagService(
                odx_id=_id(f"service.{name}"),
                short_name=name,
                description=Description.from_string(f"<p>{text}</p>"),
                semantic="FAULTREAD" if name != "clear_dtcs" else "FAULTCLEAR",
                request_ref=_ref(f"RQ.{rq_name}"),
                pos_response_refs=[_ref(f"PR.{pr_name}")],
                neg_response_refs=[general_nr],
            ))

    db.refresh()
    return db


def main() -> None:
    argparser = argparse.ArgumentParser(
        description="Write the demo-only somersault PDX with fault memory (DTCs)")
    argparser.add_argument(
        "output_pdx_file",
        nargs="?",
        default=str(Path(__file__).parent / "somersault_dtc.pdx"),
        help="Output PDX file")
    args = argparser.parse_args()
    odxtools.write_pdx_file(args.output_pdx_file, build_database())


if __name__ == "__main__":
    main()
