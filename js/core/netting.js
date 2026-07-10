// ============================================================
// MEFOBILLS - NETTING ENGINE
// DFS cycle detection + multilateral clearing
// Fungibility rule: only net bills with same asset_type + asset_unit + asset_name
// ============================================================

var BGNetting = (function () {

  // Build adjacency graph from active bills.
  // Returns: { assetKey -> { from_pub_key -> [{ to, amount, bill_id }] } }
  // Separate graph per asset class (IDR graph, KG_Beras graph, etc.)
  function buildGraphs(bills) {
    var graphs = {};

    for (var i = 0; i < bills.length; i++) {
      var b = bills[i];
      if (b.status !== 'ACTIVE') continue;
      if (b.remaining_amount <= 0) continue;

      // fungibility key
      var key = b.asset_type + ':' + b.asset_unit + ':' + (b.asset_name || '');

      if (!graphs[key]) graphs[key] = {};
      var g = graphs[key];

      if (!g[b.from_pub_key]) g[b.from_pub_key] = [];
      g[b.from_pub_key].push({
        to: b.to_pub_key,
        amount: b.remaining_amount,
        bill_id: b.id
      });
    }

    return graphs;
  }

  // DFS cycle detection on a single asset graph.
  // Returns array of cycles: [{ path: [pub_keys], edges: [{from, to, bill_id, amount}] }]
  function findCycles(graph) {
    var cycles = [];
    var nodes = Object.keys(graph);

    for (var s = 0; s < nodes.length; s++) {
      var start = nodes[s];
      var visited = {};
      var path = [];
      var edgePath = [];

      dfs(graph, start, start, visited, path, edgePath, cycles);
    }

    // deduplicate cycles (same set of nodes, different start)
    return deduplicateCycles(cycles);
  }

  function dfs(graph, start, current, visited, path, edgePath, cycles) {
    if (!graph[current]) return;
    var edges = graph[current];

    for (var i = 0; i < edges.length; i++) {
      var edge = edges[i];
      var next = edge.to;

      if (next === start && path.length >= 2) {
        // cycle found
        var fullEdgePath = edgePath.concat([{ from: current, to: next, bill_id: edge.bill_id, amount: edge.amount }]);
        var fullPath = path.concat([next]);
        cycles.push({ path: fullPath, edges: fullEdgePath });
        continue;
      }

      if (visited[next]) continue;

      visited[next] = true;
      path.push(next);
      edgePath.push({ from: current, to: next, bill_id: edge.bill_id, amount: edge.amount });

      dfs(graph, start, next, visited, path, edgePath, cycles);

      path.pop();
      edgePath.pop();
      delete visited[next];
    }
  }

  function deduplicateCycles(cycles) {
    var seen = new Set();
    var unique = [];
    for (var i = 0; i < cycles.length; i++) {
      var key = cycles[i].path.slice().sort().join(',');
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(cycles[i]);
      }
    }
    return unique;
  }

  // Execute clearing for one cycle.
  // Reduces all edges by bottleneck (min amount in cycle).
  // Returns { cleared_amount, asset_key, affected_bill_ids, participants }
  async function executeCycle(cycle, asset_key) {
    // find bottleneck
    var bottleneck = Infinity;
    for (var i = 0; i < cycle.edges.length; i++) {
      if (cycle.edges[i].amount < bottleneck) bottleneck = cycle.edges[i].amount;
    }
    if (bottleneck <= 0 || !isFinite(bottleneck)) return null;

    var affected = [];

    for (var j = 0; j < cycle.edges.length; j++) {
      var edge = cycle.edges[j];
      var bill = await BGDB.getBillById(edge.bill_id);
      if (!bill || bill.status !== 'ACTIVE') continue;

      bill.remaining_amount = Math.round((bill.remaining_amount - bottleneck) * 1e10) / 1e10;

      if (bill.remaining_amount <= 0) {
        bill.remaining_amount = 0;
        bill.status = 'SETTLED';
        bill.settled_at = Date.now();
        bill.settlement_method = 'NETTING';
      }

      await BGDB.saveBill(bill);
      affected.push(bill.id);
    }

    // log this netting event
    var parts = [...new Set(cycle.path)];
    var logEntry = {
      id: BGCrypto.uuid(),
      waktu: Date.now(),
      asset_key: asset_key,
      cleared_amount: bottleneck,
      participants: parts,
      affected_bill_ids: affected,
      cycle_path: cycle.path
    };
    await BGDB.saveNettingLog(logEntry);

    return {
      cleared_amount: bottleneck,
      asset_key: asset_key,
      affected_bill_ids: affected,
      participants: parts
    };
  }

  // Run full netting pass: build graphs, find cycles, execute all.
  // Non-blocking: yields between cycles via Promise.resolve()
  // Returns summary of all clearings.
  async function runNetting(bills) {
    var graphs = buildGraphs(bills);
    var results = [];

    var assetKeys = Object.keys(graphs);
    for (var a = 0; a < assetKeys.length; a++) {
      var key = assetKeys[a];
      var cycles = findCycles(graphs[key]);

      for (var c = 0; c < cycles.length; c++) {
        await Promise.resolve(); // yield to main thread between cycles
        var result = await executeCycle(cycles[c], key);
        if (result) results.push(result);
      }
    }

    return results; // [] if nothing cleared, otherwise array of clearings
  }

  // Net balance between two specific parties for one asset_key
  function bilateralBalance(bills, pub_key_a, pub_key_b, asset_key) {
    var netAB = 0; // positive = A owes B, negative = B owes A
    for (var i = 0; i < bills.length; i++) {
      var b = bills[i];
      if (b.status !== 'ACTIVE') continue;
      var bKey = b.asset_type + ':' + b.asset_unit + ':' + (b.asset_name || '');
      if (bKey !== asset_key) continue;
      if (b.from_pub_key === pub_key_a && b.to_pub_key === pub_key_b) netAB += b.remaining_amount;
      if (b.from_pub_key === pub_key_b && b.to_pub_key === pub_key_a) netAB -= b.remaining_amount;
    }
    return netAB;
  }

  // Summarize net positions per counterparty for dashboard
  // Returns: [{ counterparty_pub_key, asset_key, net_amount, direction: 'OWE'|'OWED' }]
  function netPositions(bills, my_pub_key) {
    var positions = {};

    for (var i = 0; i < bills.length; i++) {
      var b = bills[i];
      if (b.status !== 'ACTIVE') continue;
      if (b.from_pub_key !== my_pub_key && b.to_pub_key !== my_pub_key) continue;

      var counterparty = b.from_pub_key === my_pub_key ? b.to_pub_key : b.from_pub_key;
      var asset_key = b.asset_type + ':' + b.asset_unit + ':' + (b.asset_name || '');
      var posKey = counterparty + '|' + asset_key;

      if (!positions[posKey]) {
        positions[posKey] = { counterparty_pub_key: counterparty, asset_key: asset_key, net: 0 };
      }

      // positive net = I owe them, negative = they owe me
      if (b.from_pub_key === my_pub_key) {
        positions[posKey].net += b.remaining_amount;
      } else {
        positions[posKey].net -= b.remaining_amount;
      }
    }

    return Object.values(positions).map(function(p) {
      return {
        counterparty_pub_key: p.counterparty_pub_key,
        asset_key: p.asset_key,
        net_amount: Math.abs(p.net),
        direction: p.net > 0 ? 'OWE' : 'OWED',
        raw_net: p.net
      };
    }).filter(function(p){ return p.net_amount > 0; });
  }

  return {
    buildGraphs: buildGraphs,
    findCycles: findCycles,
    runNetting: runNetting,
    bilateralBalance: bilateralBalance,
    netPositions: netPositions
  };

})();
