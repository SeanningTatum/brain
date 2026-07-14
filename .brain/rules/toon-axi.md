# Rule: TOON output + AXI ergonomics

Applies to **all stdout**. Read the `axi` skill for the full standard.

## Do

- **Build lines, then `print()`.** All stdout goes through the TOON encoder (`toonScalar`, `toonString`, `kv`, `toonTable`, `toonList`).
- **End every result with a `help:` list** of concrete next commands. This is contextual disclosure — the tool teaches the next step.
- **Use the two error paths:** `usageError` (exit 2, bad invocation) and `opError` (exit 1, operation failed). Both emit `error:` + a `help:` list showing the *corrected* command.
- **Exit 0 for success and no-ops.** A refused/no-op is not an error — explain the intent in output and exit 0 (e.g. `brain review` refused reopen, `brain ship` on already-shipped feature).
- **Diagnostics, banners, waiting messages, warnings → stderr.**

## Don't

- ❌ `console.log` free text to stdout — corrupts the wire format agents parse.
- ❌ Return a result without a `help:` list.
- ❌ Invent a third error exit code — only 1 (opError) and 2 (usageError).
- ❌ Emit human-prose paragraphs; emit TOON structures (`kv`, tables, lists).

## Quick reference

```
usageError(msg, helpLines)   // exit 2 — user typed it wrong
opError(msg, helpLines)      // exit 1 — the operation itself failed
print(lines)                 // stdout, TOON
console.error(...)           // stderr, diagnostics only
```

`brain` (bare) / `cmdHome` is the master guidance surface — the fullest `help:` in the tool. Keep it the canonical map of what to do next.
