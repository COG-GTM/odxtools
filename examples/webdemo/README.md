# ODX Diagnostic Workbench

A browser UI built directly on top of odxtools. Start it with

```bash
pip install ".[webdemo]"
python3 examples/webdemo/server.py --port 8000   # binds to 127.0.0.1 by default
```

and open http://localhost:8000. The tabs are Overview, Service Inspector,
Live Virtual ECU, Fault Memory, Decoder and Compare.

## Fault Memory

The Fault Memory tab shows the fault memory (DTCs) of the virtual
Somersault ECU. It needs the demo database `examples/somersault_dtc.pdx`.
While that database is open, the tab shows a "Demo PDX extension" ribbon.

- **Fault timeline**: one marker per stored or updated DTC, placed at
  the time the fault happened. Hover a marker to see its trigger.
- **DTC cards**: one card per DTC returned by `19 02 FF`
  (ReadDTCInformation, reportDTCByStatusMask). A card shows the code,
  the ODX text, an occurrence counter and the eight ISO 14229 status bits.
- **Snapshot drawer**: click a card to send `19 04 <DTC> 01`. The
  drawer shows the stored temperature and dizziness as gauges, plus the
  raw byte strip.
- **UDS exchanges**: a request/response byte strip for each Read,
  Snapshot and Clear (`14 FF FF FF`). Each byte is coloured by its ODX
  parameter.
- **Provoke fault**: drives the ECU into one of the three fault
  conditions using its normal services:
  - overheat (repeated forward flips)
  - flip while dizzy (backward flips)
  - fire-ring flip (`set_operation_params` followed by a failing flip)

  Before each run, the acrobat rests. This is a modeled shortcut
  (`POST /api/live/recover`) that sends no UDS traffic and keeps the
  fault memory.

Every request goes through the same path as the Live Virtual ECU tab, so
it also shows up in the CAN trace and the transaction log there.

### What is real and what is modeled

| Real | Modeled |
| --- | --- |
| Encoding and decoding by odxtools, including `DtcDop` → `DiagnosticTroubleCode`, the end-of-PDU DTC record field and the snapshot structure | Acrobat physics (dizziness, temperature) |
| ODX state chart (`odxtools.statemachine.StateMachine`) | Fault detection: when a DTC is stored, when its testFailed bit heals, and the occurrence counter |
| UDS over ISO-TP (can-isotp) on a python-can `virtual` bus, plus the passive odxtools ISO-TP snooper | The fault timeline, which is the ECU's internal event log and is not read over UDS |

### The demo PDX

The original `somersault.pdx` defines no DTCs. `examples/somersault_dtc.pdx`
is generated from `examples/somersaultecu.py` by:

```bash
python3 -m examples.mksomersaultdtcpdx
```

The script deep-copies the somersault database and adds the following to
`somersault_base_variant`, so both ECU variants inherit it:

- a 3-byte `DtcDop` with three DTCs:
  - `0x010001` Acrobat overheated
  - `0x010002` Flip aborted – too dizzy
  - `0x010003` Fire ring malfunction
- an ISO 14229 status-byte structure
- the snapshot record `0x01`: temperature, dizziness in %, total flips,
  and seconds since connect
- three services:
  - `read_dtc_by_status_mask` (`19 02`)
  - `read_dtc_snapshot` (`19 04`)
  - `clear_dtcs` (`14 FF FF FF`)

`examples/somersaultecu.py`, `somersault.pdx` and
`somersault_modified.pdx` are unchanged.

Only `somersault_assiduous` inherits `do_backward_flips` and
`set_operation_params`. For that reason, Fault Memory selects that variant
when the demo PDX is opened. On `somersault_lazy`, "Flip while dizzy" and
"Fire-ring flip" are disabled, with the NOT-INHERITED reason shown.
