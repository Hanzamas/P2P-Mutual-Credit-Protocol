// ============================================================
// MEFOBILLS - HOME SCREEN RENDERER
// Dashboard: net positions per counterparty + quick actions
// ============================================================

var RenderHome = (function () {

  function render(state) {
    _renderHeader(state);
    _renderPositions(state);
    _renderNettingBadge(state);
    _renderRecentActivity(state);
  }

  function _renderHeader(state) {
    var nameEl = document.getElementById('home-circle-name');
    var userEl = document.getElementById('home-user-name');

    if (nameEl) nameEl.textContent = state.circleName || 'MefoBills';
    if (userEl) userEl.textContent = state.myName || '';
  }

  function _renderPositions(state) {
    var container = document.getElementById('home-positions');
    var emptyEl = document.getElementById('home-empty');
    if (!container) return;

    var positions = BGNetting.netPositions(state.bills, state.myPublicKey);

    if (positions.length === 0) {
      container.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'flex';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    // Group by counterparty
    var byParty = {};
    for (var i = 0; i < positions.length; i++) {
      var p = positions[i];
      var key = p.counterparty_pub_key;
      if (!byParty[key]) byParty[key] = [];
      byParty[key].push(p);
    }

    var frag = document.createDocumentFragment();
    var parties = Object.keys(byParty);

    for (var j = 0; j < parties.length; j++) {
      var pub_key = parties[j];
      var peer = state.peers.find(function(p){ return p.pub_key === pub_key; }) || {};
      var partyPositions = byParty[pub_key];

      var card = document.createElement('div');
      card.className = 'position-card';
      card.setAttribute('data-pubkey', pub_key);

      var header = document.createElement('div');
      header.className = 'position-card-header';

      var avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = (peer.nama || '?')[0].toUpperCase();

      var nameDiv = document.createElement('div');
      nameDiv.className = 'position-name';
      nameDiv.textContent = peer.nama || BGUI.peerName(pub_key, state.peers);

      var repDiv = document.createElement('span');
      repDiv.innerHTML = BGUI.repBadge(peer.reputation_score);

      nameDiv.appendChild(repDiv);
      header.appendChild(avatar);
      header.appendChild(nameDiv);
      card.appendChild(header);

      // each asset position
      for (var k = 0; k < partyPositions.length; k++) {
        var pos = partyPositions[k];
        var isOwe = pos.direction === 'OWE';
        var parts = pos.asset_key.split(':');
        var assetLabel = BGUI.formatAmount(pos.net_amount, parts[0], parts[1], parts[2] || null);

        var row = document.createElement('div');
        row.className = 'position-row ' + (isOwe ? 'hutang' : 'piutang');

        var dirLabel = document.createElement('span');
        dirLabel.className = 'position-dir';
        dirLabel.textContent = isOwe ? 'Kamu hutang' : 'Dia hutang';

        var amountSpan = document.createElement('span');
        amountSpan.className = 'position-amount';
        amountSpan.textContent = assetLabel;

        row.appendChild(dirLabel);
        row.appendChild(amountSpan);
        card.appendChild(row);
      }

      // action row
      var actions = document.createElement('div');
      actions.className = 'position-actions';
      var viewBtn = document.createElement('button');
      viewBtn.className = 'btn-sm btn-outline';
      viewBtn.textContent = 'Lihat Nota';
      viewBtn.onclick = function(pk){ return function(){ window.BG.viewBillsWith(pk); }; }(pub_key);
      actions.appendChild(viewBtn);
      card.appendChild(actions);

      frag.appendChild(card);
    }

    container.innerHTML = '';
    container.appendChild(frag);
  }

  function _renderNettingBadge(state) {
    var badge = document.getElementById('home-netting-badge');
    if (!badge) return;
    var logs = state.recentNettingLogs || [];
    badge.style.display = logs.length ? 'flex' : 'none';
    if (logs.length) {
      var last = logs[logs.length - 1];
      badge.textContent = '\u26A1 Hapus Silang: ' + BGUI.formatAmount(last.cleared_amount, last.asset_key.split(':')[0], last.asset_key.split(':')[1]) + ' terhapus otomatis!';
    }
  }

  function _renderRecentActivity(state) {
    var el = document.getElementById('home-recent');
    if (!el) return;
    var recent = (state.bills || [])
      .filter(function(b){ return b.from_pub_key === state.myPublicKey || b.to_pub_key === state.myPublicKey; })
      .sort(function(a,b){ return b.waktu - a.waktu; })
      .slice(0, 5);

    if (!recent.length) { el.innerHTML = '<p class="text-dim text-center text-sm">Belum ada aktivitas.</p>'; return; }

    var frag = document.createDocumentFragment();
    for (var i = 0; i < recent.length; i++) {
      var b = recent[i];
      var isDebtor = b.from_pub_key === state.myPublicKey;
      var counterparty = isDebtor ? b.to_pub_key : b.from_pub_key;
      var name = BGUI.peerName(counterparty, state.peers);

      var item = document.createElement('div');
      item.className = 'activity-item';

      var icon = document.createElement('div');
      icon.className = 'activity-icon ' + (isDebtor ? 'hutang' : 'piutang');
      icon.textContent = isDebtor ? '\u2191' : '\u2193';

      var info = document.createElement('div');
      info.className = 'activity-info';
      var desc = document.createElement('div');
      desc.className = 'activity-desc';
      desc.textContent = (isDebtor ? 'Hutang ke ' : 'Piutang dari ') + name;
      var time = document.createElement('div');
      time.className = 'activity-time';
      time.textContent = BGUI.timeAgo(b.waktu);
      info.appendChild(desc);
      info.appendChild(time);

      var amt = document.createElement('div');
      amt.className = 'activity-amount ' + (isDebtor ? 'hutang' : 'piutang');
      amt.textContent = BGUI.formatAmount(b.remaining_amount, b.asset_type, b.asset_unit, b.asset_name);

      item.appendChild(icon);
      item.appendChild(info);
      item.appendChild(amt);
      frag.appendChild(item);
    }
    el.innerHTML = '';
    el.appendChild(frag);
  }

  return { render: render };

})();
