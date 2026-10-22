# ODX Diagnostic Workbench

A browser UI built directly on top of the `odxtools` API. Start it with

```bash
pip install .[webdemo]
python3 examples/webdemo/server.py --port 8000
```

and open `http://localhost:8000`. The server binds to `127.0.0.1`
unless `--host` is given. See the top-level `README.md` for an
overview of the Overview, Service Inspector, Live Virtual ECU, Decoder
and Compare tabs.

## Security Access (UDS 0x27 seed/key)

The bundled `somersault.pdx` defines no SecurityAccess services. The
demo-only database `examples/somersault_security.pdx` adds them; it is
generated from `examples/somersaultecu.py` (which stays unchanged) by

```bash
python3 -m examples.mksomersaultsecuritypdx
```

The extension adds to `somersault_assiduous`:

- `security_request_seed`: `27 01` -> `67 01 <security_seed (4 bytes)>`
- `security_send_key`: `27 02 <security_key (4 bytes)>` -> `67 02`
- ODX negative responses for `0x24 RequestSequenceError`, `0x35 InvalidKey`,
  `0x36 ExceededNumberOfAttempts` and `0x37 RequiredTimeDelayNotExpired`
- a `security_chart` STATE-CHART (`locked` -> `unlocked` on a
  successful `security_send_key`, `unlocked` -> `locked` on `session_stop`)
- a PRE-CONDITION-STATE-REF on `headstand` requiring `security_chart` =
  `unlocked`

Select `somersault_security.pdx` and open the **Security Access** tab
(a "Demo PDX extension" ribbon is shown while this database is
active). It connects to `somersault_assiduous` and shows the seed ->
key pipeline, the padlock state, failed attempts, the lockout
countdown, every `27 xx` exchange as an ODX-labelled byte strip and the
`security_chart` diagram. All requests go through the same live
session as the **Live Virtual ECU** tab, so its transaction log and
CAN trace stay in sync.

What is real and what is modeled:

- **REAL:** encoding/decoding by `odxtools`, the gating of `headstand`
  by `odxtools.statemachine.StateMachine` evaluating the ODX state
  chart, and the UDS telegrams on the virtual CAN bus via ISO-TP. A
  negative response restores the chart state, so rejected keys never
  advance `security_chart`.
- **MODELED:** the virtual ECU's seed generation, attempt counter and
  lockout (3 wrong keys -> `0x36`, then a 10 s delay answered with
  `0x37`; an unlocked ECU answers a seed request with an all-zero
  seed), and the key algorithm
  `key = rotl32(seed XOR 0x5A5A5A5A, 3)`.

The key algorithm is a **demo algorithm**. It is not, and does not
resemble, any real OEM seed/key algorithm, and no secret is involved.
