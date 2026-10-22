# Diagnostic Workbench (odxtools web demo)

A browser front-end on top of odxtools: browse a PDX, inspect services
byte by byte, decode telegrams, diff two databases and talk to a virtual
ECU over a virtual CAN bus with ISO-TP.

```bash
pip install ".[webdemo]"
python3 examples/webdemo/server.py --port 8000   # binds to 127.0.0.1 only
```

Tabs: **Overview**, **Service Inspector**, **Live Virtual ECU**,
**Security Access**, **Decoder** and **Compare**.

## Security Access (UDS 0x27 seed/key)

The bundled `somersault.pdx` has no security services, so the demo uses
a generated *demo PDX extension*:

```bash
python3 -m examples.mksomersaultsecuritypdx examples/somersault_security.pdx
```

`examples/mksomersaultsecuritypdx.py` deep-copies
`examples.somersaultecu.database` (the bundled PDX files and
`somersaultecu.py` stay untouched) and adds to `somersault_assiduous`:

| ODX object | Content |
| --- | --- |
| `security_request_seed` | `27 01` &rarr; `67 01 <seed(4)>` |
| `security_send_key` | `27 02 <key(4)>` &rarr; `67 02` |
| NEG-RESPONSEs | `RequestSequenceError` (0x24), `InvalidKey` (0x35), `ExceededNumberOfAttempts` (0x36), `RequiredTimeDelayNotExpired` (0x37) |
| `security_chart` | states `locked` (start) and `unlocked`; `unlock` is triggered by `security_send_key`, `relock` by `session_stop` |
| PRE-CONDITION-STATE-REF | `headstand` requires `security_chart` = `unlocked` |

Gating is done by `odxtools.statemachine.StateMachine` from these ODX
objects; the server has no special case for the protected service. A key
that the ECU rejects leaves the chart in `locked`, because the live
session restores the chart state after a negative response.

The virtual ECU (`virtual_ecu.py`) models the ECU side:

* a random 4-byte seed per request (all zeros once unlocked, as in
  ISO 14229-1),
* the **demo algorithm** `key = rotl32(seed ^ 0x5A5A5A5A, 3)`. It is a
  demo algorithm only, not a real OEM algorithm, and no OEM secret is
  used,
* an attempt counter: the third wrong key answers 0x36 and starts a
  modeled 10 s delay, during which every 0x27 request answers 0x37.

In the UI, pick `somersault_security.pdx` in the database selector, open
**Security Access** and press *Connect*. The tab shows the
seed &rarr; demo algorithm &rarr; key pipeline, the padlock, attempt dots and
lockout countdown, the `security_chart` diagram, a byte strip for each
exchange and a live "Try headstand" card. Every button sends through the
same live session as the **Live Virtual ECU** tab, so its transaction log
and CAN trace show the same telegrams.
