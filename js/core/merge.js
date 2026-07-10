// ============================================================
// MEFOBILLS - MERGE ENGINE
// Validates + deduplicates incoming bills from peers
// Anti-spam, rate limit, signature verify, hash chain verify
// ============================================================

var BGMerge = (function () {

  var MIN_TIMESTAMP = new Date('2020-01-01').getTime();
  var MAX_TIMESTAMP = new Date('2060-01-01').getTime();
  var VALID_TYPES = ['DEBIT_NOTE', 'SETTLEMENT', 'ENDORSEMENT_OUT', 'ENDORSEMENT_IN', 'RECEIPT'];
  var VALID_STATUSES = ['PENDING_ACCEPTANCE', 'ACTIVE', 'SETTLED', 'DEFAULTED', 'SPENT', 'PENDING_CONFIRMATION', 'CONFIRMED'];

  function isValidStatus(status) {
    return VALID_STATUSES.includes(status) || (typeof status === 'string' && /^CLOSED_\d{4}-\d{2}$/.test(status));
  }

  // ---- Validate incoming bill schema ----
  function validateBill(bill) {
    if (!bill.id || typeof bill.id !== 'string') return 'ID bill hilang';
    if (!bill.waktu || typeof bill.waktu !== 'number') return 'waktu tidak valid';
    if (bill.waktu < MIN_TIMESTAMP || bill.waktu > MAX_TIMESTAMP) return 'waktu di luar jangkauan';
    if (!VALID_TYPES.includes(bill.type)) return 'type tidak dikenali: ' + bill.type;
    if (!bill.from_pub_key || typeof bill.from_pub_key !== 'string') return 'from_pub_key hilang';
    if (!bill.to_pub_key || typeof bill.to_pub_key !== 'string') return 'to_pub_key hilang';
    if (bill.from_pub_key === bill.to_pub_key) return 'from dan to sama';
    if (!bill.circle_genesis_id || typeof bill.circle_genesis_id !== 'string') return 'circle_genesis_id hilang';
    if (!['FIAT', 'COMMODITY'].includes(bill.asset_type)) return 'asset_type tidak valid';
    if (!bill.asset_unit || typeof bill.asset_unit !== 'string') return 'asset_unit hilang';
    if (bill.asset_unit.length > 10) return 'asset_unit terlalu panjang';
    if (bill.asset_type === 'COMMODITY' && (!bill.asset_name || typeof bill.asset_name !== 'string')) return 'asset_name wajib untuk COMMODITY';
    if (typeof bill.amount !== 'number' || bill.amount <= 0) return 'amount tidak valid';
    if (bill.amount > 1e15) return 'amount terlalu besar';
    if (typeof bill.remaining_amount !== 'number' || bill.remaining_amount < 0) return 'remaining_amount tidak valid';
    if (bill.interest_rate !== undefined && (typeof bill.interest_rate !== 'number' || bill.interest_rate < 0 || bill.interest_rate > 10)) return 'interest_rate tidak valid';
    if (bill.interest_type && !['SIMPLE', 'COMPOUND'].includes(bill.interest_type)) return 'interest_type tidak valid';
    if (bill.keterangan && bill.keterangan.length > 200) return 'keterangan terlalu panjang';
    if (!bill.pub_key || typeof bill.pub_key !== 'string') return 'pub_key hilang';
    if (!bill.signature || typeof bill.signature !== 'string') return 'signature hilang';
    if (typeof bill.logical_clock !== 'number' || bill.logical_clock < 0) return 'logical_clock tidak valid';
    return null;
  }

  // ---- Hash chain verify per pub_key ----
  async function computeBillHash(bill) {
    return BGCrypto.sha256(bill.id + '|' + bill.signature);
  }

  async function verifyChain(sortedBills) {
    if (!sortedBills.length) return { valid: true, broken: [] };

    var chains = {};
    for (var i = 0; i < sortedBills.length; i++) {
      var b = sortedBills[i];
      if (!chains[b.pub_key]) chains[b.pub_key] = [];
      chains[b.pub_key].push(b);
    }

    var broken = [];
    for (var key in chains) {
      var chain = chains[key];
      for (var j = 0; j < chain.length; j++) {
        var bill = chain[j];
        if (!bill.prev_hash) continue;
        if (j === 0) {
          if (bill.prev_hash !== 'GENESIS') broken.push({ bill: bill, reason: 'Catatan awal tidak valid' });
        } else {
          var expected = await computeBillHash(chain[j - 1]);
          if (bill.prev_hash !== expected) broken.push({ bill: bill, reason: 'Rantai keamanan rusak' });
        }
      }
    }
    return { valid: broken.length === 0, broken: broken };
  }

  // ---- Merge incoming bills ----
  // incoming: array of bill objects from peer
  // localIds: Set of IDs already in local DB
  async function merge(localIds, incomingBills) {
    if (incomingBills.length > 5000) {
      return { newBills: [], rejected: incomingBills, alarm: true, alarmDetail: 'DITOLAK: Payload terlalu besar (>5000 bills). Kemungkinan spam.' };
    }

    var fresh = [];
    var senderCounts = {};
    for (var i = 0; i < incomingBills.length; i++) {
      var b = incomingBills[i];
      if (!localIds.has(b.id)) {
        var pk = b.pub_key;
        senderCounts[pk] = (senderCounts[pk] || 0) + 1;
        fresh.push(b);
      }
    }

    // rate limit: max 500 new bills per pub_key per sync
    for (var spk in senderCounts) {
      if (senderCounts[spk] > 500) {
        return { newBills: [], rejected: fresh, alarm: true, alarmDetail: 'DITOLAK: Aktivitas tidak wajar (' + senderCounts[spk] + ' bills baru dari 1 pubkey).' };
      }
    }

    if (!fresh.length) return { newBills: [], rejected: [], alarm: false, alarmDetail: '' };

    var rejected = [];
    var verified = [];

    for (var k = 0; k < fresh.length; k++) {
      var bill = fresh[k];

      var reason = validateBill(bill);
      if (reason) {
        bill._rejectReason = reason;
        rejected.push(bill);
        continue;
      }

      var valid = false;
      try {
        valid = await BGCrypto.verify(bill.pub_key, BGNote.canonicalize(bill), bill.signature);
      } catch (e) {
        valid = false;
      }

      if (!valid) {
        bill._rejectReason = 'Tanda tangan palsu';
        rejected.push(bill);
      } else {
        verified.push(bill);
      }

      // yield every 20 verifications (non-blocking for large batches)
      if (k % 20 === 0) await Promise.resolve();
    }

    var alarm = rejected.length > 0;
    var alarmDetail = '';
    if (alarm) {
      alarmDetail = 'TERCIDUK! ' + rejected.length + ' bill palsu ditolak.\n\n';
      for (var r = 0; r < Math.min(rejected.length, 3); r++) {
        var rj = rejected[r];
        alarmDetail += '- ' + (rj.pub_key ? rj.pub_key.substring(0, 12) + '...' : '?') + ': ' + (rj._rejectReason || '-') + '\n';
      }
    }

    return { newBills: verified, rejected: rejected, alarm: alarm, alarmDetail: alarmDetail };
  }

  // ---- Compress/decompress bills for wire transport ----
  function compress(b) {
    var c = {
      i: b.id, w: b.waktu, t: b.type, st: b.status,
      fp: b.from_pub_key, tp: b.to_pub_key, cg: b.circle_genesis_id,
      at: b.asset_type, au: b.asset_unit, an: b.asset_name,
      am: b.amount, ra: b.remaining_amount,
      ir: b.interest_rate, it: b.interest_type,
      dd: b.due_date, gd: b.grace_days,
      k: b.keterangan, g: b.guarantor_pub_key, px: b.parent_tx_id,
      pk: b.pub_key, sig: b.signature, lc: b.logical_clock, ph: b.prev_hash
    };
    // omit nulls to save bytes
    Object.keys(c).forEach(function(k){ if (c[k] === null || c[k] === undefined) delete c[k]; });
    return c;
  }

  function decompress(c) {
    return {
      id: c.i, waktu: c.w, type: c.t, status: c.st,
      from_pub_key: c.fp, to_pub_key: c.tp, circle_genesis_id: c.cg,
      asset_type: c.at, asset_unit: c.au, asset_name: c.an || null,
      amount: c.am, remaining_amount: c.ra,
      interest_rate: c.ir || 0, interest_type: c.it || 'SIMPLE',
      due_date: c.dd || null, grace_days: c.gd || 0,
      keterangan: c.k || '', guarantor_pub_key: c.g || null,
      parent_tx_id: c.px || null,
      pub_key: c.pk, signature: c.sig, logical_clock: c.lc, prev_hash: c.ph || 'GENESIS'
    };
  }

  function compressArray(arr, senderMeta) {
    var out = [];
    if (senderMeta) {
      // Support both key forms:
      //   getSyncState() form: { pub_key, name, circle_name, genesis_id }
      //   inline form:        { sender, name, circle }
      out.push({
        _meta: true,
        sn: senderMeta.name || '',
        sp: senderMeta.pub_key || senderMeta.sender || '',
        cn: senderMeta.circle_name || senderMeta.circle || '',
        gi: senderMeta.genesis_id || senderMeta.circle || ''
      });
    }
    for (var i = 0; i < arr.length; i++) out.push(compress(arr[i]));
    return out;
  }

  function isCompressed(obj) {
    return obj && typeof obj.i === 'string' && typeof obj.w === 'number' && obj.fp;
  }

  function parseIncoming(data) {
    if (!Array.isArray(data)) return { bills: [], meta: null };
    if (!data.length) return { bills: [], meta: null };

    var meta = null;
    var items = data;
    if (data[0] && data[0]._meta === true) {
      meta = { sender_name: data[0].sn, sender_pub_key: data[0].sp, circle_name: data[0].cn, genesis_id: data[0].gi };
      items = data.slice(1);
    }

    var bills = items.map(function(item){ return isCompressed(item) ? decompress(item) : item; });
    return { bills: bills, meta: meta };
  }

  // spot-check integrity on random sample
  async function verifyIntegrity(bills) {
    var bad = [];
    var toCheck = bills.length <= 10 ? bills.slice() : [];
    if (bills.length > 10) {
      var indices = new Set();
      while (indices.size < 10) indices.add(Math.floor(Math.random() * bills.length));
      indices.forEach(function(idx){ toCheck.push(bills[idx]); });
    }
    for (var i = 0; i < toCheck.length; i++) {
      var b = toCheck[i];
      var valid = false;
      try { valid = await BGCrypto.verify(b.pub_key, BGNote.canonicalize(b), b.signature); } catch(e){}
      if (!valid) bad.push(b);
    }
    return { valid: bad.length === 0, corrupted: bad };
  }

  return {
    validateBill: validateBill,
    verifyChain: verifyChain,
    merge: merge,
    compress: compress,
    decompress: decompress,
    compressArray: compressArray,
    parseIncoming: parseIncoming,
    verifyIntegrity: verifyIntegrity,
    computeBillHash: computeBillHash
  };

})();
