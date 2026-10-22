#! /usr/bin/python3
#
# SPDX-License-Identifier: MIT
#
# Creates "somersault_dtc.pdx": a copy of the somersault database
# whose base variant additionally defines fault memory services (UDS
# 0x19 ReadDTCInformation and 0x14 ClearDiagnosticInformation). These
# definitions are a demo extension for the ODX Diagnostic Workbench;
# the original somersault ECU does not have them.
import argparse
from copy import deepcopy

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

uint8 = StandardLengthType(base_data_type=DataType.A_UINT32, bit_length=8)
uint16 = StandardLengthType(base_data_type=DataType.A_UINT32, bit_length=16)
uint24 = StandardLengthType(base_data_type=DataType.A_UINT32, bit_length=24)
flag = StandardLengthType(base_data_type=DataType.A_UINT32, bit_length=1)


def _id(name: str) -> OdxLinkId:
    return OdxLinkId(f"somersault.dtc.{name}", doc_frags)


def _ref(obj: DataObjectProperty | DtcDop | Structure | EndOfPduField) -> OdxLinkRef:
    return OdxLinkRef.from_id(obj.odx_id)


def _uint_dop(name: str,
              coded: StandardLengthType,
              unit: Unit | None = None,
              long_name: str | None = None) -> DataObjectProperty:
    return DataObjectProperty(
        odx_id=_id(f"DOP.{name}"),
        short_name=name,
        long_name=long_name,
        diag_coded_type=coded,
        physical_type=PhysicalType(base_data_type=DataType.A_UINT32),
        compu_method=IdenticalCompuMethod(
            category=CompuCategory.IDENTICAL,
            internal_type=DataType.A_UINT32,
            physical_type=DataType.A_UINT32),
        unit_ref=OdxLinkRef.from_id(unit.odx_id) if unit is not None else None,
    )


def _sid(value: int) -> CodedConstParameter:
    return CodedConstParameter(
        short_name="sid", diag_coded_type=uint8, byte_position=0, coded_value_raw=str(int(value)))


def _const(name: str,
           value: int,
           byte_position: int,
           coded: StandardLengthType = uint8) -> CodedConstParameter:
    return CodedConstParameter(
        short_name=name,
        diag_coded_type=coded,
        byte_position=byte_position,
        coded_value_raw=str(int(value)))


def _value(name: str,
           dop: DataObjectProperty | DtcDop | Structure | EndOfPduField,
           byte_position: int | None = None,
           bit_position: int | None = None,
           default: str | None = None,
           long_name: str | None = None) -> ValueParameter:
    return ValueParameter(
        short_name=name,
        long_name=long_name,
        dop_ref=_ref(dop),
        byte_position=byte_position,
        bit_position=bit_position,
        physical_default_value_raw=default,
    )


#####
# units and data object properties
#####

percent = Unit(
    odx_id=_id("unit.percent"),
    short_name="percent",
    display_name="%",
    long_name="Percent",
)
celsius = somersaultecu.somersault_units["celsius"]
second = somersaultecu.somersault_units["second"]

# the diagnostic trouble codes which the acrobat's fault memory can store
dtcs = [
    DiagnosticTroubleCode(
        odx_id=_id("DTC.acrobat_overheated"),
        short_name="acrobat_overheated",
        trouble_code=0x010001,
        display_trouble_code="B010001",
        text=Text.from_string("Acrobat overheated"),
        level=2,
    ),
    DiagnosticTroubleCode(
        odx_id=_id("DTC.flip_aborted_dizzy"),
        short_name="flip_aborted_dizzy",
        trouble_code=0x010002,
        display_trouble_code="B010002",
        text=Text.from_string("Flip aborted – too dizzy"),
        level=3,
    ),
    DiagnosticTroubleCode(
        odx_id=_id("DTC.fire_ring_malfunction"),
        short_name="fire_ring_malfunction",
        trouble_code=0x010003,
        display_trouble_code="B010003",
        text=Text.from_string("Fire ring malfunction"),
        level=1,
    ),
]

dtc_dop = DtcDop(
    odx_id=_id("DOP.somersault_dtc"),
    short_name="somersault_dtc",
    long_name="Somersault diagnostic trouble code",
    description=Description.from_string("<p>3-byte UDS DTC of the somersault ECU</p>"),
    diag_coded_type=uint24,
    physical_type=PhysicalType(base_data_type=DataType.A_UINT32),
    compu_method=IdenticalCompuMethod(
        category=CompuCategory.IDENTICAL,
        internal_type=DataType.A_UINT32,
        physical_type=DataType.A_UINT32),
    dtcs_raw=list(dtcs),
)

