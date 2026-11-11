# Phase 4 — Remontoire web UI surfacing: verification evidence

Verified on the dev server (PORT 4199, `.env.dev`, `meridian_dev` DB), signed in as
`phase3-owner` (system administrator / owning case manager). Seed case **id 10 — "Phase 4 UI
verification"** contains a translated document, a thread of three, a family with an attachment,
an item with a native + review image, a batch (completed with failures), one integrator audit
entry with a downloadable report, and a platform import event.

## 1 · Translation switcher (ORIGINAL by default, switchable)
Text tab defaults to **DE · Original** (German body); dropdown lists both versions and switches
to **EN · Translation (from DE) · machine** (English body) with a "Translation" badge.

![Original DE shown by default](/home/ubuntu/screenshots/screenshot_1794423044374.png)
![Switched to EN translation](/home/ubuntu/screenshots/screenshot_1794423059343.png)

## 2 · Thread ordered by position, with a count
Conversation panel shows a **"3 messages"** count, DOC-0001 → DOC-0002 → DOC-0003 in position
order, footer "Ordered by position in the thread."

![Thread of three with count](/home/ubuntu/screenshots/screenshot_1794423027867.png)

## 3 · Family (parent + attachments)
Family panel on DOC-0001 shows **"1 attachment"** — invoice-scan.pdf (pdf).

![Family parent + attachment](/home/ubuntu/screenshots/screenshot_1794423036682.png)

## 4 · Native download + review image display
DOC-0004 renders its review image (Page 1/1) for viewing and offers **Download native**
showing the declared type `application/pdf`. Native, image and audit-attachment downloads all
return HTTP 200 with correct Content-Type and Content-Disposition (verified via curl).

![Review image + native download](/home/ubuntu/screenshots/screenshot_1794423069439.png)

## 5 · Unfound-parent flag
DOC-0005 (parent control number DOC-9999, absent) shows the amber flag: "This item references
a parent (DOC-9999) that was not found in this case."

![Unfound-parent flag](/home/ubuntu/screenshots/screenshot_1794423087163.png)

## 6 · Case history — platform events + integrator audit entry with downloadable report
Combined timeline: **Platform** `import.completed` ("Load-file import completed: 10 documents.")
alongside the **Integrator** `remontoire.scan.completed` (source Remontoire v2.3.0, run-4242)
with a downloadable **remontoire-scan-report.txt (75 B)**.

![Case history + downloadable report](/home/ubuntu/screenshots/screenshot_1794423101554.png)

## 7 · Verification counts + progress phases
Batch card shows per-phase progress bars (Receiving…Finalising, done/total/state), verification
counts (pages / images / natives / threads / families / text indexed / items created-updated-received)
and the failures list (DOC-BAD-01 — native blob hash mismatch).

![Verification counts + progress](/home/ubuntu/screenshots/screenshot_1794423093241.png)

## 8 · Delete & archive controls (confirm-guarded, 7-day retention, filterable)
Archive confirm modal → archived success banner (Un-archive available). Dashboard hides archived
cases by default; "Show archived" reveals the case with an "Archived" badge and dashed/greyed
card. Delete-document confirm modal states the 7-day retention/restore window.

![Archive confirmation](/home/ubuntu/screenshots/screenshot_1794423114699.png)
![Archived success](/home/ubuntu/screenshots/screenshot_1794423122595.png)
![Dashboard archived card, filterable](/home/ubuntu/screenshots/screenshot_1794423139562.png)
![Delete confirm with 7-day retention hint](/home/ubuntu/screenshots/screenshot_1794423175316.png)
