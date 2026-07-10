// ============================================================
// BUKUGEMBOK - SHARE MODULE
// Hardened: file size limit, structure validation
// ============================================================

var BGShare = (function () {

  var MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

  function canShare() {
    return !!(navigator.share && navigator.canShare);
  }

  // Share text/url via OS sheet (WA, Telegram, BT, Quick Share, etc.)
  async function shareText(text, title) {
    if (navigator.share) {
      try { return await navigator.share({ title: title || 'Nota Kita', text: text }); }
      catch(e) { if (e.name !== 'AbortError') throw e; return; }
    }
    // Fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(text);
      BGUI.showToast('Disalin ke clipboard.', 'success');
    } catch(e) {
      BGUI.showToast('Tidak bisa berbagi di browser ini.', 'error');
    }
  }

  // Share file via OS sheet (handles WA, BT, Quick Share, Airdrop, etc.)
  async function shareFile(blob, filename, title) {
    var file = new File([blob], filename, { type: blob.type });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { return await navigator.share({ files: [file], title: title || 'Nota Kita' }); }
      catch(e) { if (e.name !== 'AbortError') throw e; return; }
    }
    // Fallback: download
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = filename;
    a.style.display = 'none'; document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); document.body.removeChild(a); }, 200);
  }

  async function blast(txArray, senderMeta) {
    if (!canShare()) throw new Error('Fitur berbagi tidak tersedia di perangkat ini.');

    var compressed = BGMerge.compressArray(txArray, senderMeta);
    var json = JSON.stringify(compressed, null, 0);
    var blob = new Blob([json], { type: 'application/json' });
    var file = new File([blob], 'bukugembok-kas.json', { type: 'application/json' });

    var shareData = { files: [file] };

    if (!navigator.canShare(shareData)) {
      shareData = { title: 'BukuGembok - Data Kas', text: json };
    }

    return navigator.share(shareData);
  }

  function exportFile(txArray, filename, senderMeta) {
    filename = filename || 'bukugembok-kas.json';
    var compressed = BGMerge.compressArray(txArray, senderMeta);
    var json = JSON.stringify(compressed, null, 0);
    var blob = new Blob([json], { type: 'application/json' });

    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();

    setTimeout(function () {
      URL.revokeObjectURL(url);
      document.body.removeChild(a);
    }, 200);
  }

  function importFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('Tidak ada file.')); return; }

      // File size check
      if (file.size > MAX_FILE_SIZE) {
        reject(new Error('File terlalu besar (maks 10MB). Pastikan file dari BukuGembok.'));
        return;
      }

      // Type check (loose, because Android sometimes gives wrong MIME)
      var name = (file.name || '').toLowerCase();
      if (name && !name.endsWith('.json')) {
        reject(new Error('File harus berformat .json dari BukuGembok.'));
        return;
      }

      var reader = new FileReader();

      reader.onload = function (e) {
        try {
          var raw = JSON.parse(e.target.result);

          // Allow encrypted format to pass through (handled by app.js)
          if (raw && raw.format === 'bukugembok_encrypted_v1' && raw.data) {
            resolve(raw);
            return;
          }

          if (!Array.isArray(raw)) {
            reject(new Error('Format file tidak dikenali. Pastikan file dari BukuGembok.'));
            return;
          }

          if (raw.length === 0) {
            reject(new Error('File kosong, tidak ada transaksi.'));
            return;
          }

          // Skip _meta header if present, validate first actual transaction
          var firstTx = raw[0] && raw[0]._meta ? raw[1] : raw[0];
          if (!firstTx) {
            reject(new Error('File kosong, tidak ada transaksi.'));
            return;
          }
          var isValid = (firstTx.i && firstTx.w) || (firstTx.id && firstTx.waktu);
          if (!isValid) {
            reject(new Error('Isi file tidak sesuai format BukuGembok.'));
            return;
          }

          // Resolve with raw array — app.js calls parseIncoming itself
          resolve(raw);
        } catch (err) {
          reject(new Error('File rusak atau bukan format JSON yang valid.'));
        }
      };

      reader.onerror = function () {
        reject(new Error('Gagal membaca file.'));
      };

      reader.readAsText(file);
    });
  }

  function setupLaunchQueue(onReceive) {
    if ('launchQueue' in window) {
      window.launchQueue.setConsumer(function (launchParams) {
        if (launchParams.files && launchParams.files.length > 0) {
          launchParams.files[0].getFile().then(function (file) {
            importFile(file).then(onReceive).catch(function (e) {
              console.error('Launch queue import error:', e);
            });
          });
        }
      });
    }
  }

  return {
    canShare: canShare,
    shareText: shareText,
    shareFile: shareFile,
    blast: blast,
    exportFile: exportFile,
    importFile: importFile,
    setupLaunchQueue: setupLaunchQueue
  };

})();
