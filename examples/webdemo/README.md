# ODX Diagnostic Workbench (web demo)

A browser UI built directly on the `odxtools` API. See the
"Web demo" section of the top-level `README.md` for the list of tabs.

```bash
pip install .[webdemo]
python3 examples/webdemo/server.py --port 8000   # binds to 127.0.0.1 by default
```

## Security Access (UDS 0x27 seed & key)

The **Security Access** tab (next to *Live Virtual ECU*) shows a
protected service that stays locked until the tester answers the ECU's
seed with the right key.

The bundled somersault PDX has no security services, so they live in a
**demo-only PDX extension**, `examples/somersault_security.pdx`. It is
generated from `examples.somersaultecu.database` (which is deep-copied,
not modified) by

```bash
python3 -m examples.mksomersaultsecuritypdx
```

and adds to `somersault_assiduous`:

| ODX object | Contents |
|---|---|
| `security_request_seed` | `27 01` → `67 01 <seed(4)>` |
| `security_send_key` | `27 02 <key(4)>` → `67 02` |
| negative responses | `0x24 RequestSequenceError`, `0x35 InvalidKey`, `0x36 ExceededNumberOfAttempts`, `0x37 RequiredTimeDelayNotExpired` |
| `security_chart` | states `locked` (start) and `unlocked`; `locked → unlocked` on `security_send_key`, `unlocked → locked` on `session_stop` |
| `headstand` | `PRE-CONDITION-STATE-REF` to `security_chart` / `unlocked` |

What is real and what is modeled:

- **Real:** the requests and responses are encoded and decoded by
  `odxtools`, travel over ISO-TP on a python-can virtual bus, and the
  gating of `headstand` is done by `odxtools.statemachine.StateMachine`
  from the ODX state chart (no server-side special cases). If the ECU
  rejects a key, the server restores the chart state from before the
  request.
- **Modeled:** the ECU side in `virtual_ecu.py` (random seed, an
  all-zero seed while unlocked, attempt counter, and a 10 s delay after
  3 wrong keys during which every `0x27` request gets `0x37`), and the
  key algorithm `key = rotl32(seed ^ 0x5A5A5A5A, 3)`. This is a **demo
  algorithm, not a real OEM algorithm**.

Demo flow: select `somersault_security.pdx`, open *Security Access*,
try `headstand` (blocked), request a seed and send a wrong key
(`0x35`), send two more to start the lockout (`0x36`, then `0x37`
until the countdown ends), then request a seed, compute and send the
key (unlocks, the `locked → unlocked` transition is highlighted), try
`headstand` again (allowed) and end the session (`session_stop`
relocks). Every request goes through the Live ECU tester, so its
transaction log and CAN trace show the same exchanges.
