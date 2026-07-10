// ============================================================
// BUKUGEMBOK - FOUNTAIN CODE MODULE
// Chunked animated QR for large datasets
// ============================================================

var BGFountain = (function () {

  var sendTimer = null;
  var receiveBuffer = {};
  var receiveTotalChunks = 0;
  var receiveCallback = null;
  var progressCallback = null;

  var CHUNK_MAX_BYTES = 1800; // Conservative limit for QR
  var FRAME_INTERVAL = 400;   // ms between QR frames

  function startSend(txArray, senderMeta, canvasEl, onStatus) {
    var compressed = BGMerge.compressArray(txArray, senderMeta);
    var json = JSON.stringify(compressed);
    var chunks = splitIntoChunks(json, CHUNK_MAX_BYTES);
    var totalChunks = chunks.length;
    var frameIdx = 0;

    if (onStatus) onStatus('0 / ' + totalChunks + ' bagian');

    function nextFrame() {
      var chunk = chunks[frameIdx % totalChunks];
      var packet = {
        _f: 1,                        // fountain flag
        _c: frameIdx % totalChunks,   // chunk index
        _t: totalChunks,              // total chunks
        _d: chunk                     // data
      };

      var packetJson = JSON.stringify(packet);
      BGQR.generateToCanvas(packetJson, canvasEl);

      frameIdx++;
      if (onStatus) onStatus((Math.min(frameIdx, totalChunks)) + ' / ' + totalChunks + ' bagian');

      sendTimer = setTimeout(nextFrame, FRAME_INTERVAL);
    }

    nextFrame();
  }

  function stopSend() {
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
  }

  function startReceive(onProgress, onComplete) {
    receiveBuffer = {};
    receiveTotalChunks = 0;
    progressCallback = onProgress;
    receiveCallback = onComplete;
  }

  function feedChunk(rawValue) {
    try {
      var packet = JSON.parse(rawValue);
      if (!packet._f) return false; // Not a fountain packet

      receiveTotalChunks = packet._t;
      receiveBuffer[packet._c] = packet._d;

      var received = Object.keys(receiveBuffer).length;

      if (progressCallback) progressCallback(received, receiveTotalChunks);

      if (received >= receiveTotalChunks) {
        // Reassemble
        var parts = [];
        for (var i = 0; i < receiveTotalChunks; i++) {
          if (!receiveBuffer[i]) return false; // Gap, wait
          parts.push(receiveBuffer[i]);
        }

        var fullJson = parts.join('');
        try {
          var data = JSON.parse(fullJson);
          if (receiveCallback) receiveCallback(data);
          resetReceive();
        } catch (e) {
          console.error('Fountain reassembly parse error:', e);
        }
      }

      return true;
    } catch (e) {
      return false;
    }
  }

  function resetReceive() {
    receiveBuffer = {};
    receiveTotalChunks = 0;
    receiveCallback = null;
    progressCallback = null;
  }

  function splitIntoChunks(str, maxBytes) {
    var chunks = [];
    var i = 0;
    while (i < str.length) {
      // Estimate: UTF-8 chars can be multi-byte, but JSON is ASCII-safe here
      var end = Math.min(i + maxBytes, str.length);
      chunks.push(str.substring(i, end));
      i = end;
    }
    return chunks;
  }

  return {
    startSend: startSend,
    stopSend: stopSend,
    startReceive: startReceive,
    feedChunk: feedChunk,
    resetReceive: resetReceive
  };

})();
