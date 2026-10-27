'use strict';
// 12-word passphrase helpers (DESIGN.md §6.1). Words come from the BIP-39 list purely as a source
// of memorable, high-entropy words — this is a passphrase, not a BIP-39 wallet seed.
window.Passphrase = (function () {
    const WORDS = window.BIP39;
    const COUNT = 12;

    // 2048 is a power of two that divides 2^32, so `x % 2048` on a uint32 has no modulo bias.
    function generate() {
        const idx = new Uint32Array(COUNT);
        crypto.getRandomValues(idx);
        const out = [];
        for (let i = 0; i < COUNT; i++) {
            out.push(WORDS[idx[i] % WORDS.length]);
        }
        return out.join(' ');
    }

    // Canonical form fed to the key derivation: trimmed, lowercased, single-spaced. Generation and entry
    // both go through this, so a phrase always maps to the same bytes.
    function canonical(phrase) {
        return (phrase || '').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
    }

    function wordCount(phrase) {
        const c = canonical(phrase);
        return c ? c.split(' ').length : 0;
    }

    // Checks a phrase the user is choosing (create / import / change password): exactly 12 words, all
    // from the dictionary. Returns an error message, or null if it is fine. Opening a file is not
    // checked this way — older documents may be sealed under phrases chosen before this rule.
    const WORD_SET = new Set(WORDS);
    function validate(phrase) {
        const c = canonical(phrase);
        const words = c ? c.split(' ') : [];
        if (words.length !== COUNT) {
            return 'Exactly ' + COUNT + ' dictionary words are needed (now ' + words.length + '). '
                + 'Click Generate to get a strong phrase.';
        }
        const unknown = words.filter(function (w) { return !WORD_SET.has(w); });
        if (unknown.length) {
            return 'Not in the BIP-39 wordlist: ' + unknown.join(', ') + '.';
        }
        return null;
    }

    return { generate, canonical, wordCount, validate };
})();
