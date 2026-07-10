// ============================================================
// MEFOBILLS - LEDGER RENDERERS
// Buku Saku (my bills) + Buku Besar (all circle bills)
// ============================================================

var RenderLedger = (function () {

  var PAGE_SIZE = 50;
  var bukuSakuPage = 0;
  var bukuBesarPage = 0;
  var bukuSakuFilter = '';
  var bukuBesarFilter = '';
  var searchDebounce = null;

  // ---- BUKU SAKU (personal view) ----

  function renderBukuSaku(state, mode) {
    bukuSakuPage = 0;
    var filterEl = document.getElementById('buku-saku-filter');
    if (filterEl) bukuSakuFilter = (filterEl.value || '').toLowerCase().trim();

    var myBills = (state.bills || []).filter(function(b){
      return b.from_pub_key === state.myPublicKey || b.to_pub_key === state.myPublicKey;
    });

    // Status chip filter
    if (mode === 'active') {
      myBills = myBills.filter(function(b){ return b.status === 'ACTIVE' || b.status === 'PENDING_ACCEPTANCE' || b.status === 'PENDING_CONFIRMATION'; });
    } else if (mode === 'hutang') {
      myBills = myBills.filter(function(b){ return b.from_pub_key === state.myPublicKey && b.status !== 'SETTLED'; });
    } else if (mode === 'piutang') {
      myBills = myBills.filter(function(b){ return b.to_pub_key === state.myPublicKey && b.status !== 'SETTLED'; });
    } else if (mode === 'settled') {
      myBills = myBills.filter(function(b){ return b.status === 'SETTLED'; });
    }

    if (bukuSakuFilter) {
      myBills = myBills.filter(function(b){
        var name = BGUI.peerName(b.from_pub_key === state.myPublicKey ? b.to_pub_key : b.from_pub_key, state.peers);
        return (b.keterangan || '').toLowerCase().includes(bukuSakuFilter) ||
               name.toLowerCase().includes(bukuSakuFilter);
      });
    }

    myBills.sort(function(a,b){ return b.waktu - a.waktu; });

    _renderBillList('buku-saku-list', 'buku-saku-empty', 'buku-saku-load-more', myBills, state, bukuSakuPage);
  }

  function filterBukuSaku(query, state) {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function(){ renderBukuSaku(state); }, 300);
  }

  function loadMoreBukuSaku(state) {
    bukuSakuPage++;
    var myBills = (state.bills || []).filter(function(b){
      return b.from_pub_key === state.myPublicKey || b.to_pub_key === state.myPublicKey;
    }).sort(function(a,b){ return b.waktu - a.waktu; });
    _renderBillList('buku-saku-list', 'buku-saku-empty', 'buku-saku-load-more', myBills, state, bukuSakuPage, true);
  }

  // ---- BUKU BESAR (circle-wide view) ----

  function renderBukuBesar(state) {
    bukuBesarPage = 0;
    var filterEl = document.getElementById('buku-besar-filter');
    if (filterEl) bukuBesarFilter = (filterEl.value || '').toLowerCase().trim();

    var allBills = (state.bills || []).slice();

    if (bukuBesarFilter) {
      allBills = allBills.filter(function(b){
        var fn = BGUI.peerName(b.from_pub_key, state.peers);
        var tn = BGUI.peerName(b.to_pub_key, state.peers);
        return (b.keterangan || '').toLowerCase().includes(bukuBesarFilter) ||
               fn.toLowerCase().includes(bukuBesarFilter) ||
               tn.toLowerCase().includes(bukuBesarFilter);
      });
    }

    allBills.sort(function(a,b){ return b.waktu - a.waktu; });

    _renderBillList('buku-besar-list', 'buku-besar-empty', 'buku-besar-load-more', allBills, state, bukuBesarPage);
  }

  function loadMoreBukuBesar(state) {
    bukuBesarPage++;
    var allBills = (state.bills || []).sort(function(a,b){ return b.waktu - a.waktu; });
    _renderBillList('buku-besar-list', 'buku-besar-empty', 'buku-besar-load-more', allBills, state, bukuBesarPage, true);
  }

  // ---- Shared list builder ----

  function _renderBillList(listId, emptyId, moreId, bills, state, page, append) {
    var listEl = document.getElementById(listId);
    var emptyEl = document.getElementById(emptyId);
    var moreEl = document.getElementById(moreId);
    if (!listEl) return;

    if (!append) listEl.innerHTML = '';

    if (!bills.length) {
      if (emptyEl) emptyEl.style.display = 'flex';
      if (moreEl) moreEl.style.display = 'none';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    var start = page * PAGE_SIZE;
    var end = Math.min(start + PAGE_SIZE, bills.length);
    var slice = bills.slice(start, end);

    var frag = document.createDocumentFragment();
    for (var i = 0; i < slice.length; i++) {
      frag.appendChild(_buildBillItem(slice[i], state));
    }
    listEl.appendChild(frag);

    if (moreEl) {
      if (end < bills.length) {
        moreEl.style.display = 'block';
        moreEl.textContent = 'Tampilkan ' + Math.min(PAGE_SIZE, bills.length - end) + ' lagi\u2026';
      } else {
        moreEl.style.display = 'none';
      }
    }
  }

  function _buildBillItem(bill, state) {
    var isDebtor = bill.from_pub_key === state.myPublicKey;
    var isInvolved = bill.from_pub_key === state.myPublicKey || bill.to_pub_key === state.myPublicKey;
    var fromName = BGUI.peerName(bill.from_pub_key, state.peers);
    var toName = BGUI.peerName(bill.to_pub_key, state.peers);
    var amountStr = BGUI.formatAmount(bill.remaining_amount, bill.asset_type, bill.asset_unit, bill.asset_name);

    var item = document.createElement('div');
    item.className = 'bill-item' + (isInvolved ? (isDebtor ? ' involved-debtor' : ' involved-creditor') : '');
    item.setAttribute('data-id', bill.id);
    item.onclick = function(){ window.BG.openBillDetail(bill.id); };

    // top row: type + status + date
    var topRow = document.createElement('div');
    topRow.className = 'bill-item-top';
    var typeSpan = document.createElement('span');
    typeSpan.className = 'bill-type-label';
    typeSpan.textContent = BGUI.typeName(bill.type);
    var dateSpan = document.createElement('span');
    dateSpan.className = 'bill-date';
    dateSpan.textContent = BGUI.formatDate(bill.waktu);
    topRow.innerHTML = BGUI.statusBadge(bill.status);
    topRow.insertBefore(typeSpan, topRow.firstChild);
    topRow.appendChild(dateSpan);
    item.appendChild(topRow);

    // parties row: A → B
    var partiesRow = document.createElement('div');
    partiesRow.className = 'bill-parties';
    partiesRow.innerHTML = '<span class="bill-from">' + BGUI.escapeHtml(fromName) + '</span>' +
      ' <span class="bill-arrow">\u2192</span> ' +
      '<span class="bill-to">' + BGUI.escapeHtml(toName) + '</span>';
    item.appendChild(partiesRow);

    // amount + note row
    var bottomRow = document.createElement('div');
    bottomRow.className = 'bill-item-bottom';
    var amtEl = document.createElement('div');
    amtEl.className = 'bill-amount ' + (isDebtor ? 'hutang' : 'piutang');
    amtEl.textContent = amountStr;
    var noteEl = document.createElement('div');
    noteEl.className = 'bill-note text-dim';
    noteEl.textContent = bill.keterangan || '';
    bottomRow.appendChild(amtEl);
    bottomRow.appendChild(noteEl);
    item.appendChild(bottomRow);

    // overdue indicator
    if (BGInterest.isOverdue(bill) && bill.status === 'ACTIVE') {
      var overdueEl = document.createElement('div');
      overdueEl.className = 'bill-overdue-tag';
      overdueEl.textContent = BGInterest.isDefault(bill) ? '\u26A0\uFE0F Macet!' : '\u23F0 Jatuh Tempo';
      item.appendChild(overdueEl);
    }

    return item;
  }

  function filterBukuBesar(query, state) {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function(){ renderBukuBesar(state); }, 300);
  }

  return {
    renderBukuSaku: renderBukuSaku,
    renderBukuBesar: renderBukuBesar,
    filterBukuSaku: filterBukuSaku,
    filterBukuBesar: filterBukuBesar,
    loadMoreBukuSaku: loadMoreBukuSaku,
    loadMoreBukuBesar: loadMoreBukuBesar
  };

})();
