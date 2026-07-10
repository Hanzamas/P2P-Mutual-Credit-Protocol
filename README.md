# Nota Kita  P2P Mutual Credit Protocol

Kasbon digital untuk komunitas. Offline-first, tanpa server, tanpa bank.

## Apa ini

Nota Kita adalah sistem utang-piutang terdesentralisasi untuk kelompok kecil (koperasi, arisan, komunitas tani, warung, dll). Tidak ada server pusat. Data tersimpan di device masing-masing anggota. Sinkronisasi via QR code, Wi-Fi lokal, atau file share  tidak perlu internet.

Intinya: IOU digital yang bisa diverifikasi secara kriptografis tanpa pihak ketiga.

## Cara kerja

Setiap anggota punya keypair secp256k1. Setiap nota (bill) ditandatangani oleh pembuatnya. Tidak bisa dipalsukan.

```
Kreditur buat nota → QR → Debitur scan & konfirmasi → Nota aktif
Debitur lunasi → QR → Kreditur konfirmasi → Settled
```

Nota bisa dipecah (endorse) ke anggota lain. Jika ada utang siklus (A→B→C→A), sistem otomatis hapus silang (multilateral netting) tanpa uang tunai berpindah.

## Stack

Semua vanilla  tidak ada framework, tidak ada server, tidak ada cloud.

| Layer | Tech |
|-------|------|
| Crypto | noble-secp256k1 (Schnorr signatures) |
| Storage | IndexedDB |
| P2P sync | Trystero over Nostr relays (WebRTC) |
| QR large data | Fountain code (animated QR sequence) |
| Offline | Service Worker, PWA |
| Auth | PIN + WebAuthn/Passkey (PRF extension) |

## Struktur

```
js/
  core/        # Logic murni, zero DOM
    crypto.js  # Keypair, sign, verify, sha256
    note.js    # Bill lifecycle (create, accept, settle)
    endorse.js # Split/transfer bill ke pihak ketiga
    netting.js # Multilateral clearing (DFS cycle detection)
    interest.js# Simple & compound accrual
    merge.js   # CRDT-style merge + signature verification
    db.js      # IndexedDB wrapper
    circle.js  # Group genesis block
    oracle.js  # Commodity price feed (gossip)
    reputation.js # Peer score dari history
  io/
    qr.js      # Generate + scan QR (BarcodeDetector / jsQR fallback)
    fountain.js# Chunked animated QR untuk data besar
    rtc.js     # WebRTC P2P sync via Trystero
    backup.js  # Encrypted key export/import (AES-256-GCM)
    share.js   # Web Share API + file fallback
  ui/
    ui.js      # Toast, modal, format helpers
    render/    # Renderers per screen
app.js         # Orchestrator  state + event handlers
app.html       # Single HTML file, semua screen ada di sini
sw.js          # Service Worker
```

## Setup

Tidak ada build step. Buka langsung atau serve:

```bash
python -m http.server 8080
# buka http://localhost:8080/app.html
```

Untuk install sebagai PWA: Chrome/Edge mobile → "Add to Home Screen".

## Sync antar device

Tiga mode, tidak perlu internet kecuali mode pertama:

1. **WebRTC**  otomatis via Nostr relay jika online
2. **QR Fountain**  animasi QR sequence, cocok offline total
3. **File share**  ekspor `.json`, kirim via WhatsApp/Bluetooth, import di device lain

## Keamanan

- Private key tidak pernah keluar dari device kecuali diekspor manual dengan password
- Export dienkripsi AES-256-GCM, PBKDF2 100k iterasi
- Semua nota diverifikasi signature sebelum disimpan  forgery langsung ditolak
- Passkey/WebAuthn PRF dipakai sebagai key derivation untuk enkripsi identitas

## Limitasi

- Belum ada conflict resolution untuk simultaneous offline edit pada bill yang sama
- Netting deduplication bisa miss beberapa cycle jika node set overlap (DFS suboptimal)
- Tidak ada revocation  jika private key bocor, mitigasinya cuma reset + key baru

## License

MIT
