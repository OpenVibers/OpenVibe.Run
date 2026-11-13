'use strict';
/**
 * The checks scheduler's secrets at rest (research-2026-11-13/shared-node-checks.md, safety): the GitHub
 * App's private key, its webhook secret, its client secret and every installation access token are sealed
 * with AES-256-GCM under RUN_SECRETS_KEY before they reach a row. Nothing in this module logs a value.
 *
 * RUN_SECRETS_KEY is one 32-byte key, base64 (standard or URL-safe) or 64 hex characters. A missing or
 * malformed key is not fatal at boot: the App page says encryption is not installed and the webhook, which
 * cannot verify a signature without its secret, answers 503. The envelope is
 *
 *   ovc1.<iv base64url>.<tag base64url>.<ciphertext base64url>
 *
 * with the additional data `run.checks|<purpose>`, so a ciphertext sealed for one App field cannot be
 * opened as another (or as an installation token).
 */
const crypto = require('crypto');

const PREFIX = 'ovc1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The 32-byte key from RUN_SECRETS_KEY, or null when unset/not exactly 32 bytes. Never throws with the value. */
function keyOf(raw) {
    if (raw == null || raw === '') return null;
    const text = String(raw).trim();
    if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
    if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) {
        const bytes = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        return bytes.length === KEY_BYTES ? bytes : null;
    }
    return null;
}

const aadOf = (purpose) => Buffer.from(`run.checks|${String(purpose)}`, 'utf8');

/** Seal one string. → the envelope text. Throws when the key is missing or malformed. */
function seal(key, value, purpose) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new TypeError('checks.crypto: a 32-byte key is required');
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aadOf(purpose));
    const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return [PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/** Open one envelope. Throws a stable error (never the plaintext) when it is foreign, truncated or tampered with. */
function open(key, envelope, purpose) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('checks.crypto: a 32-byte key is required');
    const parts = String(envelope || '').split('.');
    if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error('checks.crypto: not a sealed checks value');
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const body = Buffer.from(parts[3], 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('checks.crypto: malformed envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aadOf(purpose));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

module.exports = { keyOf, seal, open, KEY_BYTES, PREFIX };