status_bit_dop = _uint_dop("dtc_status_bit", flag)
status_mask_dop = _uint_dop("dtc_status_mask", uint8, long_name="DTC status mask")
record_number_dop = _uint_dop("dtc_snapshot_record_number", uint8)
total_flips_dop = _uint_dop("total_flips", uint16)
timestamp_dop = _uint_dop("seconds_since_connect", uint16, unit=second)

# dizziness is transmitted as the raw level (0..255) and presented in
# percent of the scale
dizziness_dop = DataObjectProperty(
    odx_id=_id("DOP.dizziness_percent"),
    short_name="dizziness_percent",
    diag_coded_type=uint8,
    physical_type=PhysicalType(base_data_type=DataType.A_FLOAT64),
    compu_method=LinearCompuMethod(
        category=CompuCategory.LINEAR,
        compu_internal_to_phys=CompuInternalToPhys(compu_scales=[
            CompuScale(
                compu_rational_coeffs=CompuRationalCoeffs(
                    value_type=DataType.A_FLOAT64,
                    numerators=[0.0, 100.0],
                    denominators=[255.0],
                ),
                domain_type=DataType.A_UINT32,
                range_type=DataType.A_FLOAT64),
        ]),
        internal_type=DataType.A_UINT32,
        physical_type=DataType.A_FLOAT64),
    unit_ref=OdxLinkRef.from_id(percent.odx_id),
)

#####
# structures
#####

# ISO 14229-1, D.2: statusOfDTC
STATUS_BITS = [
    ("test_failed", "testFailed"),
    ("test_failed_this_operation_cycle", "testFailedThisOperationCycle"),
    ("pending_dtc", "pendingDTC"),
    ("confirmed_dtc", "confirmedDTC"),
    ("test_not_completed_since_last_clear", "testNotCompletedSinceLastClear"),
    ("test_failed_since_last_clear", "testFailedSinceLastClear"),
    ("test_not_completed_this_operation_cycle", "testNotCompletedThisOperationCycle"),
    ("warning_indicator_requested", "warningIndicatorRequested"),
]
status_params: list[Parameter] = [
    _value(name, status_bit_dop, byte_position=0, bit_position=i, long_name=long_name)
    for i, (name, long_name) in enumerate(STATUS_BITS)
]
dtc_status = Structure(
    odx_id=_id("struct.dtc_status"),
    short_name="dtc_status",
    long_name="statusOfDTC (ISO 14229-1)",
    byte_size=1,
    parameters=NamedItemList(status_params),
)

dtc_and_status = Structure(
    odx_id=_id("struct.dtc_and_status"),
    short_name="dtc_and_status",
    parameters=NamedItemList([
        _value("dtc", dtc_dop, byte_position=0),
        _value("status", dtc_status, byte_position=3),
    ]),
)

dtc_list = EndOfPduField(
    odx_id=_id("field.dtc_and_status_list"),
    short_name="dtc_and_status_list",
    structure_ref=_ref(dtc_and_status),
)

snapshot_record = Structure(
    odx_id=_id("struct.snapshot_record"),
    short_name="snapshot_record",
    long_name="Freeze frame taken when the fault was stored",
    parameters=NamedItemList([
        _value("temperature", somersaultecu.somersault_dops["temperature"], byte_position=0),
        _value("dizziness", dizziness_dop, byte_position=1),
        _value("total_flips", total_flips_dop, byte_position=2),
        _value("timestamp", timestamp_dop, byte_position=4),
    ]),
)

#####
# requests and responses
#####

RDTCI = uds.UDSSID.ReadDtcInformation
CDTCI = uds.UDSSID.ClearDiagnosticInformation
REPORT_DTC_BY_STATUS_MASK = 0x02
REPORT_DTC_SNAPSHOT_BY_DTC_NUMBER = 0x04

requests = [
    Request(
        odx_id=_id("RQ.read_dtc_by_status_mask"),
        short_name="read_dtc_by_status_mask",
        long_name="reportDTCByStatusMask",
        parameters=NamedItemList([
            _sid(RDTCI),
            _const("sub_function", REPORT_DTC_BY_STATUS_MASK, 1),
            _value("status_mask", status_mask_dop, byte_position=2, default="255"),
        ]),
    ),
    Request(
        odx_id=_id("RQ.read_dtc_snapshot"),
        short_name="read_dtc_snapshot",
        long_name="reportDTCSnapshotRecordByDTCNumber",
        parameters=NamedItemList([
            _sid(RDTCI),
            _const("sub_function", REPORT_DTC_SNAPSHOT_BY_DTC_NUMBER, 1),
            _value("dtc", dtc_dop, byte_position=2),
            _value("record_number", record_number_dop, byte_position=5, default="1"),
        ]),
    ),
    Request(
        odx_id=_id("RQ.clear_dtcs"),
        short_name="clear_dtcs",
        long_name="ClearDiagnosticInformation (all groups)",
        parameters=NamedItemList([
            _sid(CDTCI),
            _const("group_of_dtc", 0xFFFFFF, 1, uint24),
        ]),
    ),
]

