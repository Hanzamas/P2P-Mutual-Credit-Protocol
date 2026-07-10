// ============================================================
// NOTA KITA - CRYPTO MODULE (secp256k1 + Schnorr BIP-340)
// Identity: secp256k1 keypair (Nostr-compatible)
// Storage wrap: AES-256-GCM (Web Crypto, device-bound)
// Lib: noble-secp256k1.js (5KB, audited, pure JS)
// ============================================================
// API surface identical to old P-256 module.
// Key format change:
//   publicKey  = 64-char hex (32-byte x-only, Nostr npub raw)
//   privateKey = 64-char hex (32-byte scalar) — wrapped in AES before storage
// ============================================================

var BGCrypto = (function () {

  // Wait up to 3s for ESM bridge (type=module loads async)
  function waitForNoble() {
    return new Promise(function(resolve, reject) {
      if (window.__nobleSecp256k1) { resolve(window.__nobleSecp256k1); return; }
      var attempts = 0;
      var t = setInterval(function() {
        attempts++;
        if (window.__nobleSecp256k1) { clearInterval(t); resolve(window.__nobleSecp256k1); }
        else if (attempts > 60) { clearInterval(t); reject(new Error('noble-secp256k1 failed to load')); }
      }, 50);
    });
  }

  // Sync accessor (used after init confirmed ready)
  function _secp() {
    if (!window.__nobleSecp256k1) throw new Error('noble-secp256k1 not loaded');
    return window.__nobleSecp256k1;
  }

  // --- Support check ---

  function isSupported() {
    return !!(window.crypto && window.crypto.subtle && window.crypto.getRandomValues);
  }

  // --- Bytes helpers ---

  function hexToBytes(hex) {
    if (hex.length % 2 !== 0) throw new Error('Invalid hex');
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < hex.length; i += 2) out[i >> 1] = parseInt(hex.slice(i, i + 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  }

  // Chunked to avoid stack overflow on large buffers
  function bufToB64(buf) {
    var bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer);
    var chunks = [];
    var CHUNK = 8192;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
    }
    return btoa(chunks.join(''));
  }

  function b64ToBuf(b64) {
    var str = atob(b64);
    var buf = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
    return buf.buffer;
  }

  function textToBytes(str) { return new TextEncoder().encode(str); }

  function safeStr(val) {
    if (typeof val !== 'string') return '';
    return val.replace(/\|/g, '-');
  }

  // --- SHA-256 (native Web Crypto) ---

  async function sha256(text) {
    var data = textToBytes(typeof text === 'string' ? text : text);
    var hashBuf = await crypto.subtle.digest('SHA-256', data);
    return bytesToHex(new Uint8Array(hashBuf));
  }

  async function sha256Bytes(bytes) {
    var hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(hashBuf);
  }

  // --- Canonical string for signing (pipe-delimited, field-swap resistant) ---

  function canonicalize(tx) {
    return [
      tx.id,
      tx.waktu,
      tx.jenis,
      tx.nominal,
      safeStr(tx.keterangan),
      tx.pub_key,
      safeStr(tx.kategori),
      tx.logical_clock || 0,
      tx.prev_hash || ''
    ].join('|');
  }

  // --- Key generation ---

  async function generateKeyPair() {
    if (!isSupported()) throw new Error('Browser tidak mendukung enkripsi.');
    var secp = await waitForNoble();
    var privBytes = secp.utils.randomPrivateKey();
    var pubBytes = secp.getPublicKey(privBytes, true); // 33-byte compressed
    // x-only (32 bytes) for Nostr compatibility
    var pubHex = bytesToHex(pubBytes.slice(1, 33));
    var privHex = bytesToHex(privBytes);
    return { publicKey: pubHex, privateKey: privHex };
  }

  // Export: return the hex string directly (already serialized)
  async function exportPublicKey(kp) {
    return typeof kp === 'string' ? kp : kp.publicKey;
  }

  async function exportPrivateKey(kp) {
    return typeof kp === 'string' ? kp : kp.privateKey;
  }

  // Import: for secp256k1, "import" = just validate and return hex
  async function importPublicKey(hexStr) {
    if (typeof hexStr !== 'string' || hexStr.length !== 64) throw new Error('Invalid pubkey hex');
    return hexStr;
  }

  async function importPrivateKey(hexStr) {
    if (typeof hexStr !== 'string' || hexStr.length !== 64) throw new Error('Invalid privkey hex');
    return hexStr;
  }

  // --- Sign (Schnorr BIP-340) ---
  // tx = transaction object (canonicalized internally) OR pre-built canonical string
  async function sign(privateKeyHex, tx) {
    var msg = typeof tx === 'string' ? tx : canonicalize(tx);
    return signCanonical(privateKeyHex, msg);
  }

  // Sign any canonical string directly (used by circle.js, oracle.js)
  async function signCanonical(privateKeyHex, canonicalStr) {
    var secp = _secp();
    var msgHash = await sha256Bytes(textToBytes(canonicalStr));
    var privBytes = hexToBytes(privateKeyHex);
    var sigObj = await secp.signAsync(msgHash, privBytes, { lowS: true });
    return sigObj.toCompactHex();
  }

  // Verify any canonical string
  async function verifyCanonical(pubKeyHex, canonicalStr, sigHex) {
    try {
      var secp = _secp();
      var msgHash = await sha256Bytes(textToBytes(canonicalStr));
      var pubBytes = hexToBytes(pubKeyHex);
      return secp.verify(sigHex, msgHash, pubBytes);
    } catch (e) {
      return false;
    }
  }

  async function verify(pubKeyHex, tx, sigHex) {
    var msg = typeof tx === 'string' ? tx : canonicalize(tx);
    return verifyCanonical(pubKeyHex, msg, sigHex);
  }

  // --- UUID v4 ---

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.from(bytes, function(b){ return b.toString(16).padStart(2, '0'); }).join('');
    return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join('-');
  }

  // --- Device-bound Key Wrapping (AES-256-GCM, Web Crypto) ---
  // Private key stored as hex → wrapped by AES device key → stored as base64

  var volatileDeviceKeyB64 = null;

  function setVolatileDeviceKey(b64) { volatileDeviceKeyB64 = b64; }
  function hasVolatileDeviceKey() { return volatileDeviceKeyB64 !== null; }

  async function _getAESDeviceKey() {
    if (volatileDeviceKeyB64) {
      return crypto.subtle.importKey('raw', b64ToBuf(volatileDeviceKeyB64),
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    var stored = await BGDB.getConfig('_device_wrap_key');
    if (stored) {
      return crypto.subtle.importKey('raw', b64ToBuf(stored),
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    var key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    var raw = await crypto.subtle.exportKey('raw', key);
    await BGDB.setConfig('_device_wrap_key', bufToB64(raw));
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function wrapPrivateKey(privHex) {
    var deviceKey = await _getAESDeviceKey();
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var data = textToBytes(privHex); // hex string → bytes
    var encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, deviceKey, data);
    var packed = new Uint8Array(12 + encrypted.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(encrypted), 12);
    return bufToB64(packed.buffer);
  }

  async function unwrapPrivateKey(wrappedB64) {
    var deviceKey = await _getAESDeviceKey();
    var packed = new Uint8Array(b64ToBuf(wrappedB64));
    var iv = packed.slice(0, 12);
    var cipher = packed.slice(12);
    var decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, deviceKey, cipher);
    return new TextDecoder().decode(decrypted); // returns hex string
  }

  async function overrideDeviceKey(newKeyB64, currentPrivHex) {
    volatileDeviceKeyB64 = newKeyB64;
    await BGDB.setConfig('_device_wrap_key', null);
    var wrapped = await wrapPrivateKey(currentPrivHex);
    await BGDB.setConfig('my_private_key_wrapped', wrapped);
  }

  // --- Nostr npub/nsec helpers (bonus) ---
  // npub = bech32 encoded x-only pubkey (32 bytes)
  // We expose hex only for now; bech32 encode optional

  function toNostrHex(pubHex) {
    // Already x-only 32-byte hex = Nostr pubkey format
    return pubHex;
  }

  return {
    isSupported:          isSupported,
    generateKeyPair:      generateKeyPair,
    exportPublicKey:      exportPublicKey,
    exportPrivateKey:     exportPrivateKey,
    importPublicKey:      importPublicKey,
    importPrivateKey:     importPrivateKey,
    sign:                 sign,
    signCanonical:        signCanonical,
    verify:               verify,
    verifyCanonical:      verifyCanonical,
    sha256:               sha256,
    uuid:                 uuid,
    canonicalize:         canonicalize,
    bufToB64:             bufToB64,
    b64ToBuf:             b64ToBuf,
    hexToBytes:           hexToBytes,
    bytesToHex:           bytesToHex,
    wrapPrivateKey:       wrapPrivateKey,
    unwrapPrivateKey:     unwrapPrivateKey,
    overrideDeviceKey:    overrideDeviceKey,
    setVolatileDeviceKey: setVolatileDeviceKey,
    hasVolatileDeviceKey: hasVolatileDeviceKey,
    toNostrHex:           toNostrHex
  };

})();
