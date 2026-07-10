// ============================================================
// MEFOBILLS - DATABASE MODULE (IndexedDB)
// Stores: bills, netting_log, circles, warga_peers, konfigurasi
// ============================================================

var BGDB = (function () {

  var DB_NAME = 'MefoBillsDB';
  var DB_VERSION = 2;
  var db = null;

  function open() {
    return new Promise(function (resolve, reject) {
      if (db) { resolve(db); return; }

      try {
        var req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = function (e) {
          var d = e.target.result;
          var oldVersion = e.oldVersion;

          // bills: main ledger of promissory notes
          if (!d.objectStoreNames.contains('bills')) {
            var bills = d.createObjectStore('bills', { keyPath: 'id' });
            bills.createIndex('waktu', 'waktu', { unique: false });
            bills.createIndex('from_pub_key', 'from_pub_key', { unique: false });
            bills.createIndex('to_pub_key', 'to_pub_key', { unique: false });
            bills.createIndex('status', 'status', { unique: false });
            bills.createIndex('asset_unit', 'asset_unit', { unique: false });
            bills.createIndex('circle_genesis_id', 'circle_genesis_id', { unique: false });
          }

          // netting_log: record of each clearing cycle executed
          if (!d.objectStoreNames.contains('netting_log')) {
            var nl = d.createObjectStore('netting_log', { keyPath: 'id' });
            nl.createIndex('waktu', 'waktu', { unique: false });
          }

          // circles: joined community circles
          if (!d.objectStoreNames.contains('circles')) {
            d.createObjectStore('circles', { keyPath: 'genesis_id' });
          }

          // warga_peers: known counterparties
          if (!d.objectStoreNames.contains('warga_peers')) {
            d.createObjectStore('warga_peers', { keyPath: 'pub_key' });
          }

          // konfigurasi: app config key-value
          if (!d.objectStoreNames.contains('konfigurasi')) {
            d.createObjectStore('konfigurasi', { keyPath: 'key' });
          }
        };

        req.onsuccess = function (e) {
          db = e.target.result;
          db.onclose = function () { db = null; };
          resolve(db);
        };

        req.onerror = function (e) {
          reject(new Error('Gagal membuka database: ' + (e.target.error ? e.target.error.message : 'unknown')));
        };

        req.onblocked = function () {
          reject(new Error('Database diblokir. Tutup tab MefoBills lain dan coba lagi.'));
        };
      } catch (e) {
        reject(new Error('Penyimpanan tidak tersedia. Pastikan tidak dalam mode Incognito/Private.'));
      }
    });
  }

  function getStore(storeName, mode) {
    var t = db.transaction(storeName, mode);
    return t.objectStore(storeName);
  }

  function reqP(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function txComplete(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = resolve;
      transaction.onerror = function () {
        var err = transaction.error;
        reject(err && err.name === 'QuotaExceededError' ? new Error('QUOTA_EXCEEDED') : err);
      };
      transaction.onabort = function () {
        var err = transaction.error;
        reject(err && err.name === 'QuotaExceededError' ? new Error('QUOTA_EXCEEDED') : new Error('Transaksi database dibatalkan.'));
      };
    });
  }

  // --- bills ---

  async function saveBill(data) {
    await open();
    var store = getStore('bills', 'readwrite');
    store.put(data);
    return txComplete(store.transaction);
  }

  async function saveBulkBills(arr) {
    if (!arr.length) return;
    await open();
    var t = db.transaction('bills', 'readwrite');
    var store = t.objectStore('bills');
    for (var i = 0; i < arr.length; i++) store.put(arr[i]);
    return txComplete(t);
  }

  async function getAllBills() {
    await open();
    return reqP(getStore('bills', 'readonly').getAll());
  }

  async function getBillById(id) {
    await open();
    return reqP(getStore('bills', 'readonly').get(id));
  }

  async function getBillIds() {
    await open();
    var keys = await reqP(getStore('bills', 'readonly').getAllKeys());
    return new Set(keys);
  }

  async function getBillCount() {
    await open();
    return reqP(getStore('bills', 'readonly').count());
  }

  // bills involving a specific pub_key (as debtor OR creditor)
  async function getBillsByParty(pub_key) {
    await open();
    var all = await getAllBills();
    return all.filter(function (b) {
      return b.from_pub_key === pub_key || b.to_pub_key === pub_key;
    });
  }

  // active bills between two specific parties
  async function getBillsBetween(pub_key_a, pub_key_b) {
    await open();
    var all = await getAllBills();
    return all.filter(function (b) {
      return (b.from_pub_key === pub_key_a && b.to_pub_key === pub_key_b) ||
             (b.from_pub_key === pub_key_b && b.to_pub_key === pub_key_a);
    });
  }

  async function getBillsByStatus(status) {
    await open();
    return reqP(getStore('bills', 'readonly').index('status').getAll(status));
  }

  async function getBillsByCircle(genesis_id) {
    await open();
    return reqP(getStore('bills', 'readonly').index('circle_genesis_id').getAll(genesis_id));
  }

  async function updateBillStatus(id, status, extra) {
    await open();
    var bill = await getBillById(id);
    if (!bill) throw new Error('Bill tidak ditemukan: ' + id);
    bill.status = status;
    if (extra) Object.assign(bill, extra);
    var store = getStore('bills', 'readwrite');
    store.put(bill);
    return txComplete(store.transaction);
  }

  // --- netting_log ---

  async function saveNettingLog(entry) {
    await open();
    var store = getStore('netting_log', 'readwrite');
    store.put(entry);
    return txComplete(store.transaction);
  }

  async function getAllNettingLogs() {
    await open();
    return reqP(getStore('netting_log', 'readonly').getAll());
  }

  // --- circles ---

  async function saveCircle(circle) {
    await open();
    var store = getStore('circles', 'readwrite');
    store.put(circle);
    return txComplete(store.transaction);
  }

  async function getAllCircles() {
    await open();
    return reqP(getStore('circles', 'readonly').getAll());
  }

  async function getCircle(genesis_id) {
    await open();
    return reqP(getStore('circles', 'readonly').get(genesis_id));
  }

  // --- konfigurasi ---

  async function setConfig(key, value) {
    await open();
    var store = getStore('konfigurasi', 'readwrite');
    store.put({ key: key, value: value });
    return txComplete(store.transaction);
  }

  async function getConfig(key) {
    await open();
    var result = await reqP(getStore('konfigurasi', 'readonly').get(key));
    return result ? result.value : null;
  }

  // --- warga_peers ---

  async function savePeer(data) {
    await open();
    var store = getStore('warga_peers', 'readwrite');
    store.put(data);
    return txComplete(store.transaction);
  }

  async function getAllPeers() {
    await open();
    return reqP(getStore('warga_peers', 'readonly').getAll());
  }

  async function getPeer(pubKey) {
    await open();
    return reqP(getStore('warga_peers', 'readonly').get(pubKey));
  }

  // --- Storage ---

  async function getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      return navigator.storage.estimate();
    }
    return { usage: 0, quota: 0 };
  }

  async function requestPersist() {
    if (navigator.storage && navigator.storage.persist) {
      return navigator.storage.persist();
    }
    return false;
  }

  // --- Delete all data (reset) ---
  // Clears all object stores and closes the DB so it can be re-opened fresh.
  async function deleteAllData() {
    await open();
    var stores = ['bills', 'netting_log', 'circles', 'warga_peers', 'konfigurasi'];
    var t = db.transaction(stores, 'readwrite');
    stores.forEach(function(s) { t.objectStore(s).clear(); });
    await txComplete(t);
    db.close();
    db = null;
  }

  return {
    open: open,
    // bills
    saveBill: saveBill,
    saveBulkBills: saveBulkBills,
    getAllBills: getAllBills,
    getBillById: getBillById,
    getBillIds: getBillIds,
    getBillCount: getBillCount,
    getBillsByParty: getBillsByParty,
    getBillsBetween: getBillsBetween,
    getBillsByStatus: getBillsByStatus,
    getBillsByCircle: getBillsByCircle,
    updateBillStatus: updateBillStatus,
    // netting
    saveNettingLog: saveNettingLog,
    getAllNettingLogs: getAllNettingLogs,
    // circles
    saveCircle: saveCircle,
    getAllCircles: getAllCircles,
    getCircle: getCircle,
    // config
    setConfig: setConfig,
    getConfig: getConfig,
    // peers
    savePeer: savePeer,
    getAllPeers: getAllPeers,
    getPeer: getPeer,
    // storage
    getStorageEstimate: getStorageEstimate,
    requestPersist: requestPersist,
    // reset
    deleteAllData: deleteAllData
  };

})();
