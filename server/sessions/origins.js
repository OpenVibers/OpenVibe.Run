'use strict';

function parseOrigins(raw) {
    if (raw === undefined) return null;
    if (!Array.isArray(raw) || raw.length > 32) throw new Error('origins is a list of at most 32 http(s) origins');
    return raw.map((item) => {
        if (typeof item !== 'string' || item.length > 2048 || /[\s\u0000-\u001f]/.test(item)) throw new Error('invalid origin');
        let u;
        try { u = new URL(item); } catch { throw new Error('invalid origin'); }
        if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password ||
            u.pathname !== '/' || u.search || u.hash || /[^a-z0-9.:[\]-]/i.test(u.hostname)) throw new Error('invalid origin');
        return u.origin;
    });
}

module.exports = { parseOrigins };
