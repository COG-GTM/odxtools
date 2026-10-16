# ODX Diagnostic Workbench (web demo)

A browser UI built directly on top of the `odxtools` API.

```bash
pip install .[webdemo]
python3 examples/webdemo/server.py --port 8000   # binds to 127.0.0.1
```

Then open `http://localhost:8000`. Tabs: Overview, Service Inspector,
Live Virtual ECU, Security Access, Decoder and Compare (see the
top-level `README.md` for the other tabs).

## Security Access (UDS 0x27 seed & key)

The bundled `somersault.pdx` defines no security services, so the
**demo PDX extension** `examples/somersault_security.pdx` adds them. It
is generated from `examples/somersaultecu.py` (which is left unchanged)
by

```bash
python3 -m examples.mksomersaultsecuritypdx   # writes examples/somersault_security.pdx
```

and adds to the `somersault_assiduous` ECU variant:

- `security_request_seed` (`27 01` → `67 01 <seed(4)>`) and
  `security_send_key` (`27 02 <key(4)>` → `67 02`), each with ODX
  negative responses for `InvalidKey` (0x35),
  `ExceededNumberOfAttempts` (0x36), `RequiredTimeDelayNotExpired`
  (0x37) and `RequestSequenceError` (0x24),
- a `security_chart` STATE-CHART with the states `locked` (start) and
  `unlocked`; `security_send_key` triggers `locked → unlocked` only if
  its positive response is received, `session_stop` triggers
  `unlocked → locked`,
- a PRE-CONDITION-STATE-REF on `headstand` which requires
  `security_chart` to be `unlocked`.

Gating is done by `odxtools.statemachine.StateMachine` from the ODX,
not by special-case server code: while locked, `headstand` is refused
before anything is sent on the bus. The server restores the chart
state whenever the ECU answers with a negative response, so a rejected
key never advances the chart.

The virtual ECU (`virtual_ecu.py`) answers a seed request with a random
4-byte seed (all zeros if it is already unlocked), checks the key, and
after three wrong keys answers `0x36` and starts a modeled 10 s delay
during which all 0x27 requests get `0x37`. `session_stop` re-locks it.

**The key algorithm is a demo algorithm:**
`key = rotl32(seed ^ 0x5A5A5A5A, 3)`. It is not the algorithm of any
real ECU and no real OEM secret is used or implied. In the UI it is
labeled `MODELED`, as are the ECU's physics; decoding, the state chart
and the CAN/ISO-TP transport are real.

The Security Access tab shows the seed → demo algorithm → key pipeline
byte by byte, a padlock (locked / unlocking / unlocked / locked out),
the wrong-key counter and lockout countdown, the `security_chart`
diagram, every exchange as a labeled byte strip (negative responses as
NRC cards) and a live "Try headstand" card. All requests go through the
same live session as the Live Virtual ECU tab, so its transaction log
and CAN trace stay in sync.
