// ============================================================
// MEFOBILLS - APP BOOTSTRAP
// State, init, navigation, event wiring, sync orchestration
// All domain logic lives in core/* modules
// All rendering lives in ui/render/* modules
// ============================================================

var BG = (function () {

  // ---- State ----

  var state = {
    myPublicKey:  '',
    myPrivateKey: null,
    myName:       '',
    circleName:   '',
    circleGenesisId: '',
    logicalClock: 0,
    bills:        [],
    peers:        [],
    isOnline:     false,
    ready:        false,
    recentNettingLogs: []
  };

  var currentScreen = '';
  var screenHistory = [];
  var isProcessing = false;
  var _jobsRunning = false;     // B2: prevent double _kickOffBackgroundJobs
  var _isNettingRunning = false; // B5: netting mutex

  var initCalled = false;
  var deferredPWAPrompt = null;

  // ---- Expose getters for renderers + rtc.js ----

  function getState() { return state; }

  function getSyncState() {
    return {
      bills: state.bills,
      meta: {
        pub_key:      state.myPublicKey,
        name:         state.myName,
        circle_name:  state.circleName,
        genesis_id:   state.circleGenesisId
      }
    };
  }

  // ---- Error boundary ----

  window.onerror = function (msg, src, line) {
    console.error('App error:', msg, src, line);
    return false;
  };
  window.addEventListener('unhandledrejection', function (e) {
    console.error('Unhandled:', e.reason);
    if (e.reason && e.reason.message === 'QUOTA_EXCEEDED') {
      BGUI.showToast('Penyimpanan HP penuh!', 'error', 5000);
    }
  });

  // ---- PWA ----

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPWAPrompt = e;
    setTimeout(function(){
      var b = document.getElementById('pwa-banner');
      if (b) b.classList.add('show');
    }, 4000);
  });

  function installPWA() {
    if (!deferredPWAPrompt) return;
    deferredPWAPrompt.prompt();
    deferredPWAPrompt.userChoice.then(function(){ deferredPWAPrompt = null; dismissPWABanner(); });
  }
  function dismissPWABanner() {
    var b = document.getElementById('pwa-banner');
    if (b) b.classList.remove('show');
  }

  // ---- Boot ----

  async function init() {
    if (initCalled) return;
    initCalled = true;

    if (!BGCrypto.isSupported()) {
      document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#fff;"><h2>Browser Tidak Didukung</h2><p style="margin-top:12px;color:#888;">Gunakan Chrome terbaru di Android.</p></div>';
      return;
    }

    await BGDB.open();
    await BGDB.requestPersist();
    await BGTutorial.load();

    var pubKey = await BGDB.getConfig('my_public_key');
    var pinEnabled = await BGDB.getConfig('pin_enabled');
    var credId = await BGDB.getConfig('passkey_cred_id');

    if (pubKey && (pinEnabled || credId)) {
      // Show lock screen, then authenticate
      _showLockScreen();
      try {
        if (credId) await loginPasskey();
        else if (pinEnabled) loginPIN();
      } catch(e) {
        // Auth failed — show setup screen so user can recover via backup
        navigateTo('screen-splash');
      }
      return;
    }

    if (pubKey) {
      await loadIdentity(pubKey);
      await loadData();
      state.ready = true;
      navigateTo('screen-home');
      _kickOffBackgroundJobs();
    } else {
      var seenOb = await BGDB.getConfig('seen_onboarding');
      seenOb ? navigateTo('screen-splash') : showOnboarding();
    }

    BGShare.setupLaunchQueue(function(bills){ _handleIncomingBills(bills); });
    _setupBackButton();
  }

  async function loadIdentity(pubKey) {
    state.myPublicKey = pubKey;
    state.myName     = (await BGDB.getConfig('my_name')) || '';
    state.circleName = (await BGDB.getConfig('circle_name')) || '';
    state.circleGenesisId = (await BGDB.getConfig('circle_genesis_id')) || '';
    state.logicalClock = (await BGDB.getConfig('logical_clock')) || 0;

    var wrappedKey = await BGDB.getConfig('my_private_key_wrapped');
    if (wrappedKey) {
      var privB64 = await BGCrypto.unwrapPrivateKey(wrappedKey);
      state.myPrivateKey = await BGCrypto.importPrivateKey(privB64);
    }
  }

  async function loadData() {
    state.bills = await BGDB.getAllBills();
    state.peers = await BGDB.getAllPeers();
    state.recentNettingLogs = (await BGDB.getAllNettingLogs()).slice(-5);
  }

  function _kickOffBackgroundJobs() {
    if (_jobsRunning) return; // B2: prevent double-call
    _jobsRunning = true;
    // run after first render
    setTimeout(async function() {
      try {
        await BGNote.checkDefaults(); // flip overdue bills to DEFAULTED
        if (!_isNettingRunning) {
          _isNettingRunning = true;
          try {
            var nettingResults = await BGNetting.runNetting(state.bills);
            if (nettingResults.length) {
              await loadData();
              BGUI.showToast('\u26A1 Hapus Silang: utang terhapus otomatis!', 'success', 5000);
              BGUI.playSound('success');
              BGUI.vibrate([50, 50, 150]);
              if (currentScreen === 'screen-home') RenderHome.render(state);
            }
          } finally { _isNettingRunning = false; }
        }
        await BGReputation.updateAllReputations();
        // Start P2P if circle joined
        if (state.circleGenesisId) {
          BGRTC.startAutoSync(state.circleGenesisId);
        }
      } finally { _jobsRunning = false; }
    }, 1500);
  }

  // ---- Lock screen ----

  function _showLockScreen() {
    var overlay = document.getElementById('screen-lock');
    if (overlay) {
      overlay.style.display = 'flex';
    } else {
      navigateTo('screen-splash');
    }
  }

  // ---- PIN auth ----

  function loginPIN() {
    var overlay = document.getElementById('screen-lock');
    if (overlay) {
      var msg = overlay.querySelector('.lock-msg');
      if (msg) msg.textContent = 'Masukkan PIN untuk membuka';
      var pinMode = overlay.querySelector('#lock-mode-pin');
      var passkeyMode = overlay.querySelector('#lock-mode-passkey');
      if (pinMode) pinMode.style.display = 'block';
      if (passkeyMode) passkeyMode.style.display = 'none';
    }
    _clearPINInput();
  }

  function _clearPINInput() {
    var inp = document.getElementById('pin-input-display');
    if (inp) inp.dataset.value = '';
    document.querySelectorAll('.pin-dot').forEach(function(d){ d.classList.remove('filled'); });
  }

  function pinKeyPress(digit) {
    var inp = document.getElementById('pin-input-display');
    if (!inp) return;
    var cur = inp.dataset.value || '';
    if (cur.length >= 6) return;
    cur += digit;
    inp.dataset.value = cur;
    // update dots
    document.querySelectorAll('.pin-dot').forEach(function(d, i){ d.classList.toggle('filled', i < cur.length); });
    if (cur.length >= 4) {
      // auto-submit after small delay
      setTimeout(function(){ _submitPIN(cur); }, 150);
    }
  }

  function pinBackspace() {
    var inp = document.getElementById('pin-input-display');
    if (!inp) return;
    var cur = inp.dataset.value || '';
    inp.dataset.value = cur.slice(0, -1);
    document.querySelectorAll('.pin-dot').forEach(function(d, i){ d.classList.toggle('filled', i < inp.dataset.value.length); });
  }

  async function _submitPIN(pin) {
    var storedHash = await BGDB.getConfig('pin_hash');
    if (!storedHash) { _clearPINInput(); return; }
    var hash = await _hashPIN(pin);
    if (hash === storedHash) {
      await _unlockAndInit();
    } else {
      BGUI.vibrate([100, 50, 100]);
      _clearPINInput();
      var msg = document.getElementById('lock-error-msg');
      if (msg) { msg.textContent = 'PIN salah. Coba lagi.'; msg.style.display = 'block'; }
      setTimeout(function(){ if(msg) msg.style.display = 'none'; }, 2000);
    }
  }

  async function _hashPIN(pin) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('nk:pin:' + pin));
    return Array.from(new Uint8Array(buf)).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  }

  // ---- Passkey auth ----

  async function loginPasskey() {
    var overlay = document.getElementById('screen-lock');
    if (overlay) {
      var msg = overlay.querySelector('.lock-msg');
      if (msg) msg.textContent = 'Gunakan sidik jari atau wajah';
      var pinMode = overlay.querySelector('#lock-mode-pin');
      var passkeyMode = overlay.querySelector('#lock-mode-passkey');
      if (pinMode) pinMode.style.display = 'none';
      if (passkeyMode) passkeyMode.style.display = 'block';
    }
    try {
      var privKeyB64 = await BGPasskey.authenticate();
      if (privKeyB64) {
        // PRF mode: decrypt and inject private key
        state.myPrivateKey = await BGCrypto.importPrivateKey(privKeyB64);
      }
      await _unlockAndInit();
    } catch(e) {
      // User cancelled or error — fall back to PIN if available
      var pinEnabled = await BGDB.getConfig('pin_enabled');
      if (pinEnabled) loginPIN();
      else { BGUI.showToast('Gagal: ' + e.message, 'error'); }
    }
  }

  async function _unlockAndInit() {
    var overlay = document.getElementById('screen-lock');
    if (overlay) overlay.style.display = 'none';
    var pubKey = await BGDB.getConfig('my_public_key');
    if (pubKey) {
      await loadIdentity(pubKey);
      await loadData();
      state.ready = true;
      navigateTo('screen-home');
      _kickOffBackgroundJobs();
    }
  }

  // ---- Register passkey from settings ----

  async function registerPasskey() {
    if (!BGPasskey.isSupported()) {
      BGUI.showToast('Passkey tidak didukung di browser ini.', 'error'); return;
    }
    if (!state.myPrivateKey) {
      BGUI.showToast('Kunci tidak tersedia.', 'error'); return;
    }
    var ok = await BGUI.showModal('Daftarkan Sidik Jari',
      '<p style="margin:0 0 12px;">Gunakan sidik jari atau wajah untuk membuka Nota Kita. Identitas kamu tetap aman meskipun cache dihapus.</p>');
    if (!ok) return;
    BGUI.showLoading('Mendaftarkan passkey...');
    try {
      var privKeyB64 = await BGCrypto.exportPrivateKey(state.myPrivateKey);
      var result = await BGPasskey.register(privKeyB64, state.myName, state.myPublicKey);
      await BGDB.setConfig('passkey_enabled', true);
      BGUI.showToast(result.prfSupported ?
        'Sidik jari terdaftar. Identitas terenkripsi dengan kunci biometrik.' :
        'Sidik jari terdaftar (mode gate, backup tetap disarankan).', 'success');
      RenderSettings.render(state);
    } catch(e) {
      BGUI.showToast('Gagal: ' + e.message, 'error');
    } finally { BGUI.hideLoading(); }
  }

  async function removePasskey() {
    var ok = await BGUI.showModal('Hapus Passkey', '<p style="margin:0;">Yakin ingin menonaktifkan login sidik jari?</p>');
    if (!ok) return;
    await BGPasskey.unregister();
    await BGDB.setConfig('passkey_enabled', false);
    BGUI.showToast('Passkey dinonaktifkan.', 'success');
    RenderSettings.render(state);
  }

  // ---- Setup PIN ----

  async function setupPIN() {
    var cur = await BGDB.getConfig('pin_hash');
    var title = cur ? 'Ubah atau Hapus PIN' : 'Atur Kunci PIN';
    var body = '<div class="form-group"><label class="form-label">PIN Baru (4-6 digit)</label>' +
      '<input class="form-input" id="pin-new" type="number" placeholder="mis. 1234" maxlength="6" pattern="[0-9]*" inputmode="numeric"></div>' +
      (cur ? '<div class="form-group"><label class="form-label">Konfirmasi PIN</label>' +
      '<input class="form-input" id="pin-confirm" type="number" placeholder="Ulangi PIN" maxlength="6" pattern="[0-9]*" inputmode="numeric"></div>' : '') +
      (cur ? '<button class="btn btn-outline" style="margin-top:8px;border-color:var(--red);color:var(--red);width:100%;" onclick="BG.disablePIN()">Hapus PIN</button>' : '');
    var ok = await BGUI.showModal(title, body);
    if (!ok) return;
    var newPin = (document.getElementById('pin-new') ? document.getElementById('pin-new').value : '').trim();
    if (!newPin || newPin.length < 4 || newPin.length > 6 || !/^\d+$/.test(newPin)) {
      BGUI.showToast('PIN harus 4-6 digit angka.', 'error'); return;
    }
    var hash = await _hashPIN(newPin);
    await BGDB.setConfig('pin_hash', hash);
    await BGDB.setConfig('pin_enabled', true);
    BGUI.showToast('PIN berhasil diatur.', 'success');
    RenderSettings.render(state);
  }

  async function disablePIN() {
    BGUI.dismissModal();
    await BGDB.setConfig('pin_hash', null);
    await BGDB.setConfig('pin_enabled', false);
    BGUI.showToast('PIN dinonaktifkan.', 'success');
    RenderSettings.render(state);
  }

  // ---- Setup (new user) ----

  async function finishSetup() {
    if (isProcessing) return;
    var nameInput = document.getElementById('setup-name');
    var circleInput = document.getElementById('setup-circle-name');
    var name = (nameInput ? nameInput.value : '').trim().replace(/[\x00-\x1f\x7f]/g, '');
    var circleName = (circleInput ? circleInput.value : '').trim().replace(/[\x00-\x1f\x7f]/g, '');

    if (!name || name.length < 2) { BGUI.showToast('Ketik nama anda (min 2 huruf).'); return; }
    if (!circleName || circleName.length < 2) { BGUI.showToast('Ketik nama kelompok (min 2 huruf).'); return; }

    isProcessing = true;
    BGUI.showLoading('Membuat identitas...');
    try {
      var kp = await BGCrypto.generateKeyPair();
      var pub = await BGCrypto.exportPublicKey(kp.publicKey);
      var priv = await BGCrypto.exportPrivateKey(kp.privateKey);
      var wrapped = await BGCrypto.wrapPrivateKey(priv);

      // Create founding circle
      var genesis = await BGCircle.createCircle(circleName, kp.privateKey, pub);

      await BGDB.setConfig('my_public_key', pub);
      await BGDB.setConfig('my_private_key_wrapped', wrapped);
      await BGDB.setConfig('my_name', name);
      await BGDB.setConfig('circle_name', circleName);
      await BGDB.setConfig('circle_genesis_id', genesis.genesis_id);
      await BGDB.setConfig('logical_clock', 0);

      // add self as peer
      await BGDB.savePeer({ pub_key: pub, nama: name, last_sync: Date.now(), reputation_score: 100, is_self: true });

      state.myPublicKey = pub;
      state.myPrivateKey = kp.privateKey;
      state.myName = name;
      state.circleName = circleName;
      state.circleGenesisId = genesis.genesis_id;
      state.bills = [];
      state.peers = [{ pub_key: pub, nama: name }];
      state.ready = true;

      BGUI.playSound('success');
      BGUI.vibrate([100, 50, 100]);
      navigateTo('screen-home');
      BGUI.showToast('Selamat datang, ' + name + '! Kelompok "' + circleName + '" dibuat.', 'success');
    } catch(e) {
      BGUI.showToast('Gagal: ' + e.message, 'error');
    } finally {
      BGUI.hideLoading();
      isProcessing = false;
    }
  }

  // ---- Setup step wizard ----

  function setupNextStep() {
    var nameInput = document.getElementById('setup-name');
    var name = nameInput ? nameInput.value.trim() : '';
    if (!name || name.length < 2) { BGUI.showToast('Ketik nama anda (min 2 huruf).'); return; }
    document.getElementById('setup-step-1').classList.remove('active');
    document.getElementById('setup-step-2').classList.add('active');
    var b1 = document.getElementById('spb-1'); if(b1){ b1.classList.add('done'); b1.classList.remove('active'); }
    var b2 = document.getElementById('spb-2'); if(b2){ b2.classList.add('active'); }
    document.getElementById('setup-circle-name').focus();
  }

  function setupPrevStep() {
    document.getElementById('setup-step-2').classList.remove('active');
    document.getElementById('setup-step-1').classList.add('active');
    var b1 = document.getElementById('spb-1'); if(b1){ b1.classList.remove('done'); b1.classList.add('active'); }
    var b2 = document.getElementById('spb-2'); if(b2){ b2.classList.remove('active'); }
    document.getElementById('setup-name').focus();
  }

  // ---- Buat Nota wizard ----

  var _wizardStep = 1;
  var _wizardTotal = 4;

  function wizardNext() {
    if (_wizardStep >= _wizardTotal) return;
    document.getElementById('wizard-step-' + _wizardStep).classList.remove('active');
    _wizardStep++;
    document.getElementById('wizard-step-' + _wizardStep).classList.add('active');
    _updateWizardProgress();
  }

  function wizardPrev() {
    if (_wizardStep <= 1) { navigateTo('screen-home'); return; }
    document.getElementById('wizard-step-' + _wizardStep).classList.remove('active');
    _wizardStep--;
    document.getElementById('wizard-step-' + _wizardStep).classList.add('active');
    _updateWizardProgress();
  }

  function _updateWizardProgress() {
    var countEl = document.getElementById('wizard-step-count');
    if (countEl) countEl.textContent = _wizardStep + ' / ' + _wizardTotal;
    for (var i = 1; i <= _wizardTotal; i++) {
      var dot = document.getElementById('wp-' + i);
      if (!dot) continue;
      dot.classList.remove('done', 'active');
      if (i < _wizardStep) dot.classList.add('done');
      else if (i === _wizardStep) dot.classList.add('active');
    }
    // Show/hide back button
    var backBtn = document.getElementById('wizard-back-btn');
    if (backBtn) backBtn.style.visibility = _wizardStep === 1 ? 'hidden' : 'visible';
  }

  // Reset wizard state when navigating to Buat Nota screen
  function _resetWizard() {
    _wizardStep = 1;
    for (var i = 1; i <= _wizardTotal; i++) {
      var el = document.getElementById('wizard-step-' + i);
      if (el) { el.classList.remove('active'); }
    }
    var s1 = document.getElementById('wizard-step-1');
    if (s1) s1.classList.add('active');
    _updateWizardProgress();
  }

  // ---- Navigation ----

  function _setupBackButton() {
    history.replaceState({ screen: currentScreen }, '');
    window.addEventListener('popstate', function() {
      BGUI.dismissModal();
      BGTutorial.dismiss();
      if (screenHistory.length) {
        switchScreen(screenHistory.pop());
      } else {
        history.pushState({ screen: currentScreen }, '');
      }
    });
  }

  function navigateTo(screenId) {
    if (currentScreen === screenId) return; // B3: no-op if already on same screen
    if (currentScreen) screenHistory.push(currentScreen);
    history.pushState({ screen: screenId }, '');
    switchScreen(screenId);
    BGUI.vibrate(20);
    setTimeout(function(){ BGTutorial.showForScreen(screenId); }, 600);
  }

  function switchScreen(screenId) {
    BGUI.dismissModal();
    BGTutorial.dismiss();

    // cleanup leaving screen
    if (currentScreen === 'screen-scan') { BGQR.stopScan(); BGFountain.resetReceive(); }
    if (currentScreen === 'screen-qr-show') { BGFountain.stopSend(); }

    document.querySelectorAll('.screen').forEach(function(el){ el.classList.remove('active'); });
    var target = document.getElementById(screenId);
    if (!target) return;
    target.classList.add('active');
    currentScreen = screenId;
    _updateBottomNav(screenId);
    _runScreenInit(screenId);
  }

  function _updateBottomNav(screenId) {
    var map = { 'screen-home': 0, 'screen-buku-saku': 1, 'screen-buku-besar': 2, 'screen-sync': 3, 'screen-settings': 4, 'screen-peers': 4 };
    var bnav = document.getElementById('bottom-nav');
    var showOn = ['screen-home','screen-buku-saku','screen-buku-besar','screen-sync','screen-settings','screen-peers','screen-reports'];
    if (bnav) bnav.style.display = showOn.includes(screenId) ? 'flex' : 'none';
    document.querySelectorAll('.bnav-tab').forEach(function(tab, i){ tab.classList.toggle('active', i === map[screenId]); });
  }

  function _runScreenInit(id) {
    if (!state.ready && id !== 'screen-splash') return;
    if (id === 'screen-home')       RenderHome.render(state);
    if (id === 'screen-buku-saku')  RenderLedger.renderBukuSaku(state, _bukuSakuStatusFilter);
    if (id === 'screen-buku-besar') RenderLedger.renderBukuBesar(state);
    if (id === 'screen-buat-nota')  _resetWizard();
    if (id === 'screen-settings')   RenderSettings.render(state);
    if (id === 'screen-peers')      RenderPeers.render(state);
    if (id === 'screen-reports')    RenderReports.render(state);
  }

  function bnavGo(screenId) {
    if (currentScreen === screenId) return;
    screenHistory = [];
    history.replaceState({ screen: screenId }, '');
    switchScreen(screenId);
    BGUI.vibrate(20);
  }

  // ---- Sync orchestration ----

  async function processSyncData(data, source) {
    var parsed = BGMerge.parseIncoming(data.bills || []);
    var existingIds = await BGDB.getBillIds();
    var result = await BGMerge.merge(existingIds, parsed.bills);

    // save sender as peer
    if (parsed.meta && parsed.meta.sender_pub_key) {
      var known = await BGCircle.isMember(parsed.meta.sender_pub_key);
      if (!known) { console.warn('processSyncData: unknown peer, ignoring'); return; }
      await BGDB.savePeer({
        pub_key: parsed.meta.sender_pub_key,
        nama: parsed.meta.sender_name || parsed.meta.sender_pub_key.substring(0, 12),
        last_sync: Date.now()
      });
    }

    // ingest oracle prices
    if (data.oracle_prices && Array.isArray(data.oracle_prices)) {
      for (var i = 0; i < data.oracle_prices.length; i++) {
        await BGOracle.receivePriceFromPeer(data.oracle_prices[i]);
      }
    }

    if (result.alarm) {
      BGUI.showToast(result.alarmDetail, 'error', 6000);
      BGUI.playSound('alarm');
    }

    if (result.newBills.length) {
      await BGDB.saveBulkBills(result.newBills);
      await loadData();
      // H3: use netting mutex to prevent concurrent netting from multiple peers
      if (!_isNettingRunning) {
        _isNettingRunning = true;
        try {
          var nettingResults = await BGNetting.runNetting(state.bills);
          if (nettingResults.length) {
            await loadData();
            BGUI.showToast('\u26A1 Hapus Silang: utang terhapus!', 'success', 5000);
          }
        } finally { _isNettingRunning = false; }
      }
      BGUI.showToast(result.newBills.length + ' nota baru diterima dari ' + source, 'success');
      if (currentScreen === 'screen-home') RenderHome.render(state);
      if (currentScreen === 'screen-buku-saku') RenderLedger.renderBukuSaku(state);
      if (currentScreen === 'screen-buku-besar') RenderLedger.renderBukuBesar(state);
    }
  }

  // ---- Bill actions (called from renderers / HTML) ----

  async function openBillDetail(bill_id) {
    navigateTo('screen-bill-detail');
    await RenderBills.renderDetail(bill_id, state);
  }

  async function viewBillsWith(pub_key) {
    // filter buku saku to only show bills with this counterparty
    navigateTo('screen-buku-saku');
    var filterEl = document.getElementById('buku-saku-filter');
    var peer = state.peers.find(function(p){ return p.pub_key === pub_key; });
    if (filterEl && peer) { filterEl.value = peer.nama || ''; }
    RenderLedger.renderBukuSaku(state);
  }

  async function initSettle(bill_id) {
    // show settle modal — amount pre-filled
    var bill = await BGDB.getBillById(bill_id);
    if (!bill) return;
    var totalOwed = BGInterest.calcTotal(bill);
    var totalStr = BGUI.formatAmount(totalOwed, bill.asset_type, bill.asset_unit, bill.asset_name);

    var body = BGUI.buildBillPreview(bill, state.myPublicKey, state.peers) +
      '<div class="form-group mt-4"><label class="form-label">Jumlah Dilunasi</label>' +
      '<input class="form-input" id="settle-amount" value="' + totalOwed + '" type="number" min="1" max="' + totalOwed + '"></div>' +
      '<div class="form-group"><label class="form-label">Cara Bayar</label>' +
      '<select class="form-select" id="settle-method">' +
      '<option value="FIAT">Uang Tunai / Transfer</option>' +
      '<option value="COMMODITY">Serahkan Barang Fisik</option>' +
      '</select></div>';

    var confirmed = await BGUI.showModal('Lunasi Nota', body);
    if (!confirmed) return;

    var amount = parseFloat(document.getElementById('settle-amount').value) || totalOwed;
    var method = document.getElementById('settle-method').value;

    isProcessing = true;
    BGUI.showLoading('Membuat nota pelunasan...');
    try {
      state.logicalClock++;
      var settlement = await BGNote.createSettlement(bill_id, amount, method, state.myPrivateKey, state.myPublicKey, state.logicalClock);
      await BGDB.setConfig('logical_clock', state.logicalClock);
      // show settlement QR for counterparty to confirm
      await _showQR(BGNote.toQRPayload(settlement), 'Minta ' + BGUI.peerName(bill.to_pub_key, state.peers) + ' untuk scan QR ini sebagai bukti pelunasan.');
    } catch(e) {
      BGUI.showToast('Gagal: ' + e.message, 'error');
    } finally {
      BGUI.hideLoading();
      isProcessing = false;
    }
  }

  async function initEndorse(bill_id) {
    var bill = await BGDB.getBillById(bill_id);
    if (!bill) return;
    var totalOwed = BGInterest.calcTotal(bill);

    // Build peer select (exclude self, exclude bill parties)
    var selectablePeers = state.peers.filter(function(p){ return !p.is_self && p.pub_key !== bill.from_pub_key && p.pub_key !== bill.to_pub_key; });
    var peerOpts = '<option value="">-- Pilih Anggota --</option>';
    selectablePeers.forEach(function(p){
      peerOpts += '<option value="' + BGUI.escapeHtml(p.pub_key) + '">' + BGUI.escapeHtml(p.nama) + '</option>';
    });

    var body = BGUI.buildBillPreview(bill, state.myPublicKey, state.peers) +
      '<div class="form-group mt-4"><label class="form-label">Jumlah Dioper</label>' +
      '<input class="form-input" id="endorse-amount" type="number" min="1" max="' + totalOwed + '" placeholder="' + totalOwed + '"></div>' +
      '<div class="form-group"><label class="form-label">Oper Ke</label>' +
      '<select class="form-select" id="endorse-to">' + peerOpts + '</select></div>';

    if (!selectablePeers.length) {
      BGUI.showToast('Tidak ada anggota lain untuk menerima nota.', 'error'); return;
    }

    var confirmed = await BGUI.showModal('Oper Nota Ke Orang Lain', body);
    if (!confirmed) return;

    var amount = parseFloat(document.getElementById('endorse-amount').value) || totalOwed;
    var toPubKey = document.getElementById('endorse-to').value;
    if (!toPubKey) { BGUI.showToast('Pilih anggota tujuan.', 'error'); return; }
    var toPeer = state.peers.find(function(p){ return p.pub_key === toPubKey; });
    if (!toPeer) { BGUI.showToast('Anggota tidak ditemukan.', 'error'); return; }

    isProcessing = true;
    BGUI.showLoading('Memproses oper nota...');
    try {
      state.logicalClock++;
      var result = await BGEndorse.splitBill(bill_id, toPeer.pub_key, amount, state.myPrivateKey, state.myPublicKey, state.logicalClock);
      await BGDB.setConfig('logical_clock', state.logicalClock);
      await loadData();
      await _showQR(BGNote.toQRPayload(result.endorsed), 'Minta ' + BGUI.peerName(toPeer.pub_key, state.peers) + ' untuk scan QR ini.');
      BGUI.playSound('success');
    } catch(e) {
      BGUI.showToast('Gagal oper: ' + e.message, 'error');
    } finally {
      BGUI.hideLoading();
      isProcessing = false;
    }
  }

  async function confirmSettlementFromDetail(bill_id) {
    if (isProcessing) return;
    var settlement = await BGDB.getBillById(bill_id);
    if (!settlement) return;
    var confirmed = await BGUI.showModal('Konfirmasi Lunas?', BGUI.buildBillPreview(settlement, state.myPublicKey, state.peers));
    if (!confirmed) return;

    isProcessing = true;
    BGUI.showLoading('Mengkonfirmasi...');
    try {
      state.logicalClock++;
      var result = await BGNote.confirmSettlement(settlement, state.myPrivateKey, state.myPublicKey, state.logicalClock);
      await BGDB.setConfig('logical_clock', state.logicalClock);
      await loadData();
      BGUI.playSound('success');
      BGUI.vibrate([100, 50, 200]);
      BGUI.showToast('Nota dinyatakan LUNAS!', 'success', 4000);
      await BGReputation.updateReputation(settlement.from_pub_key);
      navigateTo('screen-home');
    } catch(e) {
      BGUI.showToast('Gagal: ' + e.message, 'error');
    } finally {
      BGUI.hideLoading();
      isProcessing = false;
    }
  }

  // Called from bill detail when status = PENDING_ACCEPTANCE (debtor must accept)
  async function acceptBillFromDetail(bill_id) {
    if (isProcessing) return;
    var bill = await BGDB.getBillById(bill_id);
    if (!bill) return;
    var confirmed = await BGUI.showModal('Terima & Konfirmasi Nota?', BGUI.buildBillPreview(bill, state.myPublicKey, state.peers));
    if (!confirmed) return;

    isProcessing = true;
    BGUI.showLoading('Mengkonfirmasi...');
    try {
      state.logicalClock++;
      await BGNote.acceptBill(bill, state.myPrivateKey, state.myPublicKey, state.logicalClock);
      await BGDB.setConfig('logical_clock', state.logicalClock);
      await loadData();
      BGUI.playSound('success');
      BGUI.vibrate([50, 50, 100]);
      BGUI.showToast('Nota diterima dan dikonfirmasi!', 'success');
      navigateTo('screen-home');
    } catch(e) {
      BGUI.showToast('Gagal: ' + e.message, 'error');
    } finally {
      BGUI.hideLoading();
      isProcessing = false;
    }
  }

  // ---- QR actions ----

  async function _showQR(payload, label) {
    navigateTo('screen-qr-show');
    var canvas = document.getElementById('qr-show-canvas');
    var labelEl = document.getElementById('qr-show-label');
    if (labelEl) labelEl.textContent = label || 'Minta pihak lain untuk scan QR ini.';
    if (canvas) {
      if (payload.length > 1800) {
        // Fountain: wrap string payload as single-item array for compressArray
        navigateTo('screen-fountain');
        var statusEl = document.getElementById('fountain-status');
        var fCanvas = document.getElementById('fountain-canvas');
        if (fCanvas) {
          BGFountain.startSend([{ _raw: payload }], {}, fCanvas, function(s){
            if (statusEl) statusEl.textContent = s;
          });
        }
      } else {
        BGQR.generateToCanvas(payload, canvas, 260);
      }
    }
  }

  function startScan() {
    BGFountain.resetReceive(); // clear any lingering fountain receive state
    navigateTo('screen-scan');
    var video = document.getElementById('scan-video');
    BGQR.startScan(video, async function(result) {
      BGQR.stopScan();
      await _handleScannedPayload(result);
    }, function(err){
      BGUI.showToast('Kamera error: ' + err, 'error');
    });
  }

  async function _handleScannedPayload(raw) {
    try {
      var obj = JSON.parse(raw);

      if (obj._mb === 1) {
        // circle invite
        BGUI.showLoading('Bergabung ke kelompok...');
        var genesis = BGCircle.fromInvitePayload(raw);
        await BGCircle.joinCircle(genesis);
        state.circleName = genesis.circle_name;
        state.circleGenesisId = genesis.genesis_id;
        await BGDB.setConfig('circle_name', genesis.circle_name);
        await BGDB.setConfig('circle_genesis_id', genesis.genesis_id);
        BGUI.hideLoading();
        BGUI.showToast('Bergabung ke kelompok "' + genesis.circle_name + '"!', 'success');
        BGRTC.startAutoSync(genesis.genesis_id);
        navigateTo('screen-home');
        return;
      }

      if (obj._mb === 2) {
        // bill / settlement
        var bill = BGNote.fromQRPayload(raw);
        var preview = BGUI.buildBillPreview(bill, state.myPublicKey, state.peers);
        var confirmed = await BGUI.showModal(
          bill.type === 'SETTLEMENT' ? 'Konfirmasi Pelunasan?' : 'Terima Nota Ini?',
          preview
        );
        if (!confirmed) { navigateTo('screen-home'); return; }

        if (isProcessing) { navigateTo('screen-home'); return; } // C2: prevent double-scan
        isProcessing = true;
        state.logicalClock++;
        BGUI.showLoading('Menyimpan...');

        try {
          if (bill.type === 'SETTLEMENT') {
            await BGNote.confirmSettlement(bill, state.myPrivateKey, state.myPublicKey, state.logicalClock);
            BGUI.showToast('Nota dinyatakan LUNAS!', 'success');
            await BGReputation.updateReputation(bill.from_pub_key);
          } else {
            await BGNote.acceptBill(bill, state.myPrivateKey, state.myPublicKey, state.logicalClock);
            BGUI.showToast('Nota diterima!', 'success');
          }

          await BGDB.setConfig('logical_clock', state.logicalClock);
          await loadData();
          BGUI.hideLoading();
          BGUI.playSound('success');
          BGUI.vibrate([50, 50, 100]);
          navigateTo('screen-home');
        } catch(e) {
          BGUI.hideLoading();
          BGUI.showToast('Gagal: ' + e.message, 'error');
          navigateTo('screen-home');
        } finally {
          isProcessing = false;
        }
        return;
      }

      BGUI.showToast('QR tidak dikenali.', 'error');
      navigateTo('screen-home');
    } catch(e) {
      BGUI.hideLoading();
      BGUI.showToast('Gagal baca QR: ' + e.message, 'error');
      navigateTo('screen-home');
    }
  }

  // ---- File share (incoming) ----

  async function _handleIncomingBills(bills) {
    await processSyncData({ bills: bills }, 'file');
  }

  function setOnlineStatus(online) {
    state.isOnline = online;
    var dot = document.getElementById('online-dot');
    if (dot) dot.classList.toggle('online', online);
  }

  function showToast(msg, type, dur) { BGUI.showToast(msg, type, dur); }

  // ---- Onboarding ----

  var obSlide = 0;
  function showOnboarding() {
    obSlide = 0;
    var el = document.getElementById('onboarding');
    if (el) el.classList.add('show');
    _updateObSlide();
  }
  function nextOnboarding() {
    obSlide++;
    if (obSlide >= document.querySelectorAll('.onboarding-slide').length) { skipOnboarding(); return; }
    _updateObSlide();
  }
  function skipOnboarding() {
    var el = document.getElementById('onboarding');
    if (el) el.style.display = 'none';
    BGDB.setConfig('seen_onboarding', true);
    navigateTo('screen-splash');
  }
  function _updateObSlide() {
    document.querySelectorAll('.onboarding-slide').forEach(function(s, i){ s.classList.toggle('active', i === obSlide); });
    document.querySelectorAll('.ob-dot').forEach(function(d, i){ d.classList.toggle('active', i === obSlide); });
    var btn = document.getElementById('ob-next');
    var total = document.querySelectorAll('.onboarding-slide').length;
    if (btn) btn.textContent = obSlide >= total - 1 ? 'Mulai!' : 'Lanjut \u2192';
  }

  // ---- Onboarding show ----
  function showOnboardingOverride() {
    obSlide = 0;
    var el = document.getElementById('onboarding');
    if (el) el.style.display = 'flex';
    _updateObSlide();
  }

  // ---- Buat Nota form state ----

  var _assetType = 'FIAT';
  var _interestMode = 'NONE';

  function setAssetType(type) {
    _assetType = type;
    document.getElementById('btn-type-fiat').classList.toggle('active', type === 'FIAT');
    document.getElementById('btn-type-commodity').classList.toggle('active', type === 'COMMODITY');
    document.getElementById('group-currency').style.display  = type === 'FIAT' ? '' : 'none';
    document.getElementById('group-commodity').style.display = type === 'COMMODITY' ? '' : 'none';
    var hint = document.getElementById('nota-amount-hint');
    if (hint) hint.textContent = type === 'FIAT' ? 'Masukkan jumlah uang.' : 'Masukkan jumlah barang.';
    _populateDebtorSelect();
  }

  function setInterestMode(mode) {
    _interestMode = mode;
    document.getElementById('chip-no-interest').classList.toggle('active', mode === 'NONE');
    document.getElementById('chip-simple').classList.toggle('active', mode === 'SIMPLE');
    document.getElementById('chip-compound').classList.toggle('active', mode === 'COMPOUND');
    document.getElementById('group-interest-rate').style.display = mode === 'NONE' ? 'none' : '';
    var hint = document.getElementById('hint-interest-type');
    if (hint) hint.textContent = mode === 'SIMPLE' ? 'Bunga dihitung dari pokok awal.' : mode === 'COMPOUND' ? 'Bunga dihitung dari saldo + bunga sebelumnya.' : '';
  }

  function _populateDebtorSelect() {
    var sel = document.getElementById('nota-debtor');
    var gsel = document.getElementById('nota-guarantor');
    if (!sel) return;
    var peers = state.peers.filter(function(p){ return !p.is_self; });
    var opts = '<option value="">-- Pilih Anggota --</option>';
    var gopts = '<option value="">-- Tidak Ada Penjamin --</option>';
    peers.forEach(function(p){
      opts += '<option value="' + BGUI.escapeHtml(p.pub_key) + '">' + BGUI.escapeHtml(p.nama) + '</option>';
      gopts += '<option value="' + BGUI.escapeHtml(p.pub_key) + '">' + BGUI.escapeHtml(p.nama) + '</option>';
    });
    sel.innerHTML = opts;
    if (gsel) gsel.innerHTML = gopts;
  }

  async function buatNota() {
    if (isProcessing) return;
    var debtor = document.getElementById('nota-debtor').value;
    if (!debtor) { BGUI.showToast('Pilih anggota yang berhutang.', 'error'); return; }

    var rawAmt = BGUI.getNominalRaw('nota-amount');
    if (!rawAmt) { BGUI.showToast('Isi jumlah nota.', 'error'); return; }

    var unit = _assetType === 'FIAT'
      ? (document.getElementById('nota-currency').value || 'IDR')
      : (document.getElementById('nota-unit').value || 'KG');
    var assetName = _assetType === 'COMMODITY'
      ? (document.getElementById('nota-asset-name').value || '').trim()
      : null;

    if (_assetType === 'COMMODITY' && !assetName) {
      BGUI.showToast('Isi nama barang.', 'error'); return;
    }

    var keterangan = (document.getElementById('nota-keterangan').value || '').trim();
    var dueDateStr = document.getElementById('nota-due').value;
    var dueDate = dueDateStr ? new Date(dueDateStr).getTime() : null;
    var graceDays = parseInt(document.getElementById('nota-grace').value) || 0;
    var interestRate = _interestMode !== 'NONE'
      ? (parseFloat(document.getElementById('nota-interest-rate').value) || 0) : 0;
    var guarantorPub = document.getElementById('nota-guarantor').value || null;

    isProcessing = true;
    BGUI.showLoading('Membuat nota...');
    try {
      state.logicalClock++;
      // from_pub_key = debtor (who owes, berhutang)
      // to_pub_key   = me/kreditur (who holds the claim, who accepts the bill)
      // pub_key/signer = me (creditor creates and signs the nota)
      // circleGenesisId as 5th positional arg (not in params)
      var bill = await BGNote.createBill({
        from_pub_key: debtor,
        to_pub_key:   state.myPublicKey,
        asset_type:   _assetType,
        asset_unit:   unit,
        asset_name:   assetName,
        amount:       rawAmt,
        interest_rate: interestRate,
        interest_type: _interestMode === 'NONE' ? null : _interestMode,
        due_date:     dueDate,
        grace_days:   graceDays,
        keterangan:   keterangan,
        guarantor_pub_key: guarantorPub
      }, state.myPrivateKey, state.myPublicKey, state.logicalClock, state.circleGenesisId);

      await BGDB.setConfig('logical_clock', state.logicalClock);
      await loadData();
      BGUI.hideLoading();
      BGUI.playSound('success');
      await _showQR(BGNote.toQRPayload(bill), 'Minta ' + BGUI.peerName(debtor, state.peers) + ' untuk scan QR ini dan konfirmasi.');
    } catch(e) {
      BGUI.hideLoading();
      BGUI.showToast('Gagal buat nota: ' + e.message, 'error');
    } finally {
      isProcessing = false;
    }
  }

  // ---- Filter buku saku ----

  var _bukuSakuStatusFilter = 'all';
  function filterBukuSaku(mode) {
    _bukuSakuStatusFilter = mode;
    ['all','active','hutang','piutang','settled'].forEach(function(m){
      var el = document.getElementById('filter-' + m);
      if (el) el.classList.toggle('active', m === mode);
    });
    RenderLedger.renderBukuSaku(state, mode);
  }

  // ---- Netting manual ----

  async function runManualNetting() {
    if (isProcessing) return;
    isProcessing = true;
    BGUI.showLoading('Mencari hapus silang...');
    try {
      await loadData();
      var results = await BGNetting.runNetting(state.bills);
      await loadData();
      BGUI.hideLoading();
      if (results.length) {
        BGUI.playSound('success');
        BGUI.vibrate([50, 50, 200]);
        BGUI.showToast('\u26A1 Hapus Silang: ' + results.length + ' kelompok utang terhapus!', 'success', 5000);
        if (currentScreen === 'screen-buku-besar') RenderLedger.renderBukuBesar(state);
        if (currentScreen === 'screen-home') RenderHome.render(state);
      } else {
        BGUI.showToast('Tidak ada utang yang bisa saling dihapus saat ini.', 'info');
      }
    } catch(e) {
      BGUI.hideLoading();
      BGUI.showToast('Error: ' + e.message, 'error');
    } finally {
      isProcessing = false;
    }
  }

  // ---- RTC toggle ----

  var _rtcActive = false;
  function toggleRTC() {
    var btn = document.getElementById('btn-rtc-toggle');
    var txt = document.getElementById('rtc-status-text');
    if (!state.circleGenesisId) { BGUI.showToast('Bergabung ke kelompok dulu.', 'error'); return; }
    if (_rtcActive) {
      BGRTC.stopAutoSync();
      _rtcActive = false;
      if (btn) btn.textContent = 'Aktifkan';
      if (txt) txt.textContent = 'Tidak aktif';
    } else {
      BGRTC.startAutoSync(state.circleGenesisId);
      _rtcActive = true;
      if (btn) btn.textContent = 'Matikan';
      if (txt) txt.textContent = 'Aktif — menunggu peer...';
    }
  }

  // ---- Edit name ----

  async function editName() {
    var body = '<div class="form-group"><label class="form-label">Nama Baru</label><input class="form-input" id="edit-name-input" type="text" value="' + BGUI.escapeHtml(state.myName) + '" maxlength="40"></div>';
    var ok = await BGUI.showModal('Ganti Nama', body);
    if (!ok) return;
    var newName = (document.getElementById('edit-name-input').value || '').trim();
    if (!newName || newName.length < 2) { BGUI.showToast('Nama minimal 2 karakter.', 'error'); return; }
    state.myName = newName;
    await BGDB.setConfig('my_name', newName);
    await BGDB.savePeer({ pub_key: state.myPublicKey, nama: newName, is_self: true, last_sync: Date.now() });
    RenderSettings.render(state);
    BGUI.showToast('Nama diperbarui.', 'success');
  }

  // ---- Circle UI ----

  async function showCircleInviteQR() {
    if (!state.circleGenesisId) { BGUI.showToast('Belum ada kelompok.', 'error'); return; }
    var genesis = await BGDB.getCircle(state.circleGenesisId);
    if (!genesis) { BGUI.showToast('Data kelompok tidak ditemukan.', 'error'); return; }
    var payload = BGCircle.toInvitePayload(genesis);
    await _showQR(payload, 'Tunjukkan QR ini ke calon anggota untuk bergabung.');
  }

  async function copyCircleId() {
    if (!state.circleGenesisId) return;
    try { await navigator.clipboard.writeText(state.circleGenesisId); BGUI.showToast('ID kelompok disalin.', 'success'); } catch(e) {}
  }

  function startScanForCircle() { startScan(); }

  // ---- Key export/import modals ----

  async function exportKeyWithPassword() {
    var body = '<div class="form-group"><label class="form-label">&#x1F512; Password Backup</label><input class="form-input" id="export-pw" type="password" placeholder="min. 6 karakter"><div class="form-hint">File akan dienkripsi dengan password ini. JANGAN lupa passwordnya!</div></div>';
    var ok = await BGUI.showModal('Backup Kunci', body);
    if (!ok) return;
    var pw = (document.getElementById('export-pw').value || '').trim();
    if (pw.length < 6) { BGUI.showToast('Password minimal 6 karakter.', 'error'); return; }
    BGUI.showLoading('Mengenkripsi...');
    try {
      var filename = await BGBackup.exportKey(pw);
      BGUI.hideLoading();
      BGUI.showToast('Backup berhasil: ' + filename, 'success', 5000);
    } catch(e) {
      BGUI.hideLoading();
      BGUI.showToast('Gagal: ' + e.message, 'error');
    }
  }

  async function showImportKeyModal() {
    var body = '<div class="form-group"><label class="form-label">&#x1F4C1; Pilih File Backup</label><input type="file" id="import-key-file" accept=".json" class="form-input" style="padding:8px;"></div><div class="form-group"><label class="form-label">Password</label><input class="form-input" id="import-pw" type="password" placeholder="Password backup"></div>';
    var ok = await BGUI.showModal('Pulihkan dari Backup', body);
    if (!ok) return;
    var file = document.getElementById('import-key-file').files[0];
    var pw = document.getElementById('import-pw').value || '';
    if (!file) { BGUI.showToast('Pilih file backup.', 'error'); return; }
    BGUI.showLoading('Memulihkan...');
    try {
      var result = await BGBackup.importKey(file, pw);
      BGUI.hideLoading();
      BGUI.showToast('Kunci berhasil dipulihkan. Silakan muat ulang.', 'success', 5000);
      setTimeout(function(){ location.reload(); }, 2000);
    } catch(e) {
      BGUI.hideLoading();
      BGUI.showToast('Gagal: ' + e.message, 'error');
    }
  }

  // ---- Oracle price modal ----

  async function showOraclePriceModal() {
    var body = '<div class="form-group"><label class="form-label">Satuan</label><input class="form-input" id="oracle-unit" placeholder="KG, Liter, dsb"></div>' +
      '<div class="form-group"><label class="form-label">Nama Barang</label><input class="form-input" id="oracle-name" placeholder="Beras, Pupuk, dsb"></div>' +
      '<div class="form-group"><label class="form-label">Harga per Satuan</label><input class="form-input" id="oracle-price" type="number" placeholder="mis. 15000"></div>' +
      '<div class="form-group"><label class="form-label">Mata Uang</label><select class="form-select" id="oracle-currency"><option value="IDR">IDR</option><option value="USD">USD</option></select></div>';
    var ok = await BGUI.showModal('Update Harga Barang', body);
    if (!ok) return;
    var unit = (document.getElementById('oracle-unit').value || '').trim().toUpperCase();
    var name = (document.getElementById('oracle-name').value || '').trim();
    var price = parseFloat(document.getElementById('oracle-price').value);
    var cur = document.getElementById('oracle-currency').value || 'IDR';
    if (!unit || !name || !price) { BGUI.showToast('Isi semua kolom.', 'error'); return; }
    try {
      await BGOracle.injectPrice(unit, name, price, cur, state.myPrivateKey, state.myPublicKey);
      BGUI.showToast('Harga ' + name + ' diperbarui: ' + cur + ' ' + price.toLocaleString('id-ID') + '/' + unit, 'success');
    } catch(e) {
      BGUI.showToast('Gagal: ' + e.message, 'error');
    }
  }

  // ---- File export/import bills ----

  async function exportBillsFile() {
    var compressed = BGMerge.compressArray(state.bills, getSyncState().meta);
    var json = JSON.stringify(compressed);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'nota-kita-' + new Date().toISOString().split('T')[0] + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 200);
    BGUI.showToast('Data diekspor.', 'success');
  }

  function importBillsFile() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async function() {
      var file = input.files[0];
      if (!file) return;
      BGUI.showLoading('Membaca file...');
      try {
        var text = await file.text();
        var data = JSON.parse(text);
        await processSyncData({ bills: data }, 'file');
        BGUI.hideLoading();
      } catch(e) {
        BGUI.hideLoading();
        BGUI.showToast('File tidak valid: ' + e.message, 'error');
      }
    };
    input.click();
  }

  // ---- Stop scan passthrough ----
  function stopScan() { BGQR.stopScan(); navigateTo('screen-home'); }
  function toggleFlash() { if (BGQR.toggleFlash) BGQR.toggleFlash(); }

  // ---- Share current QR ----
  var _currentQRPayload = '';
  async function shareCurrentQR() {
    if (_currentQRPayload) await BGShare.shareText(_currentQRPayload, 'Nota Kita');
  }

  // ---- Reset all ----
  async function confirmResetAll() {
    var body = '<p style="color:var(--red);font-weight:600;">Ini akan menghapus SEMUA data di HP ini: nota, kunci, dan kelompok.</p><p style="margin-top:8px;">Pastikan sudah punya backup kunci!</p>';
    var ok = await BGUI.showModal('Hapus Semua Data?', body);
    if (!ok) return;
    var body2 = '<p>Ketik <strong>HAPUS</strong> untuk konfirmasi.</p><input class="form-input" id="reset-confirm" style="margin-top:12px;" placeholder="HAPUS">';
    var ok2 = await BGUI.showModal('Konfirmasi Akhir', body2);
    if (!ok2) return;
    var val = (document.getElementById('reset-confirm').value || '').trim().toUpperCase();
    if (val !== 'HAPUS') { BGUI.showToast('Dibatalkan.', 'info'); return; }
    await BGDB.deleteAllData();
    location.reload();
  }


  // ---- Share bill ----

  async function shareBill(bill_id) {
    var bill = await BGDB.getBillById(bill_id);
    if (!bill) return;
    try {
      var payload = BGNote.toQRPayload(bill);
      await BGShare.shareText(payload, 'Nota Kita');
    } catch(e) {
      BGUI.showToast('Gagal berbagi: ' + e.message, 'error');
    }
  }

  async function shareAllBills() {
    if (!state.bills || !state.bills.length) { BGUI.showToast('Tidak ada data untuk dibagikan.', 'error'); return; }
    BGUI.showLoading('Menyiapkan data...');
    try {
      var meta = { sender: state.myPublicKey, name: state.myName, circle: state.circleGenesisId };
      var compressed = BGMerge.compressArray(state.bills, meta);
      var json = JSON.stringify(compressed);
      var blob = new Blob([json], { type:'application/json' });
      var filename = 'nota-kita-' + new Date().toISOString().split('T')[0] + '.json';
      await BGShare.shareFile(blob, filename, 'Nota Kita');
    } catch(e) {
      BGUI.showToast('Gagal berbagi: ' + e.message, 'error');
    } finally { BGUI.hideLoading(); }
  }

  // ---- Fountain QR animasi (transfer data offline via QR sequence) ----

  async function startFountainSend() {
    if (!state.bills || !state.bills.length) { BGUI.showToast('Tidak ada data untuk dikirim.', 'error'); return; }
    navigateTo('screen-fountain');
    var canvas = document.getElementById('fountain-canvas');
    var statusEl = document.getElementById('fountain-status');
    if (!canvas) return;
    var meta = { sender: state.myPublicKey, name: state.myName, circle: state.circleGenesisId };
    BGFountain.startSend(state.bills, meta, canvas, function(s){
      if (statusEl) statusEl.textContent = s;
    });
  }

  function stopFountainSend() {
    BGFountain.stopSend();
    navigateTo('screen-sync');
  }

  function startFountainReceive() {
    // Uses existing scan screen + feeds into fountain buffer
    BGFountain.startReceive(
      function(received, total){
        BGUI.showToast('Menerima: ' + received + '/' + total + ' bagian...', 'info', 800);
      },
      async function(data){
        BGUI.showToast('Data diterima! Menggabungkan...', 'success');
        await processSyncData({ bills: data }, 'fountain');
        BGQR.stopScan();
        navigateTo('screen-home');
      }
    );
    // Start scan but don't navigate away; hook feedChunk
    navigateTo('screen-scan');
    var video = document.getElementById('scan-video');
    BGQR.startScan(video, function(result) {
      var handled = BGFountain.feedChunk(result);
      if (!handled) {
        // Normal QR, stop fountain and handle normally
        BGFountain.resetReceive();
        BGQR.stopScan();
        _handleScannedPayload(result);
      }
    }, function(err){ BGUI.showToast('Kamera error: ' + err, 'error'); });
  }

  // ---- Tutup Buku Tahunan ----

  async function tutupBuku() {
    var activeBills = (state.bills || []).filter(function(b){ return b.status === 'ACTIVE' || b.status === 'PENDING_ACCEPTANCE'; });
    var totalActive = activeBills.length;
    var now = new Date();
    var period = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

    // Build summary per person
    var summary = {};
    activeBills.forEach(function(b){
      var counterparty = b.from_pub_key === state.myPublicKey ? b.to_pub_key : b.from_pub_key;
      var name = BGUI.peerName(counterparty, state.peers);
      if (!summary[name]) summary[name] = { hutang: 0, piutang: 0 };
      if (b.from_pub_key === state.myPublicKey) summary[name].hutang += b.remaining_amount;
      else summary[name].piutang += b.remaining_amount;
    });

    var summaryHtml = '<div style="margin:12px 0;font-size:0.9rem;">';
    summaryHtml += '<p><strong>' + totalActive + ' nota aktif</strong> akan diarsipkan.</p>';
    Object.keys(summary).forEach(function(name){
      var s = summary[name];
      if (s.hutang) summaryHtml += '<div style="margin:4px 0;">Hutang ke <strong>' + BGUI.escapeHtml(name) + '</strong>: ' + s.hutang.toLocaleString('id-ID') + '</div>';
      if (s.piutang) summaryHtml += '<div style="margin:4px 0;">Piutang dari <strong>' + BGUI.escapeHtml(name) + '</strong>: ' + s.piutang.toLocaleString('id-ID') + '</div>';
    });
    summaryHtml += '</div>';
    summaryHtml += '<p style="color:var(--red);font-size:0.85rem;margin-top:8px;">Semua nota aktif akan ditandai CLOSED. Tindakan ini tidak bisa dibatalkan.</p>';

    var ok = await BGUI.showModal('Tutup Buku Periode ' + period + '?', summaryHtml);
    if (!ok) return;

    // Second confirm
    var ok2 = await BGUI.showModal('Konfirmasi Tutup Buku', '<p>Yakin? Semua nota aktif akan diarsipkan ke periode <strong>' + period + '</strong>.</p><p style="margin-top:8px;">Backup data diekspor otomatis sebelum ditutup.</p>');
    if (!ok2) return;

    BGUI.showLoading('Menutup buku...');
    isProcessing = true;
    try {
      // 1. Auto-export backup before closing (exportFile builds its own blob internally)
      var closedStatus = 'CLOSED_' + period;
      var meta = { sender: state.myPublicKey, name: state.myName, circle: state.circleGenesisId, closed_period: period };
      var filename = 'nota-kita-tutup-buku-' + period + '.json';
      BGShare.exportFile(state.bills, filename, meta);

      // 2. Archive active bills
      var archived = 0;
      for (var i = 0; i < activeBills.length; i++) {
        var b = activeBills[i];
        var updated = Object.assign({}, b, { status: closedStatus, closed_at: Date.now(), closed_period: period });
        await BGDB.saveBill(updated);
        archived++;
      }

      await loadData();
      BGUI.hideLoading();
      BGUI.showToast('Buku ditutup. ' + archived + ' nota diarsipkan ke periode ' + period + '.', 'success', 5000);
    } catch(e) {
      BGUI.hideLoading();
      BGUI.showToast('Gagal tutup buku: ' + e.message, 'error');
    } finally {
      isProcessing = false;
    }
  }

  // hook into _showQR to track current payload
  var _showQRBase = _showQR;
  _showQR = async function(payload, label) {
    _currentQRPayload = payload;
    return _showQRBase(payload, label);
  };

  return {
    init: init,
    getState: getState,
    getSyncState: getSyncState,
    // nav
    navigateTo: navigateTo,
    bnavGo: bnavGo,
    // setup
    finishSetup: finishSetup,
    setupNextStep: setupNextStep,
    setupPrevStep: setupPrevStep,
    // wizard
    wizardNext: wizardNext,
    wizardPrev: wizardPrev,
    // auth
    loginPIN: loginPIN,
    loginPasskey: loginPasskey,
    pinKeyPress: pinKeyPress,
    pinBackspace: pinBackspace,
    registerPasskey: registerPasskey,
    removePasskey: removePasskey,
    setupPIN: setupPIN,
    disablePIN: disablePIN,
    // share
    shareBill: shareBill,
    shareAllBills: shareAllBills,
    // fountain
    startFountainSend: startFountainSend,
    startFountainReceive: startFountainReceive,
    stopFountainSend: stopFountainSend,
    // tutup buku
    tutupBuku: tutupBuku,
    // onboarding
    nextOnboarding: nextOnboarding,
    skipOnboarding: skipOnboarding,
    showOnboarding: showOnboardingOverride,
    // form controls
    setAssetType: setAssetType,
    setInterestMode: setInterestMode,
    buatNota: buatNota,
    // filter
    filterBukuSaku: filterBukuSaku,
    // bill actions
    openBillDetail: openBillDetail,
    viewBillsWith: viewBillsWith,
    initSettle: initSettle,
    initEndorse: initEndorse,
    confirmSettlementFromDetail: confirmSettlementFromDetail,
    acceptBillFromDetail: acceptBillFromDetail,
    // QR
    startScan: startScan,
    stopScan: stopScan,
    toggleFlash: toggleFlash,
    shareCurrentQR: shareCurrentQR,
    // sync
    processSyncData: processSyncData,
    setOnlineStatus: setOnlineStatus,
    showToast: showToast,
    toggleRTC: toggleRTC,
    // netting
    runManualNetting: runManualNetting,
    // wifi sync
    startWiFiSync: function(){ if(typeof BGLocalRTC !== 'undefined') BGLocalRTC.startWiFiSync(); else if(typeof BGRTC !== 'undefined') BGRTC.startWiFiSync(); },
    // modal passthrough
    confirmModal: function(){ BGUI.confirmModal(); },
    dismissModal: function(){ BGUI.dismissModal(); },
    // tutorial
    nextTutorial: function(){ BGTutorial.next(); },
    dismissTutorial: function(){ BGTutorial.dismiss(); },
    // PWA
    installPWA: installPWA,
    dismissPWABanner: dismissPWABanner,
    // backup
    exportKeyWithPassword: exportKeyWithPassword,
    showImportKeyModal: showImportKeyModal,
    // oracle
    showOraclePriceModal: showOraclePriceModal,
    // file io
    exportBillsFile: exportBillsFile,
    importBillsFile: importBillsFile,
    importFromFile: importBillsFile,
    // settings
    editName: editName,
    setupPIN: setupPIN,
    confirmResetAll: confirmResetAll,
    // circle
    showCircleInviteQR: showCircleInviteQR,
    copyCircleId: copyCircleId,
    startScanForCircle: startScanForCircle
  };

})();

window.addEventListener('DOMContentLoaded', function(){ BG.init(); });
