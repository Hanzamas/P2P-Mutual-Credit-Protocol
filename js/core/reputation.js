// ============================================================
// MEFOBILLS - REPUTATION MODULE
// Score per peer based on settlement history + time decay
// ============================================================

var BGReputation = (function () {

  var DECAY_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  var DECAY_RATE = 0.99; // per period

  function calcScore(pub_key, all_bills, peer) {
    // always recompute fresh from bill history, starting at neutral 50
    var score = 50;
    for (var i = 0; i < all_bills.length; i++) {
      var b = all_bills[i];
      var is_debtor = b.from_pub_key === pub_key;
      var is_creditor = b.to_pub_key === pub_key;
      if (!is_debtor && !is_creditor) continue;

      if (is_debtor) {
        if (b.status === 'SETTLED') {
          var settled_before_due = !b.due_date || b.settled_at <= b.due_date;
          score += settled_before_due ? 10 : 5;
        }
        if (b.status === 'DEFAULTED') score -= 30;
        if (b.status === 'ACTIVE' && BGInterest.isOverdue(b)) score -= 5;
      }
    }

    // time decay: score drifts toward 50 if no recent activity
    if (peer && peer.last_sync) {
      var periods = (Date.now() - peer.last_sync) / DECAY_PERIOD_MS;
      if (periods > 0) {
        score = 50 + (score - 50) * Math.pow(DECAY_RATE, periods);
      }
    }

    return Math.round(Math.max(0, Math.min(100, score)));
  }

  function getBadge(score) {
    if (score >= 70) return 'green';
    if (score >= 40) return 'yellow';
    return 'red';
  }

  function getBadgeEmoji(score) {
    if (score >= 70) return '🟢';
    if (score >= 40) return '🟡';
    return '🔴';
  }

  async function updateReputation(pub_key) {
    var all_bills = await BGDB.getAllBills();
    var peer = await BGDB.getPeer(pub_key);
    if (!peer) return null;

    var score = calcScore(pub_key, all_bills, peer);
    peer.reputation_score = score;
    peer.reputation_badge = getBadge(score);
    peer.reputation_updated = Date.now();

    await BGDB.savePeer(peer);
    return { pub_key, score, badge: getBadge(score) };
  }

  async function updateAllReputations() {
    var peers = await BGDB.getAllPeers();
    var all_bills = await BGDB.getAllBills();
    for (var i = 0; i < peers.length; i++) {
      await Promise.resolve(); // yield
      var p = peers[i];
      var score = calcScore(p.pub_key, all_bills, p);
      p.reputation_score = score;
      p.reputation_badge = getBadge(score);
      p.reputation_updated = Date.now();
      await BGDB.savePeer(p);
    }
  }

  return {
    calcScore: calcScore,
    getBadge: getBadge,
    getBadgeEmoji: getBadgeEmoji,
    updateReputation: updateReputation,
    updateAllReputations: updateAllReputations
  };

})();
