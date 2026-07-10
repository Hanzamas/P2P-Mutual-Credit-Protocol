// ============================================================
// MEFOBILLS - SETTINGS RENDERER
// ============================================================

var RenderSettings = (function () {

  async function render(state) {
    var nameEl = document.getElementById('setting-name');
    var pkEl = document.getElementById('setting-pubkey');
    var countEl = document.getElementById('setting-bill-count');
    var storeEl = document.getElementById('setting-storage');
    var circleEl = document.getElementById('setting-circle-name');

    if (nameEl) nameEl.textContent = state.myName || '-';
    if (pkEl) pkEl.textContent = state.myPublicKey
      ? state.myPublicKey.substring(0, 16) + '\u2026' + state.myPublicKey.slice(-8)
      : '-';
    if (circleEl) circleEl.textContent = state.circleName || 'Belum bergabung';

    try {
      var count = await BGDB.getBillCount();
      if (countEl) countEl.textContent = count + ' nota';
    } catch(e) {
      if (countEl) countEl.textContent = (state.bills || []).length + ' nota';
    }

    try {
      var est = await BGDB.getStorageEstimate();
      if (est.usage && storeEl) {
        var used = (est.usage / 1024 / 1024).toFixed(1);
        var quota = est.quota ? (est.quota / 1024 / 1024).toFixed(0) + ' MB' : '?';
        storeEl.textContent = used + ' MB / ' + quota;
      }
    } catch(e) {}

    // PIN status
    var pinEl = document.getElementById('setting-pin-status');
    if (pinEl) {
      try {
        var pinEnabled = await BGDB.getConfig('pin_enabled');
        pinEl.textContent = pinEnabled ? 'Aktif' : 'Belum diaktifkan';
        pinEl.style.color = pinEnabled ? 'var(--green)' : '';
      } catch(e) {}
    }

    // Passkey status
    var pkStatusEl = document.getElementById('setting-passkey-status');
    var rowPasskey = document.getElementById('row-passkey');
    if (pkStatusEl) {
      try {
        var isReg = await BGPasskey.isRegistered();
        var prfOk = await BGDB.getConfig('passkey_prf_supported');
        if (isReg) {
          pkStatusEl.textContent = prfOk ? 'Terdaftar (identitas terenkripsi)' : 'Terdaftar (gate saja)';
          pkStatusEl.style.color = 'var(--green)';
          if (rowPasskey) rowPasskey.onclick = function(){ BG.removePasskey(); };
        } else {
          pkStatusEl.textContent = 'Belum didaftarkan';
          pkStatusEl.style.color = '';
          if (rowPasskey) rowPasskey.onclick = function(){ BG.registerPasskey(); };
        }
      } catch(e) {}
    }
  }

  return { render: render };

})();
