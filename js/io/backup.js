// ============================================================
// MEFOBILLS - BACKUP MODULE
// Key export (always encrypted) + import + restore
// ============================================================

var BGBackup = (function () {

  // Export private key — ALWAYS encrypted with user password.
  // Returns filename of downloaded file.
  async function exportKey(password) {
    if (!password || password.length < 4) throw new Error('Password minimal 4 karakter.');

    var pubKey = await BGDB.getConfig('my_public_key');
    var name = await BGDB.getConfig('my_name');

    var privKeyB64 = null;
    var wrappedKey = await BGDB.getConfig('my_private_key_wrapped');
    if (wrappedKey) {
      privKeyB64 = await BGCrypto.unwrapPrivateKey(wrappedKey);
    } else {
      privKeyB64 = await BGDB.getConfig('my_private_key');
    }

    if (!pubKey || !privKeyB64) throw new Error('Kunci tidak ditemukan.');

    var plainData = {
      format: 'mefobills_key_v1',
      pub_key: pubKey,
      priv_key: privKeyB64,
      nama: name || '',
      exported_at: Date.now()
    };

    // Always encrypt — never store private key as plaintext
    var encrypted = await BGEncrypt.encryptForExport(plainData, password);
    encrypted.format = 'mefobills_key_v1_encrypted';

    var json = JSON.stringify(encrypted, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'mefobills-kunci-' + new Date().toISOString().split('T')[0] + '.json';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();

    setTimeout(function () {
      URL.revokeObjectURL(url);
      document.body.removeChild(a);
    }, 200);

    return a.download;
  }

  // Import and restore identity from encrypted backup file + password.
  async function importKey(file, password) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('Tidak ada file.')); return; }
      if (file.size > 100 * 1024) { reject(new Error('File terlalu besar.')); return; }

      var reader = new FileReader();
      reader.onload = async function (e) {
        try {
          var raw = JSON.parse(e.target.result);

          // encrypted v1
          if (raw.format === 'mefobills_key_v1_encrypted') {
            if (!password) { reject(new Error('Password diperlukan untuk file ini.')); return; }
            var decrypted = await BGEncrypt.decryptFromImport({ format: 'bukugembok_encrypted_v1', data: raw.data, encrypted_at: raw.encrypted_at }, password);
            raw = decrypted;
          }

          if (raw.format !== 'mefobills_key_v1') {
            reject(new Error('Format file tidak dikenali.'));
            return;
          }

          if (!raw.pub_key || !raw.priv_key) {
            reject(new Error('Data kunci tidak lengkap.'));
            return;
          }

          // verify keypair integrity before storing
          try {
            await BGCrypto.importPrivateKey(raw.priv_key);
            await BGCrypto.importPublicKey(raw.pub_key);
          } catch (e) {
            reject(new Error('Kunci dalam file tidak valid atau rusak.'));
            return;
          }

          // store
          var wrapped = await BGCrypto.wrapPrivateKey(raw.priv_key);
          await BGDB.setConfig('my_public_key', raw.pub_key);
          await BGDB.setConfig('my_private_key_wrapped', wrapped);
          await BGDB.setConfig('my_private_key', null); // remove legacy plain if any
          if (raw.nama) await BGDB.setConfig('my_name', raw.nama);

          resolve({ pub_key: raw.pub_key, nama: raw.nama || '' });

        } catch (err) {
          reject(new Error('Gagal membaca file: ' + err.message));
        }
      };
      reader.onerror = function () { reject(new Error('Gagal membaca file.')); };
      reader.readAsText(file);
    });
  }

  return { exportKey, importKey };

})();
