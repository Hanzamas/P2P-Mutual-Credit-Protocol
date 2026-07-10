// ============================================================
// MEFOBILLS - REPORTS RENDERER
// Monthly summary + netting logs + community stats
// ============================================================

var RenderReports = (function () {

  var currentMonth = new Date().getMonth();
  var currentYear = new Date().getFullYear();

  async function render(state) {
    _renderMonthNav();
    _renderMonthlySummary(state);
    await _renderNettingLog();
    _renderCircleStats(state);
  }

  function _renderMonthNav() {
    var el = document.getElementById('report-month-label');
    if (!el) return;
    var d = new Date(currentYear, currentMonth, 1);
    el.textContent = d.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
  }

  function prevMonth() {
    currentMonth--;
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    _renderMonthNav();
    // re-render with current state from BG
    if (window.BG) RenderReports.render(window.BG.getState());
  }

  function nextMonth() {
    currentMonth++;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    _renderMonthNav();
    if (window.BG) RenderReports.render(window.BG.getState());
  }

  function _renderMonthlySummary(state) {
    var startMs = new Date(currentYear, currentMonth, 1).getTime();
    var endMs = new Date(currentYear, currentMonth + 1, 0, 23, 59, 59).getTime();

    var allBills = state.bills || [];

    // issued: created this month
    var issued = allBills.filter(function(b){
      return b.type === 'DEBIT_NOTE' && b.waktu >= startMs && b.waktu <= endMs;
    });
    // settled: paid this month (use settled_at if available, fallback to waktu)
    var settled = allBills.filter(function(b){
      var t = b.settled_at || b.waktu;
      return b.status === 'SETTLED' && t >= startMs && t <= endMs;
    });
    // defaulted: went into default this month
    var defaulted = allBills.filter(function(b){
      var t = b.defaulted_at || b.waktu;
      return b.status === 'DEFAULTED' && t >= startMs && t <= endMs;
    });

    _setText('report-issued-count', issued.length + ' nota diterbitkan');
    _setText('report-settled-count', settled.length + ' lunas');
    _setText('report-defaulted-count', defaulted.length + ' macet');

    // group by asset — show issued this month
    var assetSummary = {};
    for (var i = 0; i < issued.length; i++) {
      var b = issued[i];
      var key = b.asset_type + ':' + b.asset_unit + ':' + (b.asset_name || '');
      if (!assetSummary[key]) assetSummary[key] = { issued: 0, settled: 0 };
      assetSummary[key].issued += b.amount;
    }
    for (var j = 0; j < settled.length; j++) {
      var bs = settled[j];
      var ks = bs.asset_type + ':' + bs.asset_unit + ':' + (bs.asset_name || '');
      if (!assetSummary[ks]) assetSummary[ks] = { issued: 0, settled: 0 };
      assetSummary[ks].settled += bs.amount;
    }

    var assetEl = document.getElementById('report-asset-breakdown');
    if (assetEl) {
      var html = '';
      var keys = Object.keys(assetSummary);
      if (!keys.length) { html = '<p class="text-dim text-sm text-center">Tidak ada nota bulan ini.</p>'; }
      for (var k = 0; k < keys.length; k++) {
        var ak = keys[k];
        var parts = ak.split(':');
        var s = assetSummary[ak];
        var labelIssued = BGUI.formatAmount(s.issued, parts[0], parts[1], parts[2] || null);
        var labelSettled = BGUI.formatAmount(s.settled, parts[0], parts[1], parts[2] || null);
        html += '<div class="report-asset-row">';
        html += '<span class="report-asset-name">' + BGUI.escapeHtml(parts[1] + (parts[2] ? ' ' + parts[2] : '')) + '</span>';
        html += '<span class="report-issued">Terbit: ' + BGUI.escapeHtml(labelIssued) + '</span>';
        html += '<span class="report-settled color-green">Lunas: ' + BGUI.escapeHtml(labelSettled) + '</span>';
        html += '</div>';
      }
      assetEl.innerHTML = html;
    }
  }

  async function _renderNettingLog() {
    var el = document.getElementById('report-netting-log');
    if (!el) return;
    var logs = await BGDB.getAllNettingLogs();
    if (!logs.length) { el.innerHTML = '<p class="text-dim text-sm text-center">Belum ada hapus silang.</p>'; return; }

    var sorted = logs.sort(function(a,b){ return b.waktu - a.waktu; }).slice(0, 10);
    var html = '';
    for (var i = 0; i < sorted.length; i++) {
      var log = sorted[i];
      var parts = log.asset_key.split(':');
      var amtStr = BGUI.formatAmount(log.cleared_amount, parts[0], parts[1], parts[2] || null);
      html += '<div class="netting-log-item">';
      html += '<span class="netting-log-icon">\u26A1</span>';
      html += '<span>' + BGUI.escapeHtml(amtStr) + ' terhapus (' + log.participants.length + ' pihak)</span>';
      html += '<span class="netting-log-date text-dim text-sm">' + BGUI.formatDate(log.waktu) + '</span>';
      html += '</div>';
    }
    el.innerHTML = html;
  }

  function _renderCircleStats(state) {
    var bills = state.bills || [];
    var active = bills.filter(function(b){ return b.status === 'ACTIVE'; }).length;
    var members = (state.peers || []).length;
    _setText('report-circle-active', active + ' nota aktif');
    _setText('report-circle-members', members + ' anggota');
  }

  function _setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  return {
    render: render,
    prevMonth: prevMonth,
    nextMonth: nextMonth
  };

})();
