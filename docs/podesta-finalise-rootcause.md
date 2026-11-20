# Root cause — Podesta batch finalise failure (batch a4e9358f)

**Prepared for:** Colin / Dan
**Date:** 2026-11-20
**Verdict:** Colin's instinct is correct. This is an **infrastructure limit on the hosted
PostgreSQL server**, triggered by a connection-handling pattern in the finalise step that is
harmless on an ordinary Postgres but fatal on the managed (evaluation) database. It is **not** a
problem with anything Dan sent, and not a bug in the items themselves.

---

## 1. What actually killed the batch

The failure record is a verbatim PostgreSQL message:

```
terminating connection due to idle-session timeout
```

That string comes from PostgreSQL's **`idle_session_timeout`** setting — the server closes any
connection that sits idle *outside a transaction* for longer than the configured window. I queried
the live hosted database directly and confirmed the managed server's settings:

| Setting | Value on the hosted eval DB |
|---|---|
| `idle_session_timeout` | **2 minutes** |
| `idle_in_transaction_session_timeout` | 30 seconds |
| `statement_timeout` | 5 seconds |

These are **set by the managed database platform, not by Meridian Edge.** The application cannot
change them as its normal role. So the connection wasn't closed by the app or by Dan — it was
reaped by the hosted database because it had been idle for more than two minutes.

## 2. Why finalise trips it (the mechanism)

Finalise runs the **rendering** phase as a long sequence of *short* database writes, with
**CPU-bound image rendering happening in between** them:

- For each document, `finaliseBatch()` calls `renderImageToPages()`, which shells out to
  `pdftoppm` / `convert` **synchronously** (`execFileSync`) to rasterise pages at 120 dpi — one
  image at a time, single-threaded.
- Between those renders it issues discrete pooled queries (`DELETE`/`INSERT` into `document_pages`,
  `UPDATE documents`).

The pooled connection is returned to the pool and sits **idle while the next page image renders.**
On a small shared VM (2 vCPU, no GPU), rasterising a large page can easily take longer than the
**2-minute** idle window — at which point the hosted server kills the idle connection. The very
next `db.query()` on that dead connection throws, and `startFinalise()` has a bare
`.catch()` that immediately records `{"code":"finalise_error", ...}` and flips the batch to
`failed`. **There is no retry** — one transient reap ends the whole batch.

Two contributing factors in the current build:

- The pg Pool has **no `keepAlive`** set, so there's no TCP keepalive to keep an idle session
  marked active.
- Finalise holds/releases the shared pool across long CPU work instead of acquiring a connection
  only for the brief writes.

## 3. Answers to Dan's three questions

**1. Is there an idle-session timeout, and what is it tied to?**
Yes — **2 minutes**, enforced by the hosted PostgreSQL server (managed infrastructure), not by
Meridian Edge. It is tied to **how long a pooled connection sits idle between statements**, not to
batch size directly. Big batches hit it because finalise runs long enough, with enough slow render
gaps, that a connection eventually sits idle past 2 minutes.

**2. Recommended maximum batch size for an eval account?**
There is no hard application cap; the real limit is the infrastructure's idle reaper. Dan's plan —
**≤500 items per batch, sent and committed sequentially** — is exactly right. Smaller batches keep
each finalise short enough that a connection rarely sits idle past the 2-minute window, and
sequential commits stay well under the hosted DB's 25-connection ceiling. ~500 items is a safe
working size on the eval instance.

**3. Is 190 pages in 3.5 hours expected?**
No — that is *not* representative rendering throughput. But rendering was **not given** 3.5 hours.
The job spent most of the window in the earlier phases (storing ~10k files, indexing ~3.5k items)
before rendering even started, and rendering is single-threaded CPU work on a small shared VM. It
got only a short tail of the window before the connection was reaped. The slow box is a
*contributing* constraint on throughput, but the **thing that stopped the batch was the 2-minute
idle reap, not rendering speed.**

## 4. Bottom line

Colin is right: the root cause is the **hosted database's 2-minute idle-session timeout**,
exposed by finalise holding a pooled connection idle across slow single-threaded rendering, with no
retry. Dan's smaller-batch, sequential workaround is sound and will work in the meantime.

## 5. Durable fix (optional — not done yet)

The infra limit can be made harmless with an application change, e.g.:

- Acquire a DB connection **only for the brief writes**, not across the CPU-bound render; or add
  `keepAlive: true` plus a lightweight keepalive query during long renders.
- Make `startFinalise()` **retry / reconnect** on a dropped connection instead of marking `failed`
  immediately. Finalise is already idempotent and there's already boot reconciliation
  (`reconcileBatchesOnBoot` re-finalises batches stuck in `committing`), so retry is low-risk.

These are code changes I can implement on request; this turn is diagnosis only.