positive_responses = [
    Response(
        odx_id=_id("PR.dtc_list"),
        short_name="dtc_list",
        response_type=ResponseType.POSITIVE,
        parameters=NamedItemList([
            _sid(uds.positive_response_id(RDTCI)),
            _const("sub_function", REPORT_DTC_BY_STATUS_MASK, 1),
            _value("status_availability_mask", status_mask_dop, byte_position=2),
            _value("dtcs", dtc_list, byte_position=3),
        ]),
    ),
    Response(
        odx_id=_id("PR.dtc_snapshot"),
        short_name="dtc_snapshot",
        response_type=ResponseType.POSITIVE,
        parameters=NamedItemList([
            _sid(uds.positive_response_id(RDTCI)),
            _const("sub_function", REPORT_DTC_SNAPSHOT_BY_DTC_NUMBER, 1),
            _value("dtc", dtc_dop, byte_position=2),
            _value("status", dtc_status, byte_position=5),
            _value("record_number", record_number_dop, byte_position=6),
            _value("snapshot", snapshot_record, byte_position=7),
        ]),
    ),
    Response(
        odx_id=_id("PR.dtcs_cleared"),
        short_name="dtcs_cleared",
        response_type=ResponseType.POSITIVE,
        parameters=NamedItemList([_sid(uds.positive_response_id(CDTCI))]),
    ),
]

general_nr_ref = OdxLinkRef.from_id(somersaultecu.somersault_negative_responses["general"].odx_id)


def _service(name: str, semantic: str, request: Request, response: Response,
             description: str) -> DiagService:
    return DiagService(
        odx_id=_id(f"service.{name}"),
        short_name=name,
        semantic=semantic,
        description=Description.from_string(f"<p>{description}</p>"),
        request_ref=OdxLinkRef.from_id(request.odx_id),
        pos_response_refs=[OdxLinkRef.from_id(response.odx_id)],
        neg_response_refs=[general_nr_ref],
    )


services = [
    _service("read_dtc_by_status_mask", "FAULTREAD", requests[0], positive_responses[0],
             "Report all stored DTCs whose status matches the mask (demo PDX extension)"),
    _service("read_dtc_snapshot", "FAULTREAD", requests[1], positive_responses[1],
             "Report the snapshot record of a stored DTC (demo PDX extension)"),
    _service("clear_dtcs", "CLEARFAULTMEM", requests[2], positive_responses[2],
             "Clear the complete fault memory (demo PDX extension)"),
]


def build_database() -> Database:
    db = deepcopy(somersaultecu.database)
    db.short_name = "somersault_dtc_database"
    dlc = db.diag_layer_containers.somersault
    base = dlc.base_variants.somersault_base_variant.diag_layer_raw
    ddds = base.diag_data_dictionary_spec
    assert ddds is not None and ddds.unit_spec is not None

    ddds.unit_spec.units.append(deepcopy(percent))
    ddds.dtc_dops.append(deepcopy(dtc_dop))
    for dop in (status_bit_dop, status_mask_dop, record_number_dop, total_flips_dop, timestamp_dop,
                dizziness_dop):
        ddds.data_object_props.append(deepcopy(dop))
    for struct in (dtc_status, dtc_and_status, snapshot_record):
        ddds.structures.append(deepcopy(struct))
    ddds.end_of_pdu_fields.append(deepcopy(dtc_list))

    base.requests.extend(deepcopy(requests))
    base.positive_responses.extend(deepcopy(positive_responses))
    base.diag_comms_raw.extend(deepcopy(services))

    dlc.description = Description.from_string(
        "<p>Somersault ECUs with a fault memory. The DTC definitions are a "
        "demo extension of the somersault example.</p>")
    db.refresh()
    return db


if __name__ == "__main__":
    argparser = argparse.ArgumentParser(
        description="Creates the somersault PDX file extended by fault memory (DTC) services.")
    argparser.add_argument(
        "output_pdx_file",
        metavar="OUTPUT_PDX_FILE",
        nargs="?",
        default="examples/somersault_dtc.pdx",
        help="Path where the resulting .pdx file is written",
    )
    args = argparser.parse_args()
    odxtools.write_pdx_file(args.output_pdx_file, build_database())
