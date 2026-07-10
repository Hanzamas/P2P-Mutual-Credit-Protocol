// ============================================================
// MEFOBILLS - WEBRTC P2P SYNC
// 1. BGRTC: Auto Sync via Internet (Trystero Nostr)
// 2. BGLocalRTC: Local WiFi Sync (Manual SDP via QR)
// Changes from BukuGembok:
//   - Room ID = sha256('mefobills:circle:' + genesis_id)
//   - Member whitelist: reject unknown pub_keys
//   - Full-transparency mode: broadcast all circle bills to all members
// ============================================================

window.BGRTC = (function () {
  var room = null;
  var sendBillsAction = null;
  var isSyncing = false;

  async function startAutoSync(genesisId) {
    if (isSyncing) return;

    if (typeof trystero === 'undefined') {
      if (window.BG) BG.showToast('Komponen koneksi belum siap. Butuh internet.', 'error');
      return;
    }

    var roomId = await BGCircle.getRoomId(genesisId);
    isSyncing = true;

    try {
      var config = { appId: 'mefobills-v1' };
      room = trystero.joinRoom(config, roomId);

      var actions = room.makeAction('sync_bills');
      sendBillsAction = actions[0];
      var receiveAction = actions[1];

      room.onPeerJoin(function (peerId) {
        console.log('Trystero peer joined:', peerId);
        if (window.BG) BG.showToast('Peer terhubung!', 'success', 2000);
        broadcast(genesisId);
      });

      room.onPeerLeave(function (peerId) {
        console.log('Trystero peer left:', peerId);
      });

      receiveAction(async function (data, peerId) {
        if (data.length > 5242880) {
          console.warn('Trystero: payload terlalu besar dari', peerId);
          return;
        }
        try {
          var parsed = JSON.parse(data);

          // member whitelist check: if sender_pub_key is known
          if (parsed._sender_pub_key) {
            var known = await BGCircle.isMember(parsed._sender_pub_key);
            if (!known) {
              console.warn('Trystero: unknown sender pub_key, ignoring');
              return;
            }
          }

          if (window.BG && typeof window.BG.processSyncData === 'function') {
            await BG.processSyncData(parsed, 'webrtc');
          }
        } catch (e) {
          console.error('Trystero parse/merge error:', e);
        }
      });

      setTimeout(function () { broadcast(genesisId); }, 1500);

      if (window.BG && typeof window.BG.setOnlineStatus === 'function') BG.setOnlineStatus(true);

    } catch (err) {
      console.error('Trystero init error:', err);
      isSyncing = false;
      if (window.BG) BG.showToast('Gagal memulai koneksi P2P.', 'error');
    }
  }

  function stopAutoSync() {
    if (room) { room.leave(); room = null; }
    isSyncing = false;
    sendBillsAction = null;
    if (window.BG && typeof window.BG.setOnlineStatus === 'function') BG.setOnlineStatus(false);
    if (window.BG) BG.showToast('Koneksi P2P diputus.', 'info');
  }

  async function broadcast(genesisId) {
    if (!sendBillsAction || !room) return;
    if (!window.BG) return;

    var syncState = window.BG.getSyncState();
    var bills = syncState.bills || [];
    var meta = syncState.meta || {};

    // Full transparency: send all bills in circle.
    // Member whitelist enforced on receive side.
    var compressed = BGMerge.compressArray(bills, meta);

    var payload = JSON.stringify({
      _sender_pub_key: meta.pub_key || '',
      bills: compressed,
      oracle_prices: await BGOracle.getAllForBroadcast()
    });

    sendBillsAction(payload);
  }

  return {
    startAutoSync: startAutoSync,
    stopAutoSync: stopAutoSync,
    broadcast: broadcast
  };
})();


// ---- BGLocalRTC: Local WiFi Sync (SDP QR, no internet) ----

