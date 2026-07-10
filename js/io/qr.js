// ============================================================
// BUKUGEMBOK - QR CODE MODULE
// Uses qrcode-generator (proven, MIT) + jsQR fallback scanner
// ============================================================

var BGQR = (function () {

  var scanStream = null;
  var scanTimer = null;
  var scanActive = false;
  var scanCooldown = false;
  var scanCanvas = null;
  var scanCtx = null;

  // --- QR Generation ---

  function generateToCanvas(text, canvasEl, size) {
    size = size || 280;
    try {
      var qr = qrcode(0, 'L');
      qr.addData(text);
      qr.make();

      var moduleCount = qr.getModuleCount();
      var cellSize = Math.floor(size / moduleCount);
      var actualSize = cellSize * moduleCount;

      canvasEl.width = actualSize;
      canvasEl.height = actualSize;

      var ctx = canvasEl.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, actualSize, actualSize);

      ctx.fillStyle = '#000000';
      for (var r = 0; r < moduleCount; r++) {
        for (var c = 0; c < moduleCount; c++) {
          if (qr.isDark(r, c)) {
            ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
          }
        }
      }
      return true;
    } catch (e) {
      console.error('QR generate error:', e);
      return false;
    }
  }

  // --- Scanner Detection ---

  function hasBarcodeDetector() {
    return typeof BarcodeDetector !== 'undefined';
  }

  function hasJsQR() {
    return typeof jsQR === 'function';
  }

  function hasCameraSupport() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function canScan() {
    return hasCameraSupport() && (hasBarcodeDetector() || hasJsQR());
  }

  // --- Scan Start ---

  async function startScan(videoEl, onResult, onError) {
    if (scanActive) return;

    if (!hasCameraSupport()) {
      if (onError) onError('camera_unsupported');
      return;
    }

    if (!hasBarcodeDetector() && !hasJsQR()) {
      if (onError) onError('barcode_unsupported');
      return;
    }

    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 640 } }
      });
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        if (onError) onError('camera_denied');
      } else {
        if (onError) onError('camera_error');
      }
      return;
    }

    videoEl.srcObject = scanStream;
    scanActive = true;

    // Prepare offscreen canvas for jsQR fallback
    if (!hasBarcodeDetector() && hasJsQR()) {
      scanCanvas = document.createElement('canvas');
      scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
    }

    if (hasBarcodeDetector()) {
      scanWithBarcodeDetector(videoEl, onResult);
    } else {
      scanWithJsQR(videoEl, onResult);
    }
  }

  // --- Native BarcodeDetector path ---

  function scanWithBarcodeDetector(videoEl, onResult) {
    var detector = new BarcodeDetector({ formats: ['qr_code'] });
    var frameCount = 0;

    function tick() {
      if (!scanActive) return;
      frameCount++;
      if (frameCount % 3 !== 0) { scanTimer = requestAnimationFrame(tick); return; }
      if (videoEl.readyState < 2) { scanTimer = requestAnimationFrame(tick); return; }

      detector.detect(videoEl).then(function (barcodes) {
        if (!scanActive) return;
        if (barcodes.length > 0 && !scanCooldown) {
          var value = barcodes[0].rawValue;
          if (value && onResult) {
            onResult(value);
            scanCooldown = true;
            setTimeout(function () { scanCooldown = false; }, 500);
          }
        }
        if (scanActive) scanTimer = requestAnimationFrame(tick);
      }).catch(function () {
        if (scanActive) scanTimer = requestAnimationFrame(tick);
      });
    }

    scanTimer = requestAnimationFrame(tick);
  }

  // --- jsQR fallback path ---

  function scanWithJsQR(videoEl, onResult) {
    var frameCount = 0;

    function tick() {
      if (!scanActive) return;
      frameCount++;
      // jsQR is heavier, scan every 5th frame
      if (frameCount % 5 !== 0) { scanTimer = requestAnimationFrame(tick); return; }
      if (videoEl.readyState < 2) { scanTimer = requestAnimationFrame(tick); return; }

      var w = videoEl.videoWidth;
      var h = videoEl.videoHeight;
      if (w === 0 || h === 0) { scanTimer = requestAnimationFrame(tick); return; }

      scanCanvas.width = w;
      scanCanvas.height = h;
      scanCtx.drawImage(videoEl, 0, 0, w, h);

      var imageData = scanCtx.getImageData(0, 0, w, h);
      var code = jsQR(imageData.data, w, h, { inversionAttempts: 'dontInvert' });

      if (code && code.data && !scanCooldown) {
        onResult(code.data);
        scanCooldown = true;
        setTimeout(function () { scanCooldown = false; }, 500);
      }

      if (scanActive) scanTimer = requestAnimationFrame(tick);
    }

    scanTimer = requestAnimationFrame(tick);
  }

  // --- Scan Stop ---

  function stopScan() {
    scanActive = false;
    scanCooldown = false;
    if (scanTimer) { cancelAnimationFrame(scanTimer); scanTimer = null; }
    if (scanStream) {
      scanStream.getTracks().forEach(function (t) { t.stop(); });
      scanStream = null;
    }
    scanCanvas = null;
    scanCtx = null;
  }

  function setZoom(videoEl, level) {
    if (!scanStream) return;
    var track = scanStream.getVideoTracks()[0];
    if (!track) return;
    var caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.zoom) {
      var min = caps.zoom.min || 1;
      var max = caps.zoom.max || 5;
      var val = Math.min(max, Math.max(min, parseFloat(level)));
      track.applyConstraints({ advanced: [{ zoom: val }] }).catch(function () {});
    }
  }

  function isActive() { return scanActive; }

  return {
    generateToCanvas: generateToCanvas,
    startScan: startScan,
    stopScan: stopScan,
    setZoom: setZoom,
    isActive: isActive,
    canScan: canScan,
    hasBarcodeDetector: hasBarcodeDetector,
    hasJsQR: hasJsQR,
    hasCameraSupport: hasCameraSupport
  };

})();
