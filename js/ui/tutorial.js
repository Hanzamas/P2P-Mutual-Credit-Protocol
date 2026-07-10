// ============================================================
// MEFOBILLS - TUTORIAL SYSTEM
// Context-aware first-use tooltips per screen
// Plain Bahasa Indonesia — designed for non-tech users
// ============================================================

var BGTutorial = (function () {

  var queue = [];
  var index = 0;
  var seen = {};

  // All tutorials keyed by screen ID
  // Language: plain, friendly, zero jargon
  var TUTORIALS = {
    'screen-home': [
      { text: 'Selamat datang! Halaman ini menampilkan semua hutang dan piutang kamu.\n🟢 Hijau = orang lain hutang ke kamu.\n🔴 Merah = kamu yang hutang.' },
      { text: 'Ketuk tombol besar "Buat Kasbon" untuk membuat surat hutang baru. Orang lain tinggal scan QR-nya.' }
    ],
    'screen-buat-nota': [
      { text: 'Pilih jenis: "Uang" untuk Rupiah/Dollar, atau "Barang" untuk beras, pupuk, dll.' },
      { text: 'Isi jumlah dan keterangan singkat. Bunga kosongkan kalau tidak pakai bunga.' },
      { text: 'Setelah tekan Buat, akan muncul QR Code. Minta orang yang berhutang untuk scan.' }
    ],
    'screen-scan': [
      { text: 'Arahkan kamera ke QR Code yang ditampilkan orang lain.\nApp akan membaca nota otomatis.' }
    ],
    'screen-buku-saku': [
      { text: 'Di sini hanya nota yang melibatkan KAMU — sebagai pemberi atau penerima hutang.' },
      { text: 'Ketuk sebuah nota untuk lihat detail, lunasi, atau oper ke orang lain.' }
    ],
    'screen-buku-besar': [
      { text: 'Buku Besar menampilkan SEMUA transaksi dalam kelompok ini — bisa dilihat semua anggota.\nIni untuk transparansi bersama.' }
    ],
    'screen-hapus-silang': [
      { text: 'Hapus Silang Otomatis artinya: kalau Kamu hutang ke A, A hutang ke B, dan B hutang ke Kamu — utang kalian bisa saling terhapus otomatis tanpa bayar uang!' }
    ],
    'screen-peers': [
      { text: 'Daftar semua anggota kelompok yang sudah pernah bertukar nota dengan kamu.' },
      { text: '🟢 = reputasi bagus (sering lunasi). 🟡 = sedang. 🔴 = sering macet.' }
    ],
    'screen-settings': [
      { text: 'PENTING: Backup Kunci = satu-satunya cara pulihkan akunmu kalau HP hilang atau rusak.\nLakukan sekarang dan simpan file-nya baik-baik.' }
    ],
    'screen-circle': [
      { text: 'Kelompok (Sirkel) adalah ruang komunitas kamu.\nSatu kelompok bisa berisi keluarga, teman RT, atau warga desa.' },
      { text: 'Bagikan QR Undangan ke anggota baru. Mereka tinggal scan sekali dan langsung masuk kelompok.' }
    ]
  };

  async function load() {
    var raw = await BGDB.getConfig('seen_tutorials');
    if (raw) seen = raw;
  }

  async function save() {
    await BGDB.setConfig('seen_tutorials', seen);
  }

  function showForScreen(screenId) {
    if (seen[screenId]) return;
    var steps = TUTORIALS[screenId];
    if (!steps || !steps.length) return;
    seen[screenId] = true;
    save();
    queue = steps;
    index = 0;
    showStep();
  }

  function showStep() {
    if (index >= queue.length) { dismiss(); return; }
    var step = queue[index];
    var backdrop = document.getElementById('tutorial-backdrop');
    var tip = document.getElementById('tutorial-tip');
    var tipText = document.getElementById('tutorial-tip-text');
    var tipBtn = document.getElementById('tutorial-btn');
    var tipCounter = document.getElementById('tutorial-counter');

    if (!backdrop || !tip) return;

    if (tipText) tipText.textContent = step.text;
    if (tipCounter) tipCounter.textContent = (index + 1) + ' / ' + queue.length;
    if (tipBtn) tipBtn.textContent = index < queue.length - 1 ? 'Lanjut \u2192' : 'Mengerti!';

    backdrop.classList.add('show');
    tip.classList.add('show');
  }

  function next() {
    index++;
    showStep();
  }

  function dismiss() {
    queue = [];
    index = 0;
    var backdrop = document.getElementById('tutorial-backdrop');
    var tip = document.getElementById('tutorial-tip');
    if (backdrop) backdrop.classList.remove('show');
    if (tip) tip.classList.remove('show');
  }

  function reset() {
    seen = {};
    BGDB.setConfig('seen_tutorials', {});
    BGUI.showToast('Tutorial diatur ulang. Akan muncul lagi di setiap halaman.', 'info');
  }

  return {
    load: load,
    showForScreen: showForScreen,
    next: next,
    dismiss: dismiss,
    reset: reset
  };

})();
