'use strict';
// Argon2id off the main thread (sdoc.js). Deriving a key takes a second or two of synchronous WASM;
// run in the page it froze typing, the busy message and the save button for that long.
//
// in:  { id, password: Uint8Array (transferred), salt, memoryKiB, iterations, parallelism, hashLength }
// out: { id, key: Uint8Array (transferred) } | { id, error }
// The password bytes are zeroed here once used; the key's buffer moves to the page, leaving no copy.
importScripts('vendor/hash-wasm-argon2-4.12.0.umd.min.js');

self.onmessage = async function (e) {
    const job = e.data;
    try {
        const raw = await self.hashwasm.argon2id({
            password: job.password,
            salt: job.salt,
            memorySize: job.memoryKiB,
            iterations: job.iterations,
            parallelism: job.parallelism,
            hashLength: job.hashLength,
            outputType: 'binary'
        });
        // A copy of our own to transfer: the library's result may share a buffer we must not detach.
        const key = new Uint8Array(raw);
        raw.fill(0);
        self.postMessage({ id: job.id, key: key }, [key.buffer]);
    } catch (err) {
        self.postMessage({ id: job.id, error: (err && err.message) || String(err) });
    } finally {
        job.password.fill(0);
    }
};