window.BGLocalRTC = (function () {
  var peer = null;
  var channel = null;

  function showMainModal() {
    removeModal();
    var html = '<div id="modal-local-rtc" style="position:fixed;inset:0;z-index:600;background:rgba(0,0,0,0.45);display:flex;align-items:flex-end;justify-content:center;padding-bottom:env(safe-area-inset-bottom);">' +
      '<div style="background:var(--surface);border-radius:18px 18px 0 0;padding:24px 20px 28px;width:100%;max-width:480px;box-shadow:0 -8px 40px rgba(0,0,0,0.12);">' +
      '<div style="width:36px;height:4px;background:var(--border-md);border-radius:2px;margin:0 auto 16px;"></div>' +
      '<h2 style="margin:0 0 8px;font-size:1.1rem;font-weight:700;text-align:center;">Sambung WiFi Lokal</h2>' +
      '<p style="font-size:0.85rem;color:var(--text-dim);margin-bottom:20px;text-align:center;">Satu jadi Pembuat, satu jadi Pen-scan.</p>' +
      '<button class="btn btn-primary btn-lg" onclick="BGLocalRTC.createOffer()" style="margin-bottom:10px;">1. Buat Koneksi (Tampil QR)</button>' +
      '<button class="btn btn-outline btn-lg" onclick="BGLocalRTC.scanOffer()" style="margin-bottom:20px;">2. Scan Koneksi (Kamera)</button>' +
      '<button class="btn btn-outline btn-lg" style="color:var(--red);border-color:var(--red);" onclick="BGLocalRTC.closeModal()">Batal</button>' +
      '</div></div>';
    document.body.insertAdjacentHTML('beforeend', html);
  }

  function removeModal() {
    var el = document.getElementById('modal-local-rtc');
    if (el) el.remove();
  }

  function initPeer() {
    if (peer) peer.close();
    peer = new RTCPeerConnection({ iceServers: [] });
    peer.oniceconnectionstatechange = function () {
      if (peer.iceConnectionState === 'connected') {
        if (window.BG) BG.showToast('Koneksi WiFi Lokal berhasil!', 'success', 4000);
        removeModal();
      }
    };
    peer.ondatachannel = function (ev) {
      channel = ev.channel;
      setupChannel();
    };
  }

  function setupChannel() {
    var chunks = [];
    var receiving = false;

    channel.onopen = function () { broadcast(); };
    channel.onmessage = async function (e) {
      if (typeof e.data === 'string') {
        if (e.data === '__START__') { chunks = []; receiving = true; return; }
        if (e.data === '__END__') {
          receiving = false;
          try {
            var blob = new Blob(chunks);
            if (blob.size > 5242880) { chunks = []; return; }
            var text = await blob.text();
            var parsed = JSON.parse(text);
            chunks = [];
            if (window.BG && typeof window.BG.processSyncData === 'function') {
              await BG.processSyncData(parsed, 'webrtc-local');
            }
          } catch (err) { console.error('LocalRTC parse error:', err); chunks = []; }
          return;
        }
      } else if (receiving) {
        chunks.push(e.data);
      }
    };
  }

  async function createOffer() {
    removeModal();
    document.body.insertAdjacentHTML('beforeend',
      '<div id="modal-local-rtc" style="position:fixed;inset:0;z-index:600;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;"><div style="background:var(--surface);border-radius:var(--radius-lg);padding:24px;text-align:center;min-width:200px;"><div class="spinner"></div><p style="margin-top:12px;color:var(--text-dim);font-size:0.88rem;">Membuat koneksi...</p></div></div>');

    initPeer();
    channel = peer.createDataChannel('sync_bills');
    setupChannel();

    peer.onicecandidate = function (ev) {
      if (!ev.candidate) showQR(JSON.stringify(peer.localDescription), 'Minta teman scan QR ini.', true);
    };

    var offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
  }

  async function scanOffer() {
    removeModal();
    scanWithCamera('Scan QR Pembuat Koneksi', async function (result) {
      try {
        var offer = JSON.parse(result);
        if (offer.type !== 'offer') throw new Error('Bukan QR Offer');
        removeModal();
        document.body.insertAdjacentHTML('beforeend',
          '<div id="modal-local-rtc" class="modal" style="display:flex;"><div class="modal-content" style="text-align:center;"><h3>Memproses...</h3></div></div>');
        initPeer();
        await peer.setRemoteDescription(offer);
        peer.onicecandidate = function (ev) {
          if (!ev.candidate) showQR(JSON.stringify(peer.localDescription), 'Minta pembuat scan QR ini.', false);
        };
        var answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
      } catch (e) {
        console.error(e);
        alert('QR tidak valid untuk koneksi lokal.');
      }
    });
  }

  function scanAnswer() {
    removeModal();
    scanWithCamera('Scan Balasan', async function (result) {
      try {
        var answer = JSON.parse(result);
        if (answer.type !== 'answer') throw new Error('Bukan QR Answer');
        removeModal();
        await peer.setRemoteDescription(answer);
      } catch (e) {
        alert('QR balasan tidak valid.');
      }
    });
  }

  function scanWithCamera(title, onResult) {
    var html = '<div id="modal-local-rtc" class="modal" style="display:flex;">' +
      '<div class="modal-content" style="text-align:center;padding:16px;">' +
      '<h3>' + title + '</h3>' +
      '<div style="background:#000;border-radius:8px;overflow:hidden;margin:16px 0;aspect-ratio:1/1;position:relative;">' +
      '<video id="localrtc-video" style="width:100%;height:100%;object-fit:cover;" playsinline autoplay></video></div>' +
      '<button class="btn btn-red" onclick="BGLocalRTC.stopScan()" style="width:100%;">Batal</button>' +
      '</div></div>';
    document.body.insertAdjacentHTML('beforeend', html);
    var video = document.getElementById('localrtc-video');
    if (window.BGQR) {
      window.addEventListener('popstate', stopScan);
      BGQR.startScan(video, function (res) { stopScan(); onResult(res); }, function (err) { stopScan(); alert('Kamera error: ' + err); });
    } else {
      alert('Scanner belum siap.');
      stopScan();
    }
  }

  function stopScan() {
    window.removeEventListener('popstate', stopScan);
    if (window.BGQR) BGQR.stopScan();
    removeModal();
  }

  function showQR(text, instruction, isOffer) {
    removeModal();
    var html = '<div id="modal-local-rtc" style="position:fixed;inset:0;z-index:600;background:rgba(0,0,0,0.45);display:flex;align-items:flex-end;justify-content:center;padding-bottom:env(safe-area-inset-bottom);">' +
      '<div style="background:var(--surface);border-radius:18px 18px 0 0;padding:24px 20px 28px;width:100%;max-width:480px;box-shadow:0 -8px 40px rgba(0,0,0,0.12);text-align:center;">' +
      '<div style="width:36px;height:4px;background:var(--border-md);border-radius:2px;margin:0 auto 16px;"></div>' +
      '<h3 style="margin:0 0 8px;font-size:1.05rem;font-weight:700;">Scan QR Ini</h3>' +
      '<p style="font-size:0.85rem;color:var(--text-dim);margin-bottom:10px;">' + instruction + '</p>' +
      '<div style="background:#fff;padding:10px;display:inline-block;border-radius:var(--radius-md);margin:10px 0;">' +
      '<canvas id="localrtc-qr-canvas"></canvas></div>' +
      (isOffer ? '<button class="btn btn-outline btn-lg" style="margin-top:12px;" onclick="BGLocalRTC.scanAnswer()">Lanjut: Scan Balasan</button>' : '') +
      '<button class="btn btn-outline btn-lg" style="margin-top:8px;color:var(--red);border-color:var(--red);" onclick="BGLocalRTC.closeModal()">Tutup</button>' +
      '</div></div>';
    document.body.insertAdjacentHTML('beforeend', html);
    var canvas = document.getElementById('localrtc-qr-canvas');
    if (window.BGQR) BGQR.generateToCanvas(text, canvas, 250);
  }

  async function broadcast() {
    if (!channel || channel.readyState !== 'open') return;
    if (!window.BG) return;

    var syncState = window.BG.getSyncState();
    var bills = syncState.bills || [];
    var meta = syncState.meta || {};

    var compressed = BGMerge.compressArray(bills, meta);
    var payload = JSON.stringify({
      _sender_pub_key: meta.pub_key || '',
      bills: compressed,
      oracle_prices: await BGOracle.getAllForBroadcast()
    });

    var encoder = new TextEncoder();
    var uint8 = encoder.encode(payload);
    var CHUNK = 16000;

    channel.send('__START__');
    for (var i = 0; i < uint8.length; i += CHUNK) {
      channel.send(uint8.slice(i, i + CHUNK));
    }
    channel.send('__END__');
  }

  return {
    startWiFiSync: showMainModal,
    createOffer: createOffer,
    scanOffer: scanOffer,
    scanAnswer: scanAnswer,
    closeModal: removeModal,
    stopScan: stopScan,
    broadcast: broadcast
  };
})();
