// ============================================================
// MEFOBILLS - INTEREST MODULE
// Simple and compound accrual on promissory notes
// ============================================================

var BGInterest = (function () {

  var MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

  // months elapsed since bill creation (fractional)
  function monthsElapsed(bill, as_of) {
    var t = as_of || Date.now();
    return Math.max(0, (t - bill.waktu) / MS_PER_MONTH);
  }

  // accrued interest only (not principal)
  function calcAccrued(bill, as_of) {
    var rate = bill.interest_rate || 0;
    if (rate === 0) return 0;
    var months = monthsElapsed(bill, as_of);
    if (bill.interest_type === 'COMPOUND') {
      return bill.amount * (Math.pow(1 + rate, months) - 1);
    }
    // SIMPLE (default)
    return bill.amount * rate * months;
  }

  // total owed = remaining_amount + accrued on remaining
  function calcTotal(bill, as_of) {
    var rate = bill.interest_rate || 0;
    if (rate === 0) return bill.remaining_amount;
    var months = monthsElapsed(bill, as_of);
    if (bill.interest_type === 'COMPOUND') {
      return bill.remaining_amount * Math.pow(1 + rate, months);
    }
    return bill.remaining_amount * (1 + rate * months);
  }

  // display string e.g. "2%/bln (simple)" or "0% (bebas bunga)"
  function formatRate(bill) {
    var rate = bill.interest_rate || 0;
    if (rate === 0) return '0% (bebas bunga)';
    var pct = (rate * 100).toFixed(2).replace(/\.?0+$/, '');
    var type = bill.interest_type === 'COMPOUND' ? 'majemuk' : 'flat';
    return pct + '%/bln (' + type + ')';
  }

  // is this bill past due date?
  function isOverdue(bill, as_of) {
    if (!bill.due_date) return false;
    return (as_of || Date.now()) > bill.due_date;
  }

  // is this bill in default (past due + grace)?
  function isDefault(bill, as_of) {
    if (!bill.due_date) return false;
    var grace = (bill.grace_days || 0) * 24 * 60 * 60 * 1000;
    return (as_of || Date.now()) > (bill.due_date + grace);
  }

  return {
    calcAccrued: calcAccrued,
    calcTotal: calcTotal,
    formatRate: formatRate,
    isOverdue: isOverdue,
    isDefault: isDefault,
    monthsElapsed: monthsElapsed
  };

})();
