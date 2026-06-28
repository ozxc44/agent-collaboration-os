# Dependency Audit Triage (Batch 8)

## Status

- **sqlite3 removed:** `sqlite3` has been removed from `backend/package.json`. The test-time in-memory database now uses `better-sqlite3` (driver `type: 'better-sqlite3'` in `src/data-source.ts`).
- **Previous high-severity chain eliminated:** The 6 high-severity vulnerabilities rooted in `sqlite3@5.1.7` transitive build dependencies (`tar`, `cacache`, `make-fetch-happen`, `node-gyp`) are no longer present in the dependency tree.
- **Remaining audit findings:** `npm audit --audit-level=high` reports **0 high-severity vulnerabilities**.

## What was fixed

| Package | Old | New | Severity | CVE / Advisory |
|---------|-----|-----|----------|----------------|
| `uuid`  | `^10.0.0` | `^11.1.1` | moderate | GHSA-w5hq-g745-h8pq |
| `sqlite3` | `^5.1.7` | **removed** | high (transitive chain) | GHSA-34x7-hfp2-rc4v, GHSA-8qq5-rm4j-mr97, GHSA-83g3-92jg-28cx, GHSA-qffp-2rhf-9h96, GHSA-9ppj-qmqm-q256, GHSA-r6q2-hw4h-h46w |

`uuid` usage in the codebase is limited to `import { v4 as uuidv4 } from 'uuid'`. Version 11.x retains CommonJS support and is API-compatible for this use case. All verification passed.

`better-sqlite3@^12.10.0` was already present in `backend/package.json` and is used for the test-time in-memory database. No production runtime behavior changes.

## Remaining risk chain

**Resolved.** The previous `sqlite3@5.1.7` rooted high-severity chain has been eliminated by migrating the test driver to `better-sqlite3` and removing `sqlite3` from dependencies.

## Vulnerabilities in the chain

**Resolved.** All previously listed high-severity and low-severity vulnerabilities in the `sqlite3` transitive chain (`tar`, `cacache`, `make-fetch-happen`, `node-gyp`, `@tootallnate/once`, `http-proxy-agent`) are no longer present after `sqlite3` removal.

## Available fix path

- The preferred migration (migrate tests to `better-sqlite3` and remove `sqlite3`) is **complete**.
- No further action is required for the `sqlite3` high-severity chain.

## Recommended next steps

1. **Monitor future audit findings.** If new high-severity vulnerabilities appear in unrelated packages, triage and fix in subsequent batches.
2. **No further `sqlite3` work needed.** The dependency has been fully removed from `backend/package.json` and the lockfile.

## Verification performed

- `cd backend && npm install` (after removing `sqlite3`) → exit 0, 0 vulnerabilities reported
- `cd backend && npm run typecheck` → exit 0
- `cd backend && npm run build` → exit 0
- `cd backend && npm test` → exit 0 (all tests passed)
- `cd backend && npm audit --audit-level=high --json > /tmp/batch8-better-sqlite3-audit.json` → exit 0 (audit command reports 0 high findings)
- `cd backend && npm ls better-sqlite3 sqlite3 typeorm --depth=1` → confirms `better-sqlite3` and `typeorm` present, `sqlite3` absent
