// Noble secp256k1 ESM -> global bridge
// Loaded as <script type="module"> so it can import ESM, then exposes to window
import * as secp from './noble-secp256k1.js';
window.__nobleSecp256k1 = secp;
