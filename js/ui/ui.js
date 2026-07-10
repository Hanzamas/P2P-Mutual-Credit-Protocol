// ============================================================
// MEFOBILLS - UI UTILITIES
// Toast, modal, nav, sound, haptic, formatting helpers
// NO business logic here — pure DOM + presentation utils
// ============================================================

var BGUI = (function () {

  var toastTimer = null;
  var modalResolve = null;
  var audioCtx = null;

  // ---- Toast ----

  function showToast(msg, type, duration) {
    var el = document.getElementById('toast');
    if (!el) return;
    duration = duration || 3000;
    clearTimeout(toastTimer);
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' toast-' + type : '');
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, duration);
  }

  // ---- Modal (returns Promise<bool>) ----

  function showModal(title, bodyHTML) {
    return new Promise(function (resolve) {
      var overlay = document.getElementById('modal-overlay');
      var titleEl = document.getElementById('modal-title');
      var bodyEl = document.getElementById('modal-body');
      if (!overlay) { resolve(false); return; }

      if (titleEl) titleEl.textContent = title;
      if (bodyEl) bodyEl.innerHTML = bodyHTML || '';

      overlay.classList.add('show');
      modalResolve = resolve;

      // G2: move focus to first focusable element inside modal
      setTimeout(function() {
        var focusable = overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable.length) focusable[0].focus();
      }, 50);
    });
  }

  function confirmModal() {
    var overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.classList.remove('show');
    if (modalResolve) { modalResolve(true); modalResolve = null; }
  }

  function dismissModal() {
    var overlay = document.getElementById('modal-overlay');
    if (overlay && overlay.classList.contains('show')) {
      overlay.classList.remove('show');
      if (modalResolve) { modalResolve(false); modalResolve = null; }
    }
  }

  // ---- Loading overlay ----

  function showLoading(text) {
    var el = document.getElementById('loading-overlay');
    var textEl = document.getElementById('loading-text');
    if (textEl) textEl.textContent = text || 'Memproses...';
    if (el) el.classList.add('show');
  }

  function hideLoading() {
    var el = document.getElementById('loading-overlay');
    if (el) el.classList.remove('show');
  }

  // ---- Sound ----

  function playSound(type) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      if (type === 'success') {
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc.frequency.setValueAtTime(1100, audioCtx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
        osc.start(); osc.stop(audioCtx.currentTime + 0.3);
      } else if (type === 'alarm') {
        osc.frequency.setValueAtTime(440, audioCtx.currentTime);
        osc.frequency.setValueAtTime(220, audioCtx.currentTime + 0.2);
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
        osc.start(); osc.stop(audioCtx.currentTime + 0.5);
      } else if (type === 'tap') {
        osc.frequency.setValueAtTime(600, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
        osc.start(); osc.stop(audioCtx.currentTime + 0.08);
      }
    } catch (e) { /* no audio */ }
  }

  // ---- Haptic ----

  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
  }

  // ---- Screen flash ----

  function flashScreen(color) {
    var el = document.getElementById('screen-flash');
    if (!el) return;
    el.style.background = color === 'green' ? 'rgba(0,230,118,0.15)' : 'rgba(255,82,82,0.15)';
    el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 400);
  }

  // ---- TTS (Text-to-Speech for accessibility) ----

  function speak(text) {
    try {
      if (!window.speechSynthesis) return;
      var utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'id-ID';
      utter.rate = 0.9;
      speechSynthesis.cancel();
      speechSynthesis.speak(utter);
    } catch (e) {}
  }

  // ---- Formatting ----

  function formatAmount(amount, asset_type, asset_unit, asset_name) {
    if (asset_type === 'COMMODITY') {
      return amount.toLocaleString('id-ID') + ' ' + (asset_unit || '') + (asset_name ? ' ' + asset_name : '');
    }
    // FIAT
    var unit = asset_unit || 'IDR';
    if (unit === 'IDR') return 'Rp\u00a0' + amount.toLocaleString('id-ID');
    return unit + '\u00a0' + amount.toLocaleString('id-ID');
  }

  function formatDate(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatDateTime(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function timeAgo(ts) {
    if (!ts) return '-';
    var diff = Date.now() - ts;
    var m = Math.floor(diff / 60000);
    if (m < 1) return 'Baru saja';
    if (m < 60) return m + ' menit lalu';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' jam lalu';
    var d = Math.floor(h / 24);
    if (d < 30) return d + ' hari lalu';
    return formatDate(ts);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // status badge: pill with color
  function statusBadge(status) {
    var labels = {
      'ACTIVE': ['Aktif', 'badge-green'],
      'PENDING_ACCEPTANCE': ['Menunggu Konfirmasi', 'badge-yellow'],
      'PENDING_CONFIRMATION': ['Menunggu Konfirmasi Lunas', 'badge-yellow'],
      'SETTLED': ['Lunas', 'badge-blue'],
      'DEFAULTED': ['Macet', 'badge-red'],
      'SPENT': ['Sudah Dioper', 'badge-gray'],
      'CONFIRMED': ['Dikonfirmasi', 'badge-blue'],
      'RECEIPT': ['Kwitansi', 'badge-gray']
    };
    var info = labels[status] || [status, 'badge-gray'];
    return '<span class="badge ' + info[1] + '">' + info[0] + '</span>';
  }

  // bill type label (plain language)
  function typeName(type) {
    var map = {
      'DEBIT_NOTE': 'Kasbon',
      'SETTLEMENT': 'Pelunasan',
      'ENDORSEMENT_OUT': 'Oper Nota (Keluar)',
      'ENDORSEMENT_IN': 'Oper Nota (Masuk)',
      'RECEIPT': 'Kwitansi'
    };
    return map[type] || type;
  }

  // reputation badge emoji
  function repBadge(score) {
    if (score === undefined || score === null) return '';
    if (score >= 70) return '<span class="rep-badge green" title="Reputasi Baik">&#x1F7E2;</span>';
    if (score >= 40) return '<span class="rep-badge yellow" title="Reputasi Sedang">&#x1F7E1;</span>';
    return '<span class="rep-badge red" title="Reputasi Buruk">&#x1F534;</span>';
  }

  // ---- Nominal input formatting (cursor-safe) ----

  function formatNominalInput(input) {
    var cursorPos = input.selectionStart;
    var oldLen = input.value.length;
    var raw = input.value.replace(/\D/g, '');
    if (raw.length > 15) raw = raw.substring(0, 15);
    input.dataset.rawValue = raw;
    if (raw === '') { input.value = ''; return; }
    var formatted = Number(raw).toLocaleString('id-ID');
    input.value = formatted;
    var diff = formatted.length - oldLen;
    var newPos = Math.max(0, cursorPos + diff);
    try { input.setSelectionRange(newPos, newPos); } catch (e) {}
  }

  function getNominalRaw(inputId) {
    var el = document.getElementById(inputId);
    if (!el) return 0;
    var raw = el.dataset.rawValue || el.value.replace(/\D/g, '');
    return Number(raw) || 0;
  }

  // ---- Peer display name (pub_key → nickname) ----

  function peerName(pub_key, peers) {
    if (!pub_key) return 'Tidak diketahui';
    var p = peers.find(function(x){ return x.pub_key === pub_key; });
    if (p && p.nama) return p.nama;
    return pub_key.substring(0, 8) + '...';
  }

  // ---- Build confirm preview for bill ----

  function buildBillPreview(bill, myPubKey, peers) {
    var amountStr = formatAmount(bill.amount, bill.asset_type, bill.asset_unit, bill.asset_name);
    var isDebtor = bill.from_pub_key === myPubKey;
    var counterparty = isDebtor ? bill.to_pub_key : bill.from_pub_key;
    var counterName = peerName(counterparty, peers);
    var roleText = isDebtor
      ? 'Kamu <strong>berutang ' + amountStr + '</strong> kepada <strong>' + escapeHtml(counterName) + '</strong>'
      : '<strong>' + escapeHtml(counterName) + '</strong> berutang <strong>' + amountStr + '</strong> kepadamu';

    var interest = bill.interest_rate ? BGInterest.formatRate(bill) : '';
    var dueText = bill.due_date ? 'Jatuh tempo: ' + formatDate(bill.due_date) : '';

    return '<div class="bill-preview">' +
      '<div class="bill-preview-amount ' + (isDebtor ? 'hutang' : 'piutang') + '">' + amountStr + '</div>' +
      '<div class="bill-preview-role">' + roleText + '</div>' +
      (bill.keterangan ? '<div class="bill-preview-note">"' + escapeHtml(bill.keterangan) + '"</div>' : '') +
      (interest ? '<div class="bill-preview-meta">Bunga: ' + interest + '</div>' : '') +
      (dueText ? '<div class="bill-preview-meta">' + dueText + '</div>' : '') +
      '</div>';
  }

  return {
    showToast: showToast,
    showModal: showModal,
    confirmModal: confirmModal,
    dismissModal: dismissModal,
    showLoading: showLoading,
    hideLoading: hideLoading,
    playSound: playSound,
    vibrate: vibrate,
    flashScreen: flashScreen,
    speak: speak,
    formatAmount: formatAmount,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    timeAgo: timeAgo,
    escapeHtml: escapeHtml,
    statusBadge: statusBadge,
    typeName: typeName,
    repBadge: repBadge,
    formatNominalInput: formatNominalInput,
    getNominalRaw: getNominalRaw,
    peerName: peerName,
    buildBillPreview: buildBillPreview
  };

})();
