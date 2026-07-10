// ============================================================
// NOTA KITA - PASSKEY MODULE (WebAuthn PRF)
// Passkey-bound identity: private key encrypted with PRF output.
// Survives cache clear as long as passkey credential exists on device.
// PRF = Pseudo-Random Function extension (Chrome 115+, Safari 17+)
// ============================================================

var BGPasskey = (function () {

  var RP_NAME = 'Nota Kita';
  var LS_BLOB_KEY = 'nk_passkey_blob';
  var PRF_LABEL = new TextEncoder().encode('nota-kita-prf-v1');

  function isSupported() {
    return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  }

  async function isPRFSupported() {
    if (!isSupported()) return false;
    try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
    catch(e) { return false; }
  }

  function rndBytes(n) { return crypto.getRandomValues(new Uint8Array(n)); }

  function b64u(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  }

  function fromb64u(s) {
    s = s.replace(/-/g,'+').replace(/_/g,'/');
    while (s.length % 4) s += '=';
    var raw = atob(s), buf = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    return buf;
  }

  async function importAES(bytes) {
    return crypto.subtle.importKey('raw',
      bytes instanceof ArrayBuffer ? bytes : bytes.buffer,
      { name:'AES-GCM' }, false, ['encrypt','decrypt']);
  }

  async function aesEncrypt(plainStr, aesKey) {
    var iv = rndBytes(12);
    var ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, aesKey,
                                          new TextEncoder().encode(plainStr));
    var out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0); out.set(new Uint8Array(ct), 12);
    return b64u(out);
  }

  async function aesDecrypt(b64uStr, aesKey) {
    var packed = fromb64u(b64uStr);
    var plain = await crypto.subtle.decrypt(
      { name:'AES-GCM', iv: packed.slice(0,12) }, aesKey, packed.slice(12));
    return new TextDecoder().decode(plain);
  }

  async function getPRFSalt() {
    return crypto.subtle.digest('SHA-256', PRF_LABEL);
  }

  // Register passkey and encrypt privKeyB64 with PRF output
  async function register(privKeyB64, userName, pubKeyHex) {
    if (!isSupported()) throw new Error('Passkey tidak didukung di browser ini.');
    var challenge = rndBytes(32);
    var userId = new TextEncoder().encode(pubKeyHex.slice(0, 32));
    var prfSalt = await getPRFSalt();

    var cred = await navigator.credentials.create({ publicKey: {
      challenge, rp: { name: RP_NAME, id: location.hostname || 'localhost' },
      user: { id: userId, name: userName, displayName: userName },
      pubKeyCredParams: [{ type:'public-key', alg:-7 }, { type:'public-key', alg:-257 }],
      authenticatorSelection: { residentKey:'preferred', userVerification:'required', authenticatorAttachment:'platform' },
      extensions: { prf: { eval: { first: prfSalt } } },
      timeout: 60000
    }});

    if (!cred) throw new Error('Pendaftaran dibatalkan.');

    var ext = cred.getClientExtensionResults();
    var prfOut = ext.prf && ext.prf.results && ext.prf.results.first;
    var credId = b64u(new Uint8Array(cred.rawId));
    var prfSaltB64 = b64u(new Uint8Array(prfSalt));

    if (!prfOut) {
      // PRF not available - gate-only mode
      await BGDB.setConfig('passkey_cred_id', credId);
      await BGDB.setConfig('passkey_prf_supported', false);
      return { credId, prfSupported: false };
    }

    var aesKey = await importAES(prfOut);
    var encPrivKey = await aesEncrypt(privKeyB64, aesKey);

    await BGDB.setConfig('passkey_cred_id', credId);
    await BGDB.setConfig('passkey_prf_salt', prfSaltB64);
    await BGDB.setConfig('passkey_prf_supported', true);
    await BGDB.setConfig('passkey_encrypted_privkey', encPrivKey);

    // Backup to localStorage (survives IndexedDB cache clear)
    try { localStorage.setItem(LS_BLOB_KEY, JSON.stringify({ v:1, credId, prfSalt:prfSaltB64, enc:encPrivKey })); }
    catch(e) {}

    return { credId, prfSupported: true };
  }

  // Authenticate with passkey, returns decrypted privKeyB64 (or null for gate-only)
  async function authenticate() {
    var credId     = await BGDB.getConfig('passkey_cred_id');
    var prfSaltB64 = await BGDB.getConfig('passkey_prf_salt');
    var encPrivKey = await BGDB.getConfig('passkey_encrypted_privkey');
    var prfOk      = await BGDB.getConfig('passkey_prf_supported');

    // Fallback to localStorage if DB was cleared
    if (!credId) {
      try {
        var blob = JSON.parse(localStorage.getItem(LS_BLOB_KEY) || 'null');
        if (blob && blob.v === 1) {
          credId = blob.credId; prfSaltB64 = blob.prfSalt;
          encPrivKey = blob.enc; prfOk = true;
          // Restore to DB
          await BGDB.setConfig('passkey_cred_id', credId);
          await BGDB.setConfig('passkey_prf_salt', prfSaltB64);
          await BGDB.setConfig('passkey_encrypted_privkey', encPrivKey);
          await BGDB.setConfig('passkey_prf_supported', true);
        }
      } catch(e) {}
    }

    if (!credId) throw new Error('Passkey belum terdaftar.');

    var extensions = {};
    if (prfOk && prfSaltB64) extensions.prf = { eval: { first: fromb64u(prfSaltB64).buffer } };

    var assertion = await navigator.credentials.get({ publicKey: {
      challenge: rndBytes(32),
      allowCredentials: [{ type:'public-key', id: fromb64u(credId) }],
      userVerification: 'required',
      extensions, timeout: 60000
    }});

    if (!assertion) throw new Error('Autentikasi dibatalkan.');

    var ext = assertion.getClientExtensionResults();
    var prfOut = ext.prf && ext.prf.results && ext.prf.results.first;

    if (!prfOut || !encPrivKey) return null; // gate-only

    return aesDecrypt(encPrivKey, await importAES(prfOut));
  }

  async function unregister() {
    await BGDB.setConfig('passkey_cred_id', null);
    await BGDB.setConfig('passkey_prf_salt', null);
    await BGDB.setConfig('passkey_prf_supported', null);
    await BGDB.setConfig('passkey_encrypted_privkey', null);
    try { localStorage.removeItem(LS_BLOB_KEY); } catch(e) {}
  }

  async function isRegistered() {
    var c = await BGDB.getConfig('passkey_cred_id');
    if (c) return true;
    try {
      var blob = JSON.parse(localStorage.getItem(LS_BLOB_KEY) || 'null');
      return !!(blob && blob.credId);
    } catch(e) { return false; }
  }

  return { isSupported, isPRFSupported, register, authenticate, unregister, isRegistered };

})();
