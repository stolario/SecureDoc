'use strict';
// Minimal ZIP reader/writer on the browser's own (De)CompressionStream — enough for the .sdoc container
// (sdoc.js) and for reading .docx files (import.js). No ZIP64, no encryption.
window.Zip = (function () {
    const LOCAL = 0x04034b50;
    const CENTRAL = 0x02014b50;
    const END = 0x06054b50;
    const FLAG_ENCRYPTED = 0x0001;
    const FLAG_UTF8 = 0x0800;
    // A single entry bigger than this is refused before inflating: a crafted archive (a .docx from
    // anywhere) must not be able to make the page allocate gigabytes.
    const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

    const utf8 = new TextEncoder();
    const utf8Decoder = new TextDecoder('utf-8');

    const CRC_TABLE = (function () {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        let c = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }

    function concat(parts) {
        let len = 0;
        parts.forEach(function (p) { len += p.length; });
        const out = new Uint8Array(len);
        let off = 0;
        parts.forEach(function (p) { out.set(p, off); off += p.length; });
        return out;
    }

    async function deflate(bytes) {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    /** Inflates into exactly `size` bytes; more output than the header declared is an error. */
    async function inflate(raw, size) {
        const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        const out = new Uint8Array(size);
        let off = 0;
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (off + chunk.value.length > size) {
                reader.cancel().catch(function () {});
                throw new Error('decompressed data exceeds the declared size');
            }
            out.set(chunk.value, off);
            off += chunk.value.length;
        }
        if (off !== size) throw new Error('decompressed data is smaller than the declared size');
        return out;
    }

    function dosDateTime(d) {
        return {
            time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
            date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
        };
    }

    /** entries: [{ name, data: Uint8Array, deflate: bool }] -> ZIP bytes. */
    async function write(entries) {
        if (entries.length > 0xffff) throw new Error('too many files for a ZIP');
        const stamp = dosDateTime(new Date());
        const parts = [];
        const central = [];
        let offset = 0;
        for (const e of entries) {
            const name = utf8.encode(e.name);
            const stored = e.deflate ? await deflate(e.data) : e.data;
            const method = e.deflate ? 8 : 0;
            const crc = crc32(e.data);

            const local = new DataView(new ArrayBuffer(30));
            local.setUint32(0, LOCAL, true);
            local.setUint16(4, 20, true);
            local.setUint16(6, FLAG_UTF8, true);
            local.setUint16(8, method, true);
            local.setUint16(10, stamp.time, true);
            local.setUint16(12, stamp.date, true);
            local.setUint32(14, crc, true);
            local.setUint32(18, stored.length, true);
            local.setUint32(22, e.data.length, true);
            local.setUint16(26, name.length, true);

            const cen = new DataView(new ArrayBuffer(46));
            cen.setUint32(0, CENTRAL, true);
            cen.setUint16(4, 20, true);
            cen.setUint16(6, 20, true);
            cen.setUint16(8, FLAG_UTF8, true);
            cen.setUint16(10, method, true);
            cen.setUint16(12, stamp.time, true);
            cen.setUint16(14, stamp.date, true);
            cen.setUint32(16, crc, true);
            cen.setUint32(20, stored.length, true);
            cen.setUint32(24, e.data.length, true);
            cen.setUint16(28, name.length, true);
            cen.setUint32(42, offset, true);

            parts.push(new Uint8Array(local.buffer), name, stored);
            central.push(new Uint8Array(cen.buffer), name);
            offset += 30 + name.length + stored.length;
            if (offset > 0xffffffff) throw new Error('ZIP larger than 4 GB is not supported');
        }
        let centralLength = 0;
        central.forEach(function (p) { centralLength += p.length; });
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, END, true);
        end.setUint16(8, entries.length, true);
        end.setUint16(10, entries.length, true);
        end.setUint32(12, centralLength, true);
        end.setUint32(16, offset, true);
        return concat(parts.concat(central, [new Uint8Array(end.buffer)]));
    }

    /**
     * ZIP bytes -> Map(name -> { size, read(): Promise<Uint8Array> }). Reads the central directory,
     * because Java's ZipOutputStream (and many other writers) leave sizes out of local headers.
     * Entries are only inflated when read, and each is checked against its CRC-32.
     */
    function read(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let endAt = -1;
        for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
            if (view.getUint32(i, true) === END) { endAt = i; break; }
        }
        if (endAt < 0) throw new Error('not a ZIP archive');
        const count = view.getUint16(endAt + 10, true);
        let p = view.getUint32(endAt + 16, true);
        const out = new Map();
        for (let n = 0; n < count; n++) {
            if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL) {
                throw new Error('damaged ZIP directory');
            }
            const flags = view.getUint16(p + 8, true);
            const method = view.getUint16(p + 10, true);
            const crc = view.getUint32(p + 16, true);
            const compSize = view.getUint32(p + 20, true);
            const size = view.getUint32(p + 24, true);
            const nameLen = view.getUint16(p + 28, true);
            const extraLen = view.getUint16(p + 30, true);
            const commentLen = view.getUint16(p + 32, true);
            const localAt = view.getUint32(p + 42, true);
            const name = utf8Decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
            p += 46 + nameLen + extraLen + commentLen;
            out.set(name, {
                size: size,
                read: function () {
                    return readEntry(bytes, view, name, flags, method, crc, compSize, size, localAt);
                }
            });
        }
        return out;
    }

    async function readEntry(bytes, view, name, flags, method, crc, compSize, size, localAt) {
        if (flags & FLAG_ENCRYPTED || compSize === 0xffffffff || size === 0xffffffff || localAt === 0xffffffff) {
            throw new Error('unsupported ZIP entry (' + name + ')');
        }
        if (size > MAX_ENTRY_BYTES) throw new Error('ZIP entry too large (' + name + ')');
        if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== LOCAL) {
            throw new Error('damaged ZIP entry (' + name + ')');
        }
        const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
        if (dataAt + compSize > bytes.length) throw new Error('truncated ZIP entry (' + name + ')');
        const raw = bytes.subarray(dataAt, dataAt + compSize);
        let data;
        if (method === 0) {
            if (compSize !== size) throw new Error('damaged ZIP entry (' + name + ')');
            data = raw;
        } else if (method === 8) {
            try {
                data = await inflate(raw, size);
            } catch (e) {
                throw new Error('cannot decompress ZIP entry (' + name + '): ' + e.message);
            }
        } else {
            throw new Error('unsupported ZIP compression (' + name + ')');
        }
        if (crc32(data) !== crc) throw new Error('ZIP checksum mismatch (' + name + ')');
        return data;
    }

    return { write: write, read: read };
})();
