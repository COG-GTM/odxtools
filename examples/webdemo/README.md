# ODX Diagnostic Workbench (web demo)

A browser UI built directly on top of the `odxtools` API.

```bash
pip install .[webdemo]
python3 examples/webdemo/server.py --port 8000   # binds to 127.0.0.1 by default
```

Then open `http://localhost:8000`. The tabs are described in the
top-level `README.md` (Overview, Service Inspector, Live Virtual ECU,
Security Access, Decoder, Compare).

## Security Access (UDS 0x27 seed/key)

The bundled `somersault.pdx` has no security services, so
`examples/mksomersaultsecuritypdx.py` generates the **demo-only**
`examples/somersault_security.pdx`. It deep-copies
`examples/somersaultecu.py`'s database (which itself stays untouched)
and adds:

| ODX object | Content |
|---|---|
| `security_request_seed` | `27 01` → `67 01 <seed(4)>` |
| `security_send_key` | `27 02 <key(4)>` → `67 02` |
| negative responses | `7F 27 35` InvalidKey, `7F 27 36` ExceededNumberOfAttempts, `7F 27 37` RequiredTimeDelayNotExpired, `7F 27 24` RequestSequenceError (key without seed) |
| `security_chart` (semantic `SECURITY`) | states `locked` (start) / `unlocked`; `unlock` is triggered by `security_send_key`, `relock` by `session_stop` |
| `PRE-CONDITION-STATE-REF` | `headstand` of `somersault_assiduous` requires `unlocked` |

Regenerate it with

```bash
python3 -m examples.mksomersaultsecuritypdx examples/somersault_security.pdx
```

Select `somersault_security.pdx` in the database picker (the UI shows a
"Demo PDX extension" ribbon) and open the **Security Access** tab. It
connects to `somersault_assiduous` with `security_chart` and shows

- a seed → demo algorithm → key pipeline that fills byte by byte,
- a padlock (locked / unlocking / unlocked / locked out), three
  wrong-key dots and a countdown ring for the lockout delay,
- every `27 xx` exchange as a byte strip labelled by ODX parameter,
  negative responses as NRC cards,
- whether `headstand` is currently allowed by the ODX pre-condition,
- the `security_chart` with the transition that actually ran.

All buttons send through the same live session as the Live Virtual ECU
tab, so its CAN trace and transaction log stay in sync.

What is real and what is modeled:

- **REAL:** odxtools encoding/decoding of all telegrams, gating and
  transitions through `odxtools.statemachine.StateMachine` (a rejected
  key is rolled back because the ECU answers negatively), CAN / ISO-TP
  transport.
- **MODELED:** the ECU behaviour and the key algorithm
  `key = rotl32(seed ^ 0x5A5A5A5A, 3)`. This is a **demo algorithm,
  not a real OEM algorithm**. After 3 wrong keys the ECU answers `0x36`
  and then `0x37` for a modeled 10 s delay (cleared by *Reset ECU*). An
  already unlocked ECU returns an all-zero seed (ISO 14229).
