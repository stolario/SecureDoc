'use strict';

/** Binary helpers shared by authentication and encrypted document formats. */
window.ByteUtils = (function () {
    function concat(parts) {
        let length = 0;
        parts.forEach(part => { length += part.length; });
        const output = new Uint8Array(length);
        let offset = 0;
        parts.forEach(part => {
            output.set(part, offset);
            offset += part.length;
        });
        return output;
    }

    function toBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
        }
        return btoa(binary);
    }

    return Object.freeze({ concat, toBase64 });
})();
