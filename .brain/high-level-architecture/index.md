# High-Level Architecture — Index

System-level docs. Conceptual diagrams, runtime model, data flow, security posture, third-party surface area. **Read these before designing a feature** — they establish the "what runs where" mental model.

> **Base template.** Add one file per macro concern. Delete this note when populated.

## Files

| File | Covers | Read when |
|------|--------|-----------|
| `architecture.md` | System layers, data flow, layer responsibilities | Designing any new feature; touching the request lifecycle |
| `data-models.md` | Entity diagrams, table schemas, migrations | Adding a table, FK, or migration |
| `security.md` | Auth flow, session management, RBAC, input validation, secrets | Anything touching auth, permissions, secrets, or PII |
| `integrations.md` | External services, bindings, third-party SDKs | Wiring a new external service |
| `user-journeys.md` | Key end-to-end flows (signup, login, core actions) | Building UI flows; verifying gates |

## Quick mental model

```
<one-block diagram: Client → server → data stores>
```

> Replace with a 3–5 line ASCII picture of where a request goes. This is the single most-referenced thing in the folder.

## Important things to look at

- `architecture.md` data flow diagram — single source for "where does a request go"
- `data-models.md` entity relationships — every new table extends this graph
- `integrations.md` external-service table — what's wired and how

## Update triggers

- Add/remove a top-level service or store → `architecture.md` + `integrations.md`
- Add/rename a table → `data-models.md`
- Change auth/RBAC/session → `security.md` + `user-journeys.md`
- Add new third-party SDK → `integrations.md`
