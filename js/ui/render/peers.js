// ============================================================
// MEFOBILLS - PEERS RENDERER
// ============================================================

var RenderPeers = (function () {

  async function render(state) {
    var peers = await BGDB.getAllPeers();
    var listEl = document.getElementById('peers-list');
    var emptyEl = document.getElementById('peers-empty');
    var countEl = document.getElementById('peers-count');
    if (!listEl) return;

    if (countEl) countEl.textContent = peers.length + ' anggota';
    listEl.innerHTML = '';

    if (!peers.length) {
      if (emptyEl) emptyEl.style.display = 'flex';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    var frag = document.createDocumentFragment();
    var bills = state.bills || [];

    for (var i = 0; i < peers.length; i++) {
      var p = peers[i];
      var score = p.reputation_score !== undefined ? p.reputation_score : 100;
      var positions = BGNetting.netPositions(bills, p.pub_key);

      var item = document.createElement('div');
      item.className = 'peer-item';
      item.onclick = function(pk){ return function(){ window.BG.viewBillsWith(pk); }; }(p.pub_key);

      var avatar = document.createElement('div');
      avatar.className = 'avatar avatar-lg';
      avatar.textContent = (p.nama || '?')[0].toUpperCase();

      var info = document.createElement('div');
      info.className = 'peer-info';

      var nameRow = document.createElement('div');
      nameRow.className = 'peer-name';
      nameRow.innerHTML = BGUI.escapeHtml(p.nama || 'Tanpa nama') + ' ' + BGUI.repBadge(score);

      var metaRow = document.createElement('div');
      metaRow.className = 'peer-meta text-dim text-sm';
      var shortKey = p.pub_key ? p.pub_key.substring(0, 12) + '\u2026' : '';
      metaRow.textContent = (p.last_sync ? 'Terakhir: ' + BGUI.timeAgo(p.last_sync) : '') + ' \u00B7 ' + shortKey;

      // net balance summary
      var balRow = document.createElement('div');
      balRow.className = 'peer-balance text-sm';
      if (positions.length) {
        var pos = positions[0]; // show first position
        var dir = pos.direction === 'OWE' ? 'Mereka piutang' : 'Kamu piutang';
        var amtStr = BGUI.formatAmount(pos.net_amount, pos.asset_key.split(':')[0], pos.asset_key.split(':')[1], pos.asset_key.split(':')[2] || null);
        balRow.innerHTML = '<span class="' + (pos.direction === 'OWE' ? 'color-green' : 'color-red') + '">' + dir + ': ' + BGUI.escapeHtml(amtStr) + '</span>';
      } else {
        balRow.innerHTML = '<span class="color-green">Semua lunas &#x2714;</span>';
      }

      info.appendChild(nameRow);
      info.appendChild(metaRow);
      info.appendChild(balRow);
      item.appendChild(avatar);
      item.appendChild(info);
      frag.appendChild(item);
    }

    listEl.appendChild(frag);
  }

  return { render: render };

})();
