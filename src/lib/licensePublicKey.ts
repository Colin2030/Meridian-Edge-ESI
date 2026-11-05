// Meridian Edge — embedded licence verification public key.
//
// This is the PUBLIC half of the Ed25519 key pair used for commercial
// licensing. Licence files are signed OFFLINE by the "Meridian Edge HQ —
// Licence Manager" application (which holds the matching PRIVATE key) and are
// verified here against this public key. The private key is NEVER present in
// this repository or on the platform server.
//
// Fingerprint (SHA-256 of the SPKI DER, base64):
//   81dtumNMJVxHg+C8U8gn0g2tG9akdLfQsjpXhlz9Sds=
//
// Verification is fully offline (no phone-home), suitable for air-gapped
// deployments.

export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAq/kmlqfa8Gba4EZ+YtRS3Kpf1TxZKl7DsOc/eACbFrc=
-----END PUBLIC KEY-----
`;

// Fingerprint of the embedded key, for display in the admin UI / diagnostics.
export const LICENSE_PUBLIC_KEY_FINGERPRINT = '81dtumNMJVxHg+C8U8gn0g2tG9akdLfQsjpXhlz9Sds=';
