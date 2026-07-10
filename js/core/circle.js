// ============================================================
// MEFOBILLS - CIRCLE MODULE
// Genesis block creation, invite QR, join flow, member whitelist
// ============================================================

var BGCircle = (function () {

  // canonicalize genesis for signing (prevent field-swap attacks)
  function canonicalizeGenesis(g) {
    return [g.genesis_id, g.circle_name, g.founder_pub_key, g.created_at].join('|');
  }

  // FOUNDER: create new circle
  // returns genesis block (save to DB + show as invite QR)
  async function createCircle(circle_name, founderPrivKey, founderPubKey) {
    circle_name = (circle_name || '').trim();
    if (circle_name.length < 2) throw new Error('Nama sirkel minimal 2 huruf.');

    var genesis_id = BGCrypto.uuid();
    var created_at = Date.now();

    var genesis = {
      genesis_id: genesis_id,
      circle_name: circle_name,
      founder_pub_key: founderPubKey,
      created_at: created_at,
      signature: ''
    };

    // sign the genesis block so members can verify founder identity
    var canonical = canonicalizeGenesis(genesis);
    genesis.signature = await BGCrypto.signCanonical(founderPrivKey, canonical);

    await BGDB.saveCircle(genesis);

    // add self as known peer (founder)
    // peer record added by app.js after setup

    return genesis;
  }

  // MEMBER: join from invite QR payload
  // genesis_obj = parsed JSON from invite QR
  async function joinCircle(genesis_obj) {
    if (!genesis_obj || !genesis_obj.genesis_id || !genesis_obj.circle_name ||
        !genesis_obj.founder_pub_key || !genesis_obj.signature) {
      throw new Error('QR undangan tidak valid.');
    }

    // verify founder signature
    var canonical = canonicalizeGenesis(genesis_obj);
    var valid = await BGCrypto.verifyCanonical(genesis_obj.founder_pub_key, canonical, genesis_obj.signature);
    if (!valid) throw new Error('Tanda tangan undangan tidak valid. Mungkin QR palsu.');

    // check not already joined
    var existing = await BGDB.getCircle(genesis_obj.genesis_id);
    if (existing) return existing; // idempotent

    await BGDB.saveCircle(genesis_obj);

    // add founder as known peer
    var existingPeer = await BGDB.getPeer(genesis_obj.founder_pub_key);
    if (!existingPeer) {
      await BGDB.savePeer({
        pub_key: genesis_obj.founder_pub_key,
        nama: 'Pendiri ' + genesis_obj.circle_name,
        kas_name: genesis_obj.circle_name,
        last_sync: Date.now(),
        reputation_score: 100,
        is_founder: true
      });
    }

    return genesis_obj;
  }

  // derive deterministic Trystero room ID from genesis
  async function getRoomId(genesis_id) {
    return BGCrypto.sha256('mefobills:circle:' + genesis_id);
  }

  // serialize genesis to compact JSON for QR payload
  function toInvitePayload(genesis) {
    return JSON.stringify({
      _mb: 1, // mefo bills invite flag
      gi: genesis.genesis_id,
      cn: genesis.circle_name,
      fp: genesis.founder_pub_key,
      ca: genesis.created_at,
      sig: genesis.signature
    });
  }

  // parse invite payload (compact or full form)
  function fromInvitePayload(raw) {
    var obj = JSON.parse(raw);
    // compact form
    if (obj._mb === 1) {
      return {
        genesis_id: obj.gi,
        circle_name: obj.cn,
        founder_pub_key: obj.fp,
        created_at: obj.ca,
        signature: obj.sig
      };
    }
    // full form (direct genesis object)
    return obj;
  }

  // is pub_key a known member of this circle?
  async function isMember(pub_key) {
    var peer = await BGDB.getPeer(pub_key);
    return !!peer;
  }

  return {
    createCircle: createCircle,
    joinCircle: joinCircle,
    getRoomId: getRoomId,
    toInvitePayload: toInvitePayload,
    fromInvitePayload: fromInvitePayload,
    isMember: isMember
  };

})();
