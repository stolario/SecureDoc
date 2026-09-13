'use strict';
// The .sdoc format and its encryption, entirely in the browser (DESIGN.md §5, §6). Byte-compatible
// with the Java implementation this replaced, so documents written before still open — the samples in
// testdata/ check that (DESIGN.md §6.6). The passphrase and plaintext never leave this page.
//
//   file      = "SDOC" | version(1 byte) | headerLen(int32 BE) | header(JSON) | body
//   header    = {"kdf":{"algo":"argon2id","salt","memoryKiB","iterations","parallelism"},"wrappedDek"}
//   KEK       = Argon2id(NFKD(passphrase) as UTF-8, kdf) — 32 bytes
//   wrappedDek= AES-256-GCM(KEK, DEK, aad = "SDOC-KEK|v1|<salt b64>|<mem>|<iter>|<par>")
//   body      = AES-256-GCM(DEK, container ZIP, aad = "SDOC-BODY|v1")
//   container = ZIP (zip.js): manifest.json + content.html (DEFLATED), media/<id> (STORED)
// Each AES-GCM output is nonce(12) || ciphertext || tag(16).
window.Sdoc = (function () {
    const MAGIC = [0x53, 0x44, 0x4f, 0x43]; // "SDOC"
    const FORMAT_VERSION = 1;
    const SCHEMA_VERSION = 1;
    const MAX_HEADER_BYTES = 1000000;
    const NONCE_LENGTH = 12;
    const TAG_LENGTH = 16;
    const KEY_LENGTH = 32;

    // Argon2id profile for new documents (64 MiB, 3 passes, 1 lane; OWASP-appropriate).
    const DEFAULT_KDF = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 };
    const SALT_LENGTH = 16;
    // Limits for parameters read from an untrusted header: a crafted file must not make Argon2
    // allocate gigabytes or run for minutes.
    const MAX_MEMORY_KIB = 256 * 1024;
    const MAX_ITERATIONS = 16;
    const MAX_PARALLELISM = 16;
    const MIN_SALT_LENGTH = 8;
    const MAX_SALT_LENGTH = 64;

    const utf8 = new TextEncoder();
    const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

    /** code: 'wrong_password' | 'invalid_file' */
    function SdocError(code, message) {
        const e = new Error(message);
        e.name = 'SdocError';
        e.code = code;
        return e;
    }
    function invalid(message) {
        return SdocError('invalid_file', 'damaged .sdoc file: ' + message);
    }

    // ── byte helpers ──

    function randomBytes(n) {
        return crypto.getRandomValues(new Uint8Array(n));
    }

    function concat(parts) {
        let len = 0;
        parts.forEach(function (p) { len += p.length; });
        const out = new Uint8Array(len);
        let off = 0;
        parts.forEach(function (p) { out.set(p, off); off += p.length; });
        return out;
    }

    function toBase64(bytes) {
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(bin);
    }

    function fromBase64(b64, field) {
        let bin;
        try {
            bin = atob(b64);
        } catch (_) {
            throw invalid('bad base64 in ' + field);
        }
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    // Argon2 runs synchronously inside WASM and freezes the page for a second or two; let the busy
    // message paint first. A hidden tab never runs animation frames, so a timer backs it up — a save
    // started just before switching tabs must not hang.
    function nextPaint() {
        return new Promise(function (resolve) {
            requestAnimationFrame(function () { setTimeout(resolve, 0); });
            setTimeout(resolve, 100);
        });
    }

    // ── key derivation ──
    // Argon2 runs in a worker (kdf-worker.js), so the page stays responsive meanwhile. Where a worker
    // can't start — the page opened from disk (file://) in Chrome — it runs in the page, as before.

    const WORKER_URL = document.currentScript ? new URL('kdf-worker.js', document.currentScript.src).href : null;
    let worker = null;          // created on first use; false once it proved unusable
    const jobs = new Map();     // job id -> { resolve, reject }
    let nextJobId = 0;

    function workerLost() {
        const e = new Error('the key derivation worker is unavailable');
        e.workerLost = true;
        return e;
    }

    function kdfWorker() {
        if (worker === null) {
            try {
                if (!WORKER_URL || typeof Worker !== 'function') throw workerLost();
                worker = new Worker(WORKER_URL);
            } catch (_) {
                worker = false;
                return null;
            }
            worker.onmessage = function (e) {
                const job = jobs.get(e.data.id);
                if (!job) return;
                jobs.delete(e.data.id);
                if (e.data.error) job.reject(new Error(e.data.error));
                else job.resolve(e.data.key);
            };
            // A script that failed to load (or a crashed worker): drop it, fail its jobs over to the page.
            worker.onerror = function (e) {
                e.preventDefault();
                worker.terminate();
                worker = false;
                const lost = Array.from(jobs.values());
                jobs.clear();
                lost.forEach(function (job) { job.reject(workerLost()); });
            };
        }
        return worker || null;
    }

    function deriveInWorker(w, passphrase, kdf) {
        return new Promise(function (resolve, reject) {
            const id = ++nextJobId;
            jobs.set(id, { resolve: resolve, reject: reject });
            const pwd = utf8.encode(passphrase.normalize('NFKD'));
            // The password bytes are transferred (and zeroed in the worker), not copied.
            w.postMessage({ id: id, password: pwd, salt: kdf.salt, memoryKiB: kdf.memoryKiB,
                iterations: kdf.iterations, parallelism: kdf.parallelism, hashLength: KEY_LENGTH },
                [pwd.buffer]);
        });
    }

    /** -> raw KEK bytes (the caller zeroes them). `background`: never fall back to freezing the page. */
    async function deriveKek(passphrase, kdf, background) {
        const w = kdfWorker();
        if (w) {
            try {
                return await deriveInWorker(w, passphrase, kdf);
            } catch (e) {
                if (!e.workerLost) throw e;
            }
        }
        if (background) throw workerLost();
        return deriveInPage(passphrase, kdf);
    }

    async function deriveInPage(passphrase, kdf) {
        if (!window.hashwasm || !window.hashwasm.argon2id) {
            throw new Error('the Argon2 library did not load (js/vendor/hash-wasm-argon2)');
        }
        await nextPaint();
        // NFKD, so the same phrase typed with equivalent code points derives the same key.
        const pwd = utf8.encode(passphrase.normalize('NFKD'));
        try {
            return await window.hashwasm.argon2id({
                password: pwd,
                salt: kdf.salt,
                memorySize: kdf.memoryKiB,
                iterations: kdf.iterations,
                parallelism: kdf.parallelism,
                hashLength: KEY_LENGTH,
                outputType: 'binary'
            });
        } finally {
            pwd.fill(0);
        }
    }

    // Every save needs a new salt, so its KEK is a new Argon2 run (DESIGN.md §6.3). Rather than make
    // Save wait for it, the key for the NEXT save is derived ahead of time — after a document is
    // opened, created or saved, or its passphrase changes — and used up by exactly one encode().
    let prepared = null; // { passphrase, kdf, key: Promise<CryptoKey|null> }

    function prepare(passphrase) {
        prepared = null;
        if (!passphrase) return;
        const kdf = Object.assign({ salt: randomBytes(SALT_LENGTH) }, DEFAULT_KDF);
        const key = deriveKek(passphrase, kdf, true).then(async function (raw) {
            try {
                return await importAesKey(raw);
            } finally {
                raw.fill(0);
            }
        }).catch(function () { return null; }); // encode() then derives one itself
        prepared = { passphrase: passphrase, kdf: kdf, key: key };
    }

    function forget() {
        prepared = null;
    }

    /** -> { kdf, kek: CryptoKey } for one save: the prepared key if it fits, else derived now. */
    async function takeKek(passphrase) {
        const p = prepared;
        prepared = null; // a salt seals one save only
        if (p && p.passphrase === passphrase) {
            const kek = await p.key;
            if (kek) return { kdf: p.kdf, kek: kek };
        }
        const kdf = Object.assign({ salt: randomBytes(SALT_LENGTH) }, DEFAULT_KDF);
        const raw = await deriveKek(passphrase, kdf, false);
        try {
            return { kdf: kdf, kek: await importAesKey(raw) };
        } finally {
            raw.fill(0);
        }
    }

    // ── crypto ──

    function importAesKey(raw) {
        return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    }

    /**
     * -> [nonce, ciphertext || tag] as two arrays, not one: the body goes straight into the file Blob,
     * and joining it first would copy the whole encrypted document once more.
     */
    async function gcmEncrypt(key, plaintext, aad) {
        const nonce = randomBytes(NONCE_LENGTH);
        const ct = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: TAG_LENGTH * 8 },
            key, plaintext);
        return [nonce, new Uint8Array(ct)];
    }

    /** Resolves to the plaintext, or null when the tag does not verify (wrong key or tampering). */
    async function gcmDecrypt(key, sealed, aad) {
        try {
            const pt = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: sealed.subarray(0, NONCE_LENGTH), additionalData: aad,
                  tagLength: TAG_LENGTH * 8 },
                key, sealed.subarray(NONCE_LENGTH));
            return new Uint8Array(pt);
        } catch (_) {
            return null;
        }
    }

    function wrapAad(kdf) {
        return utf8.encode('SDOC-KEK|v' + FORMAT_VERSION + '|' + toBase64(kdf.salt) + '|'
            + kdf.memoryKiB + '|' + kdf.iterations + '|' + kdf.parallelism);
    }

    function bodyAad() {
        return utf8.encode('SDOC-BODY|v' + FORMAT_VERSION);
    }

    // ── header ──

    /** body: the sealed body in parts ([nonce, ciphertext]), joined only by the Blob. */
    function writeFile(kdf, wrappedDek, body) {
        // Keep this key order: it matches what the Java writer produced, byte for byte.
        const header = utf8.encode(JSON.stringify({
            kdf: {
                algo: 'argon2id',
                salt: toBase64(kdf.salt),
                memoryKiB: kdf.memoryKiB,
                iterations: kdf.iterations,
                parallelism: kdf.parallelism
            },
            wrappedDek: toBase64(wrappedDek)
        }));
        const prefix = new DataView(new ArrayBuffer(9));
        MAGIC.forEach(function (b, i) { prefix.setUint8(i, b); });
        prefix.setUint8(4, FORMAT_VERSION);
        prefix.setInt32(5, header.length, false);
        return new Blob([prefix.buffer, header].concat(body), { type: 'application/octet-stream' });
    }

    function intField(node, name) {
        const v = node == null ? undefined : node[name];
        if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647) {
            throw invalid('missing integer field ' + name);
        }
        return v;
    }

    /** The header is untrusted: its KDF parameters are range-checked before Argon2 runs. */
    function readFile(bytes) {
        if (bytes.length === 0) throw invalid('the file is empty (0 bytes)');
        if (bytes.length < 9) throw invalid('the file is truncated (ends inside the header)');
        for (let i = 0; i < MAGIC.length; i++) {
            if (bytes[i] !== MAGIC[i]) {
                throw SdocError('invalid_file', 'not an .sdoc file (bad signature)');
            }
        }
        const version = bytes[4];
        if (version !== FORMAT_VERSION) {
            throw SdocError('invalid_file', 'unsupported .sdoc version: ' + version);
        }
        const headerLen = new DataView(bytes.buffer, bytes.byteOffset + 5, 4).getInt32(0, false);
        if (headerLen < 0 || headerLen > MAX_HEADER_BYTES) {
            throw invalid('implausible header length ' + headerLen);
        }
        if (9 + headerLen > bytes.length) throw invalid('the file is truncated (ends inside the header)');

        let root;
        try {
            root = JSON.parse(utf8Decoder.decode(bytes.subarray(9, 9 + headerLen)));
        } catch (_) {
            throw invalid('the header is not JSON');
        }
        if (root === null || typeof root !== 'object') throw invalid('the header is not a JSON object');
        const k = root.kdf !== null && typeof root.kdf === 'object' ? root.kdf : {};
        if (k.algo != null && k.algo !== 'argon2id') {
            throw SdocError('invalid_file', 'unsupported KDF: ' + k.algo);
        }
        const kdf = {
            salt: fromBase64(typeof k.salt === 'string' ? k.salt : '', 'salt'),
            memoryKiB: intField(k, 'memoryKiB'),
            iterations: intField(k, 'iterations'),
            parallelism: intField(k, 'parallelism')
        };
        const violation = kdfViolation(kdf);
        if (violation) throw invalid('KDF parameter out of range (' + violation + ')');

        const wrappedDek = fromBase64(typeof root.wrappedDek === 'string' ? root.wrappedDek : '',
            'wrappedDek');
        const body = bytes.subarray(9 + headerLen);
        const minSealed = NONCE_LENGTH + TAG_LENGTH;
        if (wrappedDek.length < minSealed || body.length < minSealed) {
            throw invalid('truncated ciphertext');
        }
        return { kdf: kdf, wrappedDek: wrappedDek, body: body };
    }

    function kdfViolation(kdf) {
        if (kdf.salt.length < MIN_SALT_LENGTH || kdf.salt.length > MAX_SALT_LENGTH) {
            return 'salt length ' + kdf.salt.length;
        }
        if (kdf.parallelism < 1 || kdf.parallelism > MAX_PARALLELISM) return 'parallelism ' + kdf.parallelism;
        if (kdf.iterations < 1 || kdf.iterations > MAX_ITERATIONS) return 'iterations ' + kdf.iterations;
        if (kdf.memoryKiB < 8 * kdf.parallelism || kdf.memoryKiB > MAX_MEMORY_KIB) {
            return 'memoryKiB ' + kdf.memoryKiB;
        }
        return null;
    }

    // ── public API ──

    /**
     * Encrypt a document to .sdoc bytes.
     * doc = { passphrase, title, createdAt (ISO string or null), content (HTML), caret (int|null),
     *         media: [{ id, blob }] }  ->  Blob
     */
    async function encode(doc) {
        const now = new Date().toISOString();
        const createdAt = doc.createdAt && !isNaN(Date.parse(doc.createdAt)) ? doc.createdAt : now;
        const manifest = { title: doc.title || '', schemaVersion: SCHEMA_VERSION, createdAt: createdAt,
            modifiedAt: now };
        if (Number.isInteger(doc.caret) && doc.caret >= 0) manifest.caret = doc.caret;

        const entries = [
            { name: 'manifest.json', data: utf8.encode(JSON.stringify(manifest)), deflate: true },
            { name: 'content.html', data: utf8.encode(doc.content), deflate: true }
        ];
        for (const m of doc.media || []) {
            entries.push({ name: 'media/' + m.id, data: new Uint8Array(await m.blob.arrayBuffer()),
                deflate: false }); // images are already compressed; deflating them buys ~1.5%
        }
        let container;
        try {
            container = await Zip.write(entries);
        } finally {
            // The container holds its own copy now: wipe these and let them go before the encrypted
            // copy is made, so a document with big images isn't in memory three times at once.
            entries.forEach(function (e) { e.data.fill(0); });
            entries.length = 0;
        }

        const dek = randomBytes(KEY_LENGTH);
        try {
            const sealer = await takeKek(doc.passphrase);
            prepare(doc.passphrase); // start on the next save's key now that this one's is in hand
            const wrappedDek = concat(await gcmEncrypt(sealer.kek, dek, wrapAad(sealer.kdf)));
            const body = await gcmEncrypt(await importAesKey(dek), container, bodyAad());
            return writeFile(sealer.kdf, wrappedDek, body);
        } finally {
            dek.fill(0);
            container.fill(0);
        }
    }

    /**
     * Decrypt .sdoc bytes. Throws an SdocError with code 'wrong_password' or 'invalid_file'.
     * -> { content, title, schemaVersion, createdAt, modifiedAt, caret, media: { id: Uint8Array } }
     */
    async function decode(blob, passphrase) {
        const sealed = readFile(new Uint8Array(await blob.arrayBuffer()));
        const kek = await deriveKek(passphrase, sealed.kdf, false);
        let dek;
        try {
            dek = await gcmDecrypt(await importAesKey(kek), sealed.wrappedDek, wrapAad(sealed.kdf));
        } finally {
            kek.fill(0);
        }
        if (!dek || dek.length !== KEY_LENGTH) {
            throw SdocError('wrong_password', 'wrong passphrase');
        }
        let container;
        try {
            // The DEK unwrapped, so the passphrase is right: a body failure means a damaged file.
            container = await gcmDecrypt(await importAesKey(dek), sealed.body, bodyAad());
        } finally {
            dek.fill(0);
        }
        if (!container) throw invalid('the content is damaged (integrity check failed)');

        const files = new Map();
        try {
            for (const [name, entry] of Zip.read(container)) files.set(name, await entry.read());
        } catch (e) {
            throw invalid('container: ' + e.message);
        }
        const manifestBytes = files.get('manifest.json');
        const contentBytes = files.get('content.html');
        if (!manifestBytes || !contentBytes) throw invalid('the container has no manifest.json or content.html');
        let m;
        try {
            m = JSON.parse(utf8Decoder.decode(manifestBytes));
        } catch (_) {
            throw invalid('manifest.json is not JSON');
        }
        m = m !== null && typeof m === 'object' ? m : {};
        const media = {};
        files.forEach(function (data, name) {
            if (name.startsWith('media/')) media[name.slice('media/'.length)] = data;
        });
        const epoch = '1970-01-01T00:00:00Z'; // the Java reader's fallback, kept for older files
        return {
            content: utf8Decoder.decode(contentBytes),
            title: typeof m.title === 'string' ? m.title : '',
            schemaVersion: Number.isInteger(m.schemaVersion) ? m.schemaVersion : SCHEMA_VERSION,
            createdAt: typeof m.createdAt === 'string' ? m.createdAt : epoch,
            modifiedAt: typeof m.modifiedAt === 'string' ? m.modifiedAt : epoch,
            caret: Number.isInteger(m.caret) && m.caret >= 0 ? m.caret : null,
            media: media
        };
    }

    return { encode: encode, decode: decode, prepare: prepare, forget: forget };
})();
