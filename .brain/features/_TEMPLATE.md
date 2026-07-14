# Feature: <Name>

_Last updated: YYYY-MM-DD_

## Purpose
One paragraph. What this feature does and why it exists.

## When It's Used
- User trigger / entry point
- Lifecycle event (load, mount, relaunch)
- Cross-feature interaction

## How It Works
Narrative description of the runtime flow: which module / service / route owns state, what calls what, where persistence happens, where errors map.

### Persistence details
- Storage location (table, blob prefix, cache namespace, file path)
- Schema / envelope shape
- Write semantics (debounce, sync, batch)
- Migration / corruption behavior

### Testability
What is unit-tested vs e2e-tested. Stubs/mocks used. Edge cases covered.

## Key Files

| File | Role |
|------|------|
| `<path>` | `<role — data access, route/API, schema, UI, test, …>` |

## Dependencies
- Services / modules consumed
- Other data-access layers called
- External SDKs / bindings
- UI primitives / hooks

## Errors
List the error types this feature raises and how they surface (HTTP code, UI state).

| Error | Where raised | Surfaces as |
|-------|--------------|-------------|
| `NotFoundError` | `<where>` | 404 |
| `ValidationError` | `<where>` | 400 |

## Changelog

| Date | Type | Description |
|------|------|-------------|
| YYYY-MM-DD | feature \| bugfix \| refactor | Short summary |
