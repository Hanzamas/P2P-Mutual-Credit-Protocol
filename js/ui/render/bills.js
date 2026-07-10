// ============================================================
// MEFOBILLS - BILL DETAIL RENDERER
// Full bill view: status, interest, endorsement chain, actions
// ============================================================

var RenderBills = (function () {

  async function renderDetail(bill_id, state) {
    var bill = await BGDB.getBillById(bill_id);
    if (!bill) { BGUI.showToast('Nota tidak ditemukan.', 'error'); return; }

    var container = document.getElementById('bill-detail-content');
    if (!container) return;

    var fromName = BGUI.peerName(bill.from_pub_key, state.peers);
    var toName = BGUI.peerName(bill.to_pub_key, state.peers);
    var amountStr = BGUI.formatAmount(bill.amount, bill.asset_type, bill.asset_unit, bill.asset_name);
    var remainingStr = BGUI.formatAmount(bill.remaining_amount, bill.asset_type, bill.asset_unit, bill.asset_name);
    var totalOwed = BGInterest.calcTotal(bill);
    var totalStr = BGUI.formatAmount(totalOwed, bill.asset_type, bill.asset_unit, bill.asset_name);
    var isDebtor = bill.from_pub_key === state.myPublicKey;
    var isCreditor = bill.to_pub_key === state.myPublicKey;

    // oracle commodity equivalent
    var equivLabel = await BGOracle.getEquivalentLabel(bill);

    // endorsement chain
    var chain = await BGEndorse.getEndorsementChain(bill_id);

    var html = '';

    // ---- Status header ----
    html += '<div class="detail-status-header ' + (isDebtor ? 'hutang' : 'piutang') + '">';
    html += '<div class="detail-main-amount">' + BGUI.escapeHtml(totalStr) + '</div>';
    html += '<div class="detail-role">';
    if (isDebtor) html += 'Kamu berutang kepada <strong>' + BGUI.escapeHtml(toName) + '</strong>';
    else if (isCreditor) html += '<strong>' + BGUI.escapeHtml(fromName) + '</strong> berutang kepadamu';
    else html += BGUI.escapeHtml(fromName) + ' \u2192 ' + BGUI.escapeHtml(toName);
    html += '</div>';
    html += BGUI.statusBadge(bill.status);
    html += '</div>';

    // ---- Details grid ----
    html += '<div class="detail-grid">';
    html += _detailRow('Jenis', BGUI.typeName(bill.type));
    html += _detailRow('Nominal Awal', amountStr);
    if (bill.remaining_amount !== bill.amount) html += _detailRow('Sisa Tagihan', remainingStr);
    html += _detailRow('Bunga', BGInterest.formatRate(bill));
    if (bill.interest_rate) html += _detailRow('Total + Bunga', totalStr);
    html += _detailRow('Tanggal Dibuat', BGUI.formatDateTime(bill.waktu));
    if (bill.due_date) {
      var dueStr = BGUI.formatDate(bill.due_date) + (bill.grace_days ? ' (grace ' + bill.grace_days + ' hari)' : '');
      var dueClass = BGInterest.isDefault(bill) ? 'color-red' : (BGInterest.isOverdue(bill) ? 'color-yellow' : '');
      html += _detailRow('Jatuh Tempo', '<span class="' + dueClass + '">' + BGUI.escapeHtml(dueStr) + '</span>');
    }
    if (bill.keterangan) html += _detailRow('Keterangan', BGUI.escapeHtml(bill.keterangan));
    if (equivLabel) html += _detailRow('Setara', BGUI.escapeHtml(equivLabel));
    if (bill.guarantor_pub_key) html += _detailRow('Penjamin', BGUI.escapeHtml(BGUI.peerName(bill.guarantor_pub_key, state.peers)));
    html += _detailRow('ID Nota', '<span class="bill-id-short">' + bill.id.substring(0, 16) + '&hellip;</span>');
    html += '</div>';

    // ---- Endorsement chain ----
    if (chain.length > 1) {
      html += '<div class="detail-section">';
      html += '<h3 class="detail-section-title">Riwayat Oper</h3>';
      html += '<div class="chain-list">';
      for (var i = 0; i < chain.length; i++) {
        var c = chain[i];
        var cf = BGUI.peerName(c.from_pub_key, state.peers);
        var ct = BGUI.peerName(c.to_pub_key, state.peers);
        html += '<div class="chain-item">';
        html += '<span class="chain-step">' + (i+1) + '</span>';
        html += '<span>' + BGUI.escapeHtml(cf) + ' \u2192 ' + BGUI.escapeHtml(ct) + '</span>';
        html += '<span class="chain-amount">' + BGUI.formatAmount(c.amount, c.asset_type, c.asset_unit, c.asset_name) + '</span>';
        html += BGUI.statusBadge(c.status);
        html += '</div>';
      }
      html += '</div></div>';
    }

    // ---- Action buttons ----
    html += '<div class="detail-actions">';

    if (bill.status === 'ACTIVE') {
      if (isDebtor) {
        // debtor can settle
        html += '<button class="btn btn-green btn-lg" id="btn-detail-lunasi" onclick="window.BG.initSettle(\'' + bill.id + '\')">&#x2714; Lunasi Sekarang</button>';
      }
      if (isCreditor) {
        // creditor can split/endorse
        html += '<button class="btn btn-blue btn-lg" id="btn-detail-oper" onclick="window.BG.initEndorse(\'' + bill.id + '\')">&#x21A6; Oper Nota</button>';
      }
    }

    if (bill.status === 'PENDING_ACCEPTANCE' && bill.to_pub_key === state.myPublicKey) {
      html += '<button class="btn btn-green btn-lg" id="btn-detail-terima" onclick="window.BG.acceptBillFromDetail(\'' + bill.id + '\')">&#x2714; Terima & Konfirmasi</button>';
    }

    if (bill.status === 'PENDING_CONFIRMATION' && bill.to_pub_key === state.myPublicKey) {
      html += '<button class="btn btn-green btn-lg" id="btn-detail-konfirmasi" onclick="window.BG.confirmSettlementFromDetail(\'' + bill.id + '\')">&#x2714; Konfirmasi Lunas</button>';
    }

    html += '<button class="btn btn-outline" onclick="window.BG.shareBill(\'' + bill.id + '\')">&#x1F4E4; Bagikan</button>';
    html += '</div>';

    container.innerHTML = html;

    // TTS: read bill to user (accessibility)
    var ttsText = (isDebtor ? 'Kamu hutang ' : 'Piutang ') + totalStr +
      (isDebtor ? ' kepada ' : ' dari ') + (isDebtor ? toName : fromName) +
      '. Status: ' + bill.status + '.';
    var ttsBtnEl = document.getElementById('btn-detail-tts');
    if (ttsBtnEl) ttsBtnEl.onclick = function(){ BGUI.speak(ttsText); };
  }

  function _detailRow(label, value) {
    return '<div class="detail-row"><span class="detail-label">' + label + '</span><span class="detail-value">' + value + '</span></div>';
  }

  return { renderDetail: renderDetail };

})();
