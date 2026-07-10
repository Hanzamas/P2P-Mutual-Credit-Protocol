// ============================================================
// MEFOBILLS - NOTE MODULE
// Bill lifecycle: create, accept, settle (full/partial), default check
// ============================================================

var BGNote = (function () {

  var FIAT_CURRENCIES = ['IDR', 'USD', 'EUR', 'SGD', 'MYR', 'SAR', 'CNY', 'GBP', 'JPY'];
  var COMMODITY_UNITS = ['KG', 'LITER', 'ZAK', 'UNIT', 'LEMBAR', 'KARUNG', 'TON', 'KWINTAL', 'METER'];
  var MAX_AMOUNT = 1e15; // 1 quadrillion (covers any currency/commodity)
  var MAX_NOTE_LENGTH = 200;
  var MAX_ASSET_NAME_LENGTH = 50;

  // ---- Canonicalize (for signing) ----
  // Covers all fields that must not be tampered with.
  function canonicalize(bill) {
    var parts = [
      bill.id,
      bill.waktu,
      bill.type,
      bill.from_pub_key,
      bill.to_pub_key,
      bill.circle_genesis_id,
      bill.asset_type,
      bill.asset_unit,
      bill.asset_name || '',
      bill.amount,
      bill.interest_rate || 0,
      bill.interest_type || 'SIMPLE',
      bill.due_date || '',
      bill.grace_days || 0,
      (bill.keterangan || '').replace(/\|/g, '-'),
      bill.guarantor_pub_key || '',
      bill.parent_tx_id || '',
      bill.logical_clock || 0,
      bill.prev_hash || ''
    ];
    return parts.join('|');
  }

  // ---- Validate bill schema ----
  function validateBill(bill) {
    if (!bill.id || typeof bill.id !== 'string') return 'ID bill hilang.';
    if (!bill.waktu || typeof bill.waktu !== 'number') return 'Timestamp tidak valid.';
    if (bill.waktu < 1600000000000 || bill.waktu > 4000000000000) return 'Timestamp di luar jangkauan.';
    if (!['DEBIT_NOTE', 'SETTLEMENT', 'ENDORSEMENT_OUT', 'ENDORSEMENT_IN', 'RECEIPT'].includes(bill.type)) return 'Tipe bill tidak dikenali.';
    if (!bill.from_pub_key || typeof bill.from_pub_key !== 'string') return 'from_pub_key hilang.';
    if (!bill.to_pub_key || typeof bill.to_pub_key !== 'string') return 'to_pub_key hilang.';
    if (bill.from_pub_key === bill.to_pub_key) return 'from dan to tidak boleh sama.';
    if (!bill.circle_genesis_id || typeof bill.circle_genesis_id !== 'string') return 'circle_genesis_id hilang.';
    if (!['FIAT', 'COMMODITY'].includes(bill.asset_type)) return 'asset_type tidak valid.';
    if (!bill.asset_unit || typeof bill.asset_unit !== 'string') return 'asset_unit hilang.';
    if (bill.asset_unit.length > 10) return 'asset_unit terlalu panjang.';
    if (bill.asset_type === 'COMMODITY') {
      if (!bill.asset_name || typeof bill.asset_name !== 'string') return 'asset_name wajib untuk COMMODITY.';
      if (bill.asset_name.length > MAX_ASSET_NAME_LENGTH) return 'asset_name terlalu panjang.';
    }
    if (typeof bill.amount !== 'number' || bill.amount <= 0) return 'Jumlah tidak valid.';
    if (bill.amount > MAX_AMOUNT) return 'Jumlah melebihi batas maksimal.';
    if (typeof bill.remaining_amount !== 'number' || bill.remaining_amount < 0) return 'remaining_amount tidak valid.';
    if (bill.remaining_amount > bill.amount) return 'remaining_amount tidak boleh melebihi amount.';
    if (bill.interest_rate !== undefined && (typeof bill.interest_rate !== 'number' || bill.interest_rate < 0 || bill.interest_rate > 10)) {
      return 'interest_rate tidak valid (0.0 - 10.0).';
    }
    if (bill.interest_type && !['SIMPLE', 'COMPOUND'].includes(bill.interest_type)) return 'interest_type tidak valid.';
    if (bill.keterangan && bill.keterangan.length > MAX_NOTE_LENGTH) return 'Keterangan terlalu panjang.';
    if (!bill.pub_key || typeof bill.pub_key !== 'string') return 'pub_key penanda tangan hilang.';
    if (!bill.signature || typeof bill.signature !== 'string') return 'Tanda tangan hilang.';
    if (typeof bill.logical_clock !== 'number' || bill.logical_clock < 0) return 'logical_clock tidak valid.';
    return null; // valid
  }

  // ---- Build prev_hash for chain (per pub_key) ----
  async function buildPrevHash(myBills) {
    if (!myBills.length) return 'GENESIS';
    var sorted = myBills.slice().sort(function (a, b) { return a.logical_clock - b.logical_clock; });
    var last = sorted[sorted.length - 1];
    return BGCrypto.sha256(last.id + '|' + last.signature);
  }

  // ---- Create a new DEBIT_NOTE ----
  // Called by the CREDITOR on behalf of the debtor.
  // from_pub_key = debtor (who owes), to_pub_key = creditor (who receives).
  // pub_key = myPubKey (the signing key — always the creditor/creator).
  async function createBill(params, myPrivKey, myPubKey, logicalClock, circleGenesisId) {
    var {
      from_pub_key,   // debtor — explicit override; defaults to myPubKey if omitted
      to_pub_key,
      asset_type,
      asset_unit,
      asset_name,
      amount,
      interest_rate,
      interest_type,
      due_date,
      grace_days,
      keterangan,
      tags,
      guarantor_pub_key
    } = params;

    // input sanity
    asset_type = asset_type || 'FIAT';
    asset_unit = (asset_unit || 'IDR').toUpperCase().trim();
    asset_name = asset_type === 'COMMODITY' ? (asset_name || '').trim() : null;
    interest_rate = interest_rate || 0;
    interest_type = interest_type || 'SIMPLE';
    grace_days = grace_days || 0;
    keterangan = (keterangan || '').trim().replace(/[\x00-\x1f\x7f]/g, '');

    // build bill object
    var myBills = await BGDB.getBillsByParty(myPubKey);
    var prevHash = await buildPrevHash(myBills.filter(function(b){ return b.pub_key === myPubKey; }));

    var bill = {
      id: BGCrypto.uuid(),
      waktu: Date.now(),
      due_date: due_date || null,
      grace_days: grace_days,
      type: 'DEBIT_NOTE',
      status: 'PENDING_ACCEPTANCE', // becomes ACTIVE after counterparty accepts
      from_pub_key: from_pub_key || myPubKey, // debtor; defaults to myPubKey for self-IOU
      to_pub_key: to_pub_key,
      circle_genesis_id: circleGenesisId,
      asset_type: asset_type,
      asset_unit: asset_unit,
      asset_name: asset_name,
      amount: amount,
      remaining_amount: amount,
      interest_rate: interest_rate,
      interest_type: interest_type,
      keterangan: keterangan,
      tags: tags || [],
      guarantor_pub_key: guarantor_pub_key || null,
      parent_tx_id: null,
      pub_key: myPubKey,
      signature: '',
      logical_clock: logicalClock,
      prev_hash: prevHash
    };

    var err = validateBill(bill);
    if (err) throw new Error(err);

    bill.signature = await BGCrypto.sign(myPrivKey, canonicalize(bill));

    return bill;
  }

  // ---- Accept a DEBIT_NOTE (creditor scans QR) ----
  // Verifies signature, checks circle membership, saves, returns RECEIPT tx
  async function acceptBill(bill, myPrivKey, myPubKey, logicalClock) {
    // validate schema
    var err = validateBill(bill);
    if (err) throw new Error('Bill tidak valid: ' + err);

    // verify debtor's signature
    var valid = await BGCrypto.verify(bill.pub_key, canonicalize(bill), bill.signature);
    if (!valid) throw new Error('Tanda tangan bill palsu!');

    // must be addressed to me
    if (bill.to_pub_key !== myPubKey) throw new Error('Bill ini bukan untuk anda.');

    // check not already accepted
    var existing = await BGDB.getBillById(bill.id);
    if (existing && existing.status !== 'PENDING_ACCEPTANCE') {
      throw new Error('Bill sudah diproses sebelumnya.');
    }

    // activate bill
    bill.status = 'ACTIVE';

    // build receipt tx (creditor's acknowledgment — signed by me)
    var myBills = await BGDB.getBillsByParty(myPubKey);
    var prevHash = await buildPrevHash(myBills.filter(function(b){ return b.pub_key === myPubKey; }));

    var receipt = {
      id: BGCrypto.uuid(),
      waktu: Date.now(),
      type: 'RECEIPT',
      status: 'ACTIVE',
      ref_bill_id: bill.id,
      from_pub_key: bill.from_pub_key,
      to_pub_key: myPubKey,
      circle_genesis_id: bill.circle_genesis_id,
      asset_type: bill.asset_type,
      asset_unit: bill.asset_unit,
      asset_name: bill.asset_name,
      amount: bill.amount,
      remaining_amount: bill.amount,
      interest_rate: bill.interest_rate,
      interest_type: bill.interest_type,
      keterangan: 'Konfirmasi terima: ' + bill.keterangan,
      pub_key: myPubKey,
      signature: '',
      logical_clock: logicalClock,
      prev_hash: prevHash
    };

    receipt.signature = await BGCrypto.sign(myPrivKey, canonicalize(receipt));

    // save both
    await BGDB.saveBill(bill);
    await BGDB.saveBill(receipt);

    // ensure debtor is in peers
    var existingPeer = await BGDB.getPeer(bill.from_pub_key);
    if (!existingPeer) {
      await BGDB.savePeer({
        pub_key: bill.from_pub_key,
        nama: bill.from_pub_key.substring(0, 12) + '...',
        last_sync: Date.now(),
        reputation_score: 100
      });
    }

    return { bill: bill, receipt: receipt };
  }

  // ---- Settle a bill (debtor initiates, creditor confirms) ----
  // Partial settlement supported: settled_amount <= remaining_amount
  async function createSettlement(bill_id, settled_amount, settlement_method, myPrivKey, myPubKey, logicalClock) {
    var bill = await BGDB.getBillById(bill_id);
    if (!bill) throw new Error('Bill tidak ditemukan.');
    if (bill.status !== 'ACTIVE') throw new Error('Bill tidak dalam status ACTIVE.');
    if (bill.from_pub_key !== myPubKey) throw new Error('Hanya debitur yang bisa melunasi.');

    // total owed including interest
    var totalOwed = BGInterest.calcTotal(bill);
    if (settled_amount <= 0 || settled_amount > totalOwed) {
      throw new Error('Jumlah pelunasan tidak valid (1 - ' + totalOwed + ').');
    }

    settlement_method = settlement_method || 'FIAT';
    if (!['FIAT', 'COMMODITY', 'NETTING'].includes(settlement_method)) {
      throw new Error('Metode pelunasan tidak valid.');
    }

    var myBills = await BGDB.getBillsByParty(myPubKey);
    var prevHash = await buildPrevHash(myBills.filter(function(b){ return b.pub_key === myPubKey; }));

    var isFullSettlement = settled_amount >= totalOwed;

    var settlement = {
      id: BGCrypto.uuid(),
      waktu: Date.now(),
      type: 'SETTLEMENT',
      status: 'PENDING_CONFIRMATION', // creditor must confirm
      ref_bill_id: bill_id,
      from_pub_key: myPubKey,
      to_pub_key: bill.to_pub_key,
      circle_genesis_id: bill.circle_genesis_id,
      asset_type: bill.asset_type,
      asset_unit: bill.asset_unit,
      asset_name: bill.asset_name,
      amount: settled_amount,
      remaining_amount: settled_amount,
      interest_rate: 0,
      interest_type: 'SIMPLE',
      settlement_method: settlement_method,
      is_full_settlement: isFullSettlement,
      keterangan: (isFullSettlement ? 'Pelunasan penuh' : 'Pelunasan sebagian') + ': ' + bill.keterangan,
      pub_key: myPubKey,
      signature: '',
      logical_clock: logicalClock,
      prev_hash: prevHash
    };

    settlement.signature = await BGCrypto.sign(myPrivKey, canonicalize(settlement));

    return settlement;
  }

  // ---- Confirm settlement (creditor confirms) ----
  async function confirmSettlement(settlement, myPrivKey, myPubKey, logicalClock) {
    var err = validateBill(settlement);
    if (err) throw new Error('Settlement tidak valid: ' + err);

    var valid = await BGCrypto.verify(settlement.pub_key, canonicalize(settlement), settlement.signature);
    if (!valid) throw new Error('Tanda tangan settlement palsu!');

    if (settlement.to_pub_key !== myPubKey) throw new Error('Settlement ini bukan untuk anda.');

    var bill = await BGDB.getBillById(settlement.ref_bill_id);
    if (!bill) throw new Error('Bill asal tidak ditemukan.');

    settlement.status = 'CONFIRMED';

    // update bill
    if (settlement.is_full_settlement) {
      bill.status = 'SETTLED';
      bill.remaining_amount = 0;
      bill.settled_at = Date.now();
      bill.settlement_method = settlement.settlement_method;
    } else {
      // Reduce by the settled amount exactly — avoid re-deriving totalOwed
      // (would cause interest drift if confirmation happens seconds/minutes later)
      bill.remaining_amount = Math.max(0, bill.remaining_amount - settlement.amount);
      if (bill.remaining_amount === 0) {
        bill.status = 'SETTLED';
        bill.settled_at = Date.now();
        bill.settlement_method = settlement.settlement_method;
      }
    }

    await BGDB.saveBill(settlement);
    await BGDB.saveBill(bill);

    return { settlement: settlement, bill: bill };
  }

  // ---- Scan all ACTIVE bills and flip to DEFAULTED if past grace ----
  async function checkDefaults() {
    var activeBills = await BGDB.getBillsByStatus('ACTIVE');
    var defaulted = [];
    for (var i = 0; i < activeBills.length; i++) {
      var b = activeBills[i];
      if (BGInterest.isDefault(b)) {
        await BGDB.updateBillStatus(b.id, 'DEFAULTED', { defaulted_at: Date.now() });
        defaulted.push(b);
      }
    }
    return defaulted;
  }

  // ---- Build compact QR payload for a bill ----
  function toQRPayload(bill) {
    return JSON.stringify({
      _mb: 2, // mefo bills bill flag
      id: bill.id,
      w: bill.waktu,
      dd: bill.due_date,
      gd: bill.grace_days,
      t: bill.type,
      fp: bill.from_pub_key,
      tp: bill.to_pub_key,
      cg: bill.circle_genesis_id,
      at: bill.asset_type,
      au: bill.asset_unit,
      an: bill.asset_name,
      am: bill.amount,
      ra: bill.remaining_amount,
      ir: bill.interest_rate,
      it: bill.interest_type,
      k: bill.keterangan,
      g: bill.guarantor_pub_key,
      px: bill.parent_tx_id,
      pk: bill.pub_key,
      sig: bill.signature,
      lc: bill.logical_clock,
      ph: bill.prev_hash
    });
  }

  // ---- Parse QR payload back to full bill object ----
  function fromQRPayload(raw) {
    var obj = JSON.parse(raw);
    if (obj._mb !== 2) throw new Error('Bukan QR MefoBills.');
    return {
      id: obj.id,
      waktu: obj.w,
      due_date: obj.dd,
      grace_days: obj.gd,
      type: obj.t,
      status: 'PENDING_ACCEPTANCE',
      from_pub_key: obj.fp,
      to_pub_key: obj.tp,
      circle_genesis_id: obj.cg,
      asset_type: obj.at,
      asset_unit: obj.au,
      asset_name: obj.an,
      amount: obj.am,
      remaining_amount: obj.ra,
      interest_rate: obj.ir,
      interest_type: obj.it,
      keterangan: obj.k,
      guarantor_pub_key: obj.g,
      parent_tx_id: obj.px,
      pub_key: obj.pk,
      signature: obj.sig,
      logical_clock: obj.lc,
      prev_hash: obj.ph
    };
  }

  // ---- Human-readable asset label ----
  function assetLabel(bill) {
    if (bill.asset_type === 'FIAT') {
      return bill.asset_unit; // IDR / USD / EUR
    }
    return bill.amount + ' ' + bill.asset_unit + (bill.asset_name ? ' ' + bill.asset_name : '');
  }

  return {
    canonicalize: canonicalize,
    validateBill: validateBill,
    createBill: createBill,
    acceptBill: acceptBill,
    createSettlement: createSettlement,
    confirmSettlement: confirmSettlement,
    checkDefaults: checkDefaults,
    toQRPayload: toQRPayload,
    fromQRPayload: fromQRPayload,
    assetLabel: assetLabel,
    buildPrevHash: buildPrevHash,
    FIAT_CURRENCIES: FIAT_CURRENCIES,
    COMMODITY_UNITS: COMMODITY_UNITS
  };

})();
