import crypto from 'crypto';

// ============================================================================
// Email conversation threading — derivation helpers (VIEW-ONLY).
// ----------------------------------------------------------------------------
// Threads are derived ENTIRELY from already-imported loadfile metadata: the
// normalised email subject groups messages into a conversation, and Date Sent
// orders them. This adds NO ESI processing, forensic collection, or raw-data
// ingestion capability — it is purely a display grouping so reviewers can follow
// a reply chain.
//
// If a loadfile ever declares explicit thread headers (In-Reply-To, References,
// Message-ID, ConversationIndex/Thread-Index, ConversationID) those are preferred
// opportunistically; the subject-based grouping is the robust baseline and the
// only path the current EDRM/Concordance exports actually exercise.
// ============================================================================

/**
 * Leading reply/forward prefixes to strip, case-insensitively. Covers English and
 * common European variants, optionally bracketed/numbered (e.g. "RE[2]:"). Applied
 * repeatedly so chained prefixes ("Re: Fwd: Re:") collapse to the core subject.
 */
const PREFIX_RE = /^\s*(re|aw|fw|fwd|wg|tr|rv|ref|sv|vs|antw|odp|res|enc)\s*(\[\d+\]|\(\d+\))?\s*:\s*/i;

/**
 * Normalise an email subject for display as a thread label: strip leading
 * reply/forward prefixes (repeatedly), collapse internal whitespace and trim.
 * Preserves the original casing of the core subject.
 */
export function normaliseSubject(subject: string): string {
  let s = (subject || '').replace(/\s+/g, ' ').trim();
  let prev = '';
  while (s && s !== prev) {
    prev = s;
    s = s.replace(PREFIX_RE, '').trim();
  }
  return s;
}

/**
 * Case-insensitive grouping key for a subject. Two messages whose normalised
 * subjects match case-insensitively belong to the same conversation.
 */
export function subjectKey(subject: string): string {
  return normaliseSubject(subject).toLowerCase();
}

/**
 * Deterministic, stable thread id for a (case, normalised-subject-key) pair.
 * Independent of what is already imported, so an email arriving in a later
 * chunked import joins the existing thread. Returns a short hex digest.
 */
export function deriveThreadId(caseId: number, key: string): string {
  return crypto.createHash('sha1').update(`${caseId}\u0000${key}`).digest('hex').slice(0, 32);
}

/**
 * Compute threading fields for one email, given its raw subject. Returns null when
 * the subject is empty after normalisation (don't group subject-less emails into a
 * single mega-thread — leave them unthreaded).
 */
export function deriveThread(caseId: number, rawSubject: string): { threadId: string; threadSubject: string } | null {
  const threadSubject = normaliseSubject(rawSubject);
  if (!threadSubject) return null;
  return { threadId: deriveThreadId(caseId, threadSubject.toLowerCase()), threadSubject };
}
