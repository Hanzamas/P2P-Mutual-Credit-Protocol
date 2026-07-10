// ============================================================
// MEFOBILLS - ENDORSEMENT MODULE
// UTXO-style fractional bill splitting + transfer to 3rd party
// ============================================================

var BGEndorse = (function () {

  // Split bill_id: transfer split_amount to new_to_pub_key
  // Returns { parent (SPENT), remainder, endorsed } — save all 3
  async function splitBill(bill_id, new_to_pub_key, split_amount, myPrivKey, myPubKey, logicalClock) {
    var bill = await BGDB.getBillById(bill_id);
    if (!bill) throw new Error('Bill tidak ditemukan.');
    if (bill.status !== 'ACTIVE') throw new Error('Hanya bill ACTIVE yang bisa dipecah.');
    if (bill.to_pub_key !== myPubKey) throw new Error('Hanya pemegang piutang yang bisa mengoper.');

    var totalOwed = BGInterest.calcTotal(bill);
    if (split_amount <= 0 || split_amount >= totalOwed) {
      throw new Error('Jumlah split harus lebih dari 0 dan kurang dari total tagihan (' + totalOwed + ').');
    }

    if (new_to_pub_key === myPubKey) throw new Error('Tidak bisa mengoper ke diri sendiri.');
    if (new_to_pub_key === bill.from_pub_key) throw new Error('Tidak bisa mengoper kembali ke debitur.');

    var myBills = await BGDB.getBillsByParty(myPubKey);
    var prevHash = await BGNote.buildPrevHash(myBills.filter(function(b){ return b.pub_key === myPubKey; }));
    var now = Date.now();

    // 1. mark parent as SPENT
    var parent = Object.assign({}, bill, {
      status: 'SPENT',
      spent_at: now,
      spent_into: [] // filled below
    });

    var remainder_amount = totalOwed - split_amount;

    // 2. remainder bill (stays with me, same debtor)
    // Interest is FROZEN on remainder: the split is based on totalOwed (already includes
    // accrued interest), so new bills must have interest_rate=0 to avoid double-counting.
    var remainder = {
      id: BGCrypto.uuid(),
      waktu: now,
      due_date: bill.due_date,
      grace_days: bill.grace_days,
      type: 'DEBIT_NOTE',
      status: 'ACTIVE',
      from_pub_key: bill.from_pub_key,
      to_pub_key: myPubKey,
      circle_genesis_id: bill.circle_genesis_id,
      asset_type: bill.asset_type,
      asset_unit: bill.asset_unit,
      asset_name: bill.asset_name,
      amount: remainder_amount,
      remaining_amount: remainder_amount,
      interest_rate: 0,        // frozen: value already includes accrued interest
      interest_type: 'SIMPLE', // irrelevant at 0%, but keep field consistent
      keterangan: bill.keterangan,
      guarantor_pub_key: bill.guarantor_pub_key,
      parent_tx_id: bill.id,
      pub_key: myPubKey,
      signature: '',
      logical_clock: logicalClock,
      prev_hash: prevHash
    };
    remainder.signature = await BGCrypto.sign(myPrivKey, BGNote.canonicalize(remainder));

    // Endorsed bill also frozen: recipient gets a fixed-value claim.
    var endorsed = {
      id: BGCrypto.uuid(),
      waktu: now,
      due_date: bill.due_date,
      grace_days: bill.grace_days,
      type: 'ENDORSEMENT_OUT',
      status: 'PENDING_ACCEPTANCE',
      from_pub_key: bill.from_pub_key,
      to_pub_key: new_to_pub_key,
      circle_genesis_id: bill.circle_genesis_id,
      asset_type: bill.asset_type,
      asset_unit: bill.asset_unit,
      asset_name: bill.asset_name,
      amount: split_amount,
      remaining_amount: split_amount,
      interest_rate: 0,        // frozen
      interest_type: 'SIMPLE',
      keterangan: bill.keterangan,
      guarantor_pub_key: bill.guarantor_pub_key,
      parent_tx_id: bill.id,
      endorsed_by: myPubKey,
      pub_key: myPubKey,
      signature: '',
      logical_clock: logicalClock + 1,
      prev_hash: remainder.id // chain: prev is remainder
    };
    endorsed.signature = await BGCrypto.sign(myPrivKey, BGNote.canonicalize(endorsed));

    parent.spent_into = [remainder.id, endorsed.id];

    // save all 3
    await BGDB.saveBill(parent);
    await BGDB.saveBill(remainder);
    await BGDB.saveBill(endorsed);

    return { parent: parent, remainder: remainder, endorsed: endorsed };
  }

  // Get full endorsement chain for a bill (traverse parent_tx_id)
  async function getEndorsementChain(bill_id) {
    var chain = [];
    var visited = new Set();
    var current_id = bill_id;

    while (current_id && !visited.has(current_id)) {
      visited.add(current_id);
      var bill = await BGDB.getBillById(current_id);
      if (!bill) break;
      chain.unshift(bill); // prepend to get oldest first
      current_id = bill.parent_tx_id;
    }

    return chain;
  }

  // Get all children of a SPENT bill
  async function getChildren(bill_id) {
    var all = await BGDB.getAllBills();
    return all.filter(function(b){ return b.parent_tx_id === bill_id; });
  }

  return {
    splitBill: splitBill,
    getEndorsementChain: getEndorsementChain,
    getChildren: getChildren
  };

})();
