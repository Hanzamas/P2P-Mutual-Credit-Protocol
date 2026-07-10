// ============================================================
// BUKUGEMBOK - ENCRYPTION MODULE (AES-256-GCM)
// Enterprise-grade data-at-rest encryption via Web Crypto API
// Used for: key backup encryption, file export encryption
// ============================================================

var BGEncrypt = (function () {

  var PBKDF2_ITERATIONS = 600000;
  var SALT_LENGTH = 16; // 128 bits
  var IV_LENGTH = 12;   // 96 bits (required for AES-GCM)

  // --- Derive AES key from password ---

  async function deriveKey(password, salt) {
    var enc = new TextEncoder();
    var keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable
      ['encrypt', 'decrypt']
    );
  }

  // --- Encrypt ---

  async function encrypt(plaintext, password) {
    var salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    var iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    var key = await deriveKey(password, salt);

    var enc = new TextEncoder();
    var data = enc.encode(plaintext);

    var ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      data
    );

    // Pack: salt (16) + iv (12) + ciphertext
    var packed = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
    packed.set(salt, 0);
    packed.set(iv, salt.length);
    packed.set(new Uint8Array(ciphertext), salt.length + iv.length);

    return BGCrypto.bufToB64(packed.buffer);
  }

  // --- Decrypt ---

  async function decrypt(packedB64, password) {
    var packed = new Uint8Array(BGCrypto.b64ToBuf(packedB64));

    if (packed.length < SALT_LENGTH + IV_LENGTH + 1) {
      throw new Error('Data terenkripsi terlalu pendek.');
    }

    var salt = packed.slice(0, SALT_LENGTH);
    var iv = packed.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    var ciphertext = packed.slice(SALT_LENGTH + IV_LENGTH);

    var key = await deriveKey(password, salt);

    try {
      var decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        ciphertext
      );

      var dec = new TextDecoder();
      return dec.decode(decrypted);
    } catch (e) {
      throw new Error('Password salah atau data rusak.');
    }
  }

  // --- Encrypt file data (for export) ---

  async function encryptForExport(dataObj, password) {
    var json = JSON.stringify(dataObj);
    var encrypted = await encrypt(json, password);
    return {
      format: 'bukugembok_encrypted_v1',
      data: encrypted,
      encrypted_at: Date.now()
    };
  }

  // --- Decrypt file data (for import) ---

  async function decryptFromImport(fileObj, password) {
    if (fileObj.format !== 'bukugembok_encrypted_v1') {
      throw new Error('Format file tidak dikenali.');
    }
    var json = await decrypt(fileObj.data, password);
    return JSON.parse(json);
  }

  // --- Check if data is encrypted format ---

  function isEncrypted(obj) {
    return obj && obj.format === 'bukugembok_encrypted_v1' && obj.data;
  }

  return {
    encrypt: encrypt,
    decrypt: decrypt,
    encryptForExport: encryptForExport,
    decryptFromImport: decryptFromImport,
    isEncrypted: isEncrypted,
    deriveKey: deriveKey
  };

})();
