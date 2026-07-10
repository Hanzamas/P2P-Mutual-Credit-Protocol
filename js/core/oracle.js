// ============================================================
// MEFOBILLS - ORACLE MODULE
// Commodity price injection + gossip (admin-signed price feed)
// ============================================================

var BGOracle = (function () {

  var PRICE_TTL_MS = 24 * 60 * 60 * 1000; // prices stale after 24h
  var MAX_PRICES = 100;

  // Admin injects price: signs it with their private key
  async function injectPrice(asset_unit, asset_name, price_amount, price_currency, adminPrivKey, adminPubKey) {
    var entry = {
      id: BGCrypto.uuid(),
      waktu: Date.now(),
      asset_unit: asset_unit.toUpperCase(),
      asset_name: (asset_name || '').trim(),
      price_amount: price_amount,     // e.g. 15000
      price_currency: price_currency || 'IDR', // IDR / USD etc
      injector_pub_key: adminPubKey,
      signature: ''
    };

    var canonical = [entry.id, entry.waktu, entry.asset_unit, entry.asset_name, entry.price_amount, entry.price_currency, entry.injector_pub_key].join('|');
    entry.signature = await BGCrypto.signCanonical(adminPrivKey, canonical);

    // store in konfigurasi as JSON array
    var existing = await getStoredPrices();
    existing.push(entry);
    // keep only most recent MAX_PRICES entries per asset
    if (existing.length > MAX_PRICES) existing = existing.slice(-MAX_PRICES);
    await BGDB.setConfig('oracle_prices', existing);

    return entry;
  }

  // Receive price from peer (gossip) — verify before storing
  async function receivePriceFromPeer(entry) {
    if (!entry || !entry.signature || !entry.injector_pub_key) return false;

    var canonical = [entry.id, entry.waktu, entry.asset_unit, entry.asset_name, entry.price_amount, entry.price_currency, entry.injector_pub_key].join('|');
    try {
      var valid = await BGCrypto.verifyCanonical(entry.injector_pub_key, canonical, entry.signature);
      if (!valid) return false;
    } catch (e) {
      return false;
    }

    // check not too old
    if (Date.now() - entry.waktu > PRICE_TTL_MS * 2) return false;

    var existing = await getStoredPrices();
    // avoid duplicates
    var ids = existing.map(function(e){ return e.id; });
    if (ids.indexOf(entry.id) !== -1) return true; // already have it

    existing.push(entry);
    if (existing.length > MAX_PRICES) existing = existing.slice(-MAX_PRICES);
    await BGDB.setConfig('oracle_prices', existing);
    return true;
  }

  async function getStoredPrices() {
    var raw = await BGDB.getConfig('oracle_prices');
    return Array.isArray(raw) ? raw : [];
  }

  // Get latest valid price for asset_unit + asset_name
  async function getPrice(asset_unit, asset_name) {
    var prices = await getStoredPrices();
    var now = Date.now();
    var au = (asset_unit || '').toUpperCase();
    var an = (asset_name || '').trim();

    // filter matching + not stale, sort newest first
    var matching = prices.filter(function(p){
      return p.asset_unit === au && p.asset_name === an && (now - p.waktu) < PRICE_TTL_MS;
    }).sort(function(a,b){ return b.waktu - a.waktu; });

    return matching.length ? matching[0] : null;
  }

  // Format price for display on bill: "10 KG Beras ≈ Rp 150.000 (harga 08:00)"
  async function getEquivalentLabel(bill) {
    if (bill.asset_type !== 'COMMODITY') return null;
    var price = await getPrice(bill.asset_unit, bill.asset_name);
    if (!price) return null;

    var total_value = bill.remaining_amount * price.price_amount;
    var timeStr = new Date(price.waktu).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    var currency = price.price_currency || 'IDR';
    var formatted = total_value.toLocaleString('id-ID');
    return bill.remaining_amount + ' ' + bill.asset_unit + ' ' + bill.asset_name + ' \u2248 ' + currency + ' ' + formatted + ' (harga ' + timeStr + ')';
  }

  // all prices for gossip broadcast
  async function getAllForBroadcast() {
    var prices = await getStoredPrices();
    var now = Date.now();
    return prices.filter(function(p){ return (now - p.waktu) < PRICE_TTL_MS; });
  }

  return {
    injectPrice: injectPrice,
    receivePriceFromPeer: receivePriceFromPeer,
    getPrice: getPrice,
    getEquivalentLabel: getEquivalentLabel,
    getAllForBroadcast: getAllForBroadcast
  };

})();
