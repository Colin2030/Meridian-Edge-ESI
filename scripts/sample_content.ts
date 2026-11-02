// Synthetic, clearly-fictional investigation dataset for the demo case.
// "Operation Northwind" — a fictional inquiry into suspected procurement fraud at
// the fictional firm "Harwick Logistics Ltd". No real persons or data.

export interface SampleDoc {
  control: string;      // control / Bates number
  native: 'tiff' | 'pdf';
  date: string;         // YYYY-MM-DD
  from: string;
  to: string;
  subject: string;
  author: string;
  type: string;         // Email / Memo / Invoice / Interview Note
  filename: string;
  custodian: string;
  begAttach?: string;
  endAttach?: string;
  body: string;
}

const P = (s: string) => s.trim();

export const SAMPLE_DOCS: SampleDoc[] = [
  { control: 'NW-000001', native: 'pdf', date: '2023-02-14', from: 'r.hale@harwick-logistics.example', to: 'd.okoro@harwick-logistics.example', subject: 'Preferred supplier shortlist', author: 'Rebecca Hale', type: 'Email', filename: 'preferred_supplier.eml', custodian: 'R. Hale', begAttach: 'NW-000001', endAttach: 'NW-000002',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

From: Rebecca Hale <r.hale@harwick-logistics.example>
To: Daniel Okoro <d.okoro@harwick-logistics.example>
Date: 14 February 2023
Subject: Preferred supplier shortlist

Daniel,

Further to the board's cost-review, I've drawn up a shortlist of haulage subcontractors for the Northwind distribution contract. Meridian Freight came in materially above the others but their service record is strong.

I'd like to put Meridian forward as preferred supplier. Can we discuss the evaluation criteria before Friday? I want the paperwork to be defensible.

Regards,
Rebecca`) },

  { control: 'NW-000002', native: 'pdf', date: '2023-02-14', from: 'Harwick Logistics Ltd', to: 'Procurement File', subject: 'Supplier evaluation matrix (attachment)', author: 'Rebecca Hale', type: 'Memo', filename: 'evaluation_matrix.pdf', custodian: 'R. Hale',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

HARWICK LOGISTICS LTD — SUPPLIER EVALUATION MATRIX
Contract: Northwind Distribution (ref NW-2023)

Supplier            Price   Service   Compliance   Weighted
Meridian Freight     4/10     9/10        8/10        7.1
Castle Haulage       8/10     7/10        7/10        7.3
Pennine Transport    7/10     6/10        6/10        6.2

Note (R. Hale): recommend Meridian on service grounds despite price.
Reviewed by procurement. Pending director sign-off.`) },

  { control: 'NW-000003', native: 'tiff', date: '2023-03-02', from: 'd.okoro@harwick-logistics.example', to: 'r.hale@harwick-logistics.example', subject: 'RE: Preferred supplier shortlist', author: 'Daniel Okoro', type: 'Email', filename: 'reply_shortlist.eml', custodian: 'D. Okoro',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

From: Daniel Okoro
To: Rebecca Hale
Date: 2 March 2023
Subject: RE: Preferred supplier shortlist

Rebecca,

I'm uncomfortable signing this off. Meridian is 40% above Castle on price and the weighted scores barely separate them. If this is queried later we'll struggle to justify it.

Before I approve, I want the service scores evidenced. Who completed the service assessment?

Daniel`) },

  { control: 'NW-000004', native: 'tiff', date: '2023-03-06', from: 'r.hale@harwick-logistics.example', to: 'g.fenwick@meridian-freight.example', subject: 'Quick call', author: 'Rebecca Hale', type: 'Email', filename: 'quick_call.eml', custodian: 'R. Hale',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

From: Rebecca Hale
To: Greg Fenwick <g.fenwick@meridian-freight.example>
Date: 6 March 2023
Subject: Quick call

Greg,

Can you call my mobile this evening rather than the office line? There's some internal pushback on the award and I'd rather talk it through directly.

Also — the consultancy invoice we discussed, please address it to the Northwind project code, not to procurement.

R`) },

  { control: 'NW-000005', native: 'pdf', date: '2023-03-20', from: 'Meridian Freight Ltd', to: 'Harwick Logistics Ltd', subject: 'Invoice MF-4471 — advisory services', author: 'Accounts', type: 'Invoice', filename: 'invoice_MF-4471.pdf', custodian: 'Finance',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

MERIDIAN FREIGHT LTD
INVOICE  MF-4471
Date: 20 March 2023
Bill to: Harwick Logistics Ltd, Northwind Project (NW-2023)

Description                              Amount
Advisory & mobilisation services        GBP 18,500.00
Expenses                                 GBP  1,250.00
--------------------------------------------------
Total due                                GBP 19,750.00

Payment terms: 7 days. Please remit to account ending 4402.
Ref: as agreed with R.H.`) },

  { control: 'NW-000006', native: 'tiff', date: '2023-03-22', from: 'a.price@harwick-logistics.example', to: 'r.hale@harwick-logistics.example', subject: 'Query on MF-4471', author: 'Aisha Price', type: 'Email', filename: 'query_invoice.eml', custodian: 'A. Price',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

From: Aisha Price (Finance)
To: Rebecca Hale
Date: 22 March 2023
Subject: Query on MF-4471

Rebecca,

Finance has an invoice from Meridian for GBP 19,750 described as "advisory & mobilisation". We have no purchase order and no statement of work on file. Can you send the SOW so I can process it?

Thanks,
Aisha`) },

  { control: 'NW-000007', native: 'tiff', date: '2023-03-23', from: 'r.hale@harwick-logistics.example', to: 'a.price@harwick-logistics.example', subject: 'RE: Query on MF-4471', author: 'Rebecca Hale', type: 'Email', filename: 'reply_query.eml', custodian: 'A. Price',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

From: Rebecca Hale
To: Aisha Price
Date: 23 March 2023
Subject: RE: Query on MF-4471

Aisha,

The advisory work was agreed verbally during mobilisation. Please process it against the Northwind code and I'll backfill the paperwork. It's time-sensitive — Greg has been very accommodating on the main contract and I don't want to hold up his payment.

Rebecca`) },

  { control: 'NW-000008', native: 'pdf', date: '2023-04-01', from: 'Harwick Logistics Ltd', to: 'Board', subject: 'Award recommendation — Northwind', author: 'Rebecca Hale', type: 'Memo', filename: 'award_recommendation.pdf', custodian: 'R. Hale',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

MEMORANDUM
To: Procurement Board
From: R. Hale
Date: 1 April 2023
Re: Award recommendation — Northwind Distribution

I recommend award to Meridian Freight Ltd on the basis of superior service capability. While not the lowest priced bid, Meridian offers mobilisation support that de-risks the transition.

I confirm I have no personal interest in the supplier and that the evaluation was conducted impartially.

Signed: R. Hale`) },

  { control: 'NW-000009', native: 'tiff', date: '2023-05-11', from: 'g.fenwick@meridian-freight.example', to: 'r.hale@harwick-logistics.example', subject: 'Thanks', author: 'Greg Fenwick', type: 'Email', filename: 'thanks.eml', custodian: 'R. Hale',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

From: Greg Fenwick
To: Rebecca Hale
Date: 11 May 2023
Subject: Thanks

Rebecca,

Appreciated your help getting this over the line. The "advisory" invoice has cleared. As discussed, the kitchen work at your place is booked for the 24th — the lads will sort it, no charge to you.

Say nothing to Daniel.

Greg`) },

  { control: 'NW-000010', native: 'pdf', date: '2023-06-02', from: 'Harwick Logistics Ltd', to: 'File', subject: 'Internal audit note — procurement anomalies', author: 'Internal Audit', type: 'Memo', filename: 'audit_note.pdf', custodian: 'Audit',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

INTERNAL AUDIT — WORKING NOTE (CONFIDENTIAL)
Date: 2 June 2023
Subject: Northwind procurement anomalies

1. Winning bid priced ~40% above nearest competitor; justification relies on unevidenced service scores.
2. Advisory invoice MF-4471 paid with no PO or SOW.
3. Single point of contact (R. Hale) across evaluation, award and payment — no segregation of duties.
4. Verbal approvals referenced repeatedly.

Recommendation: escalate to compliance. Potential conflict of interest.`) },

  { control: 'NW-000011', native: 'tiff', date: '2023-06-15', from: 'compliance@harwick-logistics.example', to: 'ceo@harwick-logistics.example', subject: 'Escalation — Northwind', author: 'Compliance', type: 'Email', filename: 'escalation.eml', custodian: 'Compliance',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

From: Compliance
To: CEO
Date: 15 June 2023
Subject: Escalation — Northwind

Following internal audit's note we have suspended payments to Meridian Freight pending review. We recommend notifying external counsel and preserving all correspondence for R. Hale and the procurement mailbox.

Please treat as confidential.`) },

  { control: 'NW-000012', native: 'pdf', date: '2023-07-01', from: 'Investigator', to: 'File', subject: 'Interview note — A. Price', author: 'DS Lambert', type: 'Interview Note', filename: 'interview_price.pdf', custodian: 'Investigation',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

INTERVIEW NOTE
Witness: Aisha Price (Finance)
Conducted by: DS Lambert
Date: 1 July 2023

Ms Price stated she raised concerns about invoice MF-4471 in March 2023 because it lacked a purchase order and statement of work. She was instructed by Ms Hale to process it against the Northwind code and that paperwork would follow. No statement of work was ever provided. Ms Price retained the email chain.`) },

  { control: 'NW-000013', native: 'tiff', date: '2023-07-03', from: 'Investigator', to: 'File', subject: 'Interview note — D. Okoro', author: 'DS Lambert', type: 'Interview Note', filename: 'interview_okoro.tiff', custodian: 'Investigation',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

INTERVIEW NOTE
Witness: Daniel Okoro (Procurement Director)
Conducted by: DS Lambert
Date: 3 July 2023

Mr Okoro recalled objecting in March 2023 to the price differential on the Meridian award and asking for the service scores to be evidenced. He said he did not ultimately see the evidence but understood the award proceeded. He was unaware of the advisory invoice and of any works carried out at Ms Hale's home address.`) },

  { control: 'NW-000014', native: 'pdf', date: '2023-07-10', from: 'Bank', to: 'Investigation', subject: 'Account statement extract — ending 4402', author: 'Disclosure', type: 'Invoice', filename: 'bank_extract.pdf', custodian: 'Investigation',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

ACCOUNT STATEMENT EXTRACT (REDACTED) — account ending 4402
Holder: Meridian Freight Ltd

Date        Description                 Credit/Debit
25/03/2023  Harwick Logistics NW-2023   + GBP 19,750.00
26/05/2023  "Kitchen supplies — RH"     -  GBP  6,400.00
02/06/2023  Cash withdrawal             -  GBP  5,000.00

Produced under disclosure. Fictional illustrative figures.`) },

  { control: 'NW-000015', native: 'tiff', date: '2023-07-18', from: 'r.hale@harwick-logistics.example', to: 'g.fenwick@meridian-freight.example', subject: 'Delete', author: 'Rebecca Hale', type: 'Email', filename: 'delete.eml', custodian: 'R. Hale',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

From: Rebecca Hale
To: Greg Fenwick
Date: 18 July 2023
Subject: Delete

Greg — compliance are asking questions. Delete the messages about the kitchen and the advisory invoice. Use my personal number from now on. Do NOT put anything in writing.

R`) },

  { control: 'NW-000016', native: 'pdf', date: '2023-08-02', from: 'Harwick Logistics Ltd', to: 'Investigation', subject: 'HR file note — R. Hale (gifts register)', author: 'HR', type: 'Memo', filename: 'gifts_register.pdf', custodian: 'HR',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

GIFTS & HOSPITALITY REGISTER — EXTRACT
Employee: R. Hale

No entries recorded for the period Jan–Jul 2023.

HR note: Company policy requires declaration of any gift or hospitality over GBP 50. No declaration relating to Meridian Freight or G. Fenwick is on file.`) },

  { control: 'NW-000017', native: 'tiff', date: '2023-08-09', from: 'g.fenwick@meridian-freight.example', to: 'accounts@meridian-freight.example', subject: 'Reclassify', author: 'Greg Fenwick', type: 'Email', filename: 'reclassify.eml', custodian: 'Meridian (disclosure)',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

From: Greg Fenwick
To: Accounts
Date: 9 August 2023
Subject: Reclassify

Please reclassify the 26 May payment as "marketing — client entertainment". Do not reference any individual. If anyone asks, it was a trade show stand.

Greg`) },

  { control: 'NW-000018', native: 'pdf', date: '2023-09-01', from: 'Investigator', to: 'File', subject: 'Case summary — Operation Northwind', author: 'DI Carver', type: 'Memo', filename: 'case_summary.pdf', custodian: 'Investigation',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

CASE SUMMARY — OPERATION NORTHWIND (FICTIONAL)
Prepared by: DI Carver   Date: 1 September 2023

The evidence indicates a suspected arrangement whereby a procurement manager (R. Hale) steered a distribution contract to Meridian Freight Ltd in exchange for an undeclared benefit (home refurbishment). Supporting items: evaluation irregularities (NW-000002), an unsupported advisory invoice (NW-000005), admissions of benefit (NW-000009), instructions to destroy evidence (NW-000015), and corroborating financial records (NW-000014).

Next steps: interview R. Hale under caution; obtain full Meridian disclosure; forensic review of personal devices.

All names, figures and entities are fictional.`) },

  { control: 'NW-000019', native: 'tiff', date: '2023-09-14', from: 'legal@harwick-logistics.example', to: 'ceo@harwick-logistics.example', subject: 'Privileged — legal advice on Northwind', author: 'General Counsel', type: 'Memo', filename: 'legal_advice.tiff', custodian: 'Legal',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

PRIVILEGED & CONFIDENTIAL — LEGAL ADVICE
From: General Counsel
To: CEO
Date: 14 September 2023

This note sets out our advice on the company's exposure arising from the Northwind procurement and the steps required to preserve privilege. [Marked to demonstrate the 'privileged' review state in the demo.]

This is a fictional document for training purposes.`) },

  { control: 'NW-000020', native: 'pdf', date: '2023-09-20', from: 'Investigator', to: 'File', subject: 'Exhibit list — Operation Northwind', author: 'DS Lambert', type: 'Memo', filename: 'exhibit_list.pdf', custodian: 'Investigation',
    body: P(`FICTIONAL EVIDENCE ITEM — TRAINING DATA ONLY

EXHIBIT LIST (FICTIONAL)
Operation Northwind

NW-000001/2  Supplier shortlist + evaluation matrix
NW-000005    Advisory invoice MF-4471
NW-000009    "Kitchen" email
NW-000014    Bank extract (acct 4402)
NW-000015    "Delete" email
NW-000018    Case summary

Prepared for disclosure review. All content fictional.`) },
];
