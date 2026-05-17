/**
 * Passkey Wallet Executor for near-connect
 *
 * Flow:
 * 1. signIn — dApp generates NON-EXTRACTABLE ed25519 session keypair.
 *    Sends publicKey through relay. Wallet registers it on-chain via CreateSession
 *    (one Face ID prompt). dApp stores CryptoKey handle in parent's storage.
 * 2. signAndSendTransaction — dApp borsh-serializes, signs locally with session key,
 *    submits directly to wallet contract via relay. No wallet tab needed.
 */

var RELAY_URL = "https://near-wallet-connect-relay.kj95hgdgnn.workers.dev";
var WALLET_RELAY_URL = "https://near-wallet-relay.kj95hgdgnn.workers.dev";
var NEAR_RPC = "https://free.rpc.fastnear.com";
var CHAIN_ID = "mainnet";
var WALLET_DOMAIN = "NEAR_WALLET_CONTRACT/V1";

// ─── Relay fetch via parent bridge ──────────────────────────

function relayFetch(path, body) {
  var url = RELAY_URL + path;
  var args = body !== undefined
    ? [null, [url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }]]
    : [null, [url]];
  return window.selector.call("external", {
    entity: "__pwFetch",
    key: "apply",
    args: args,
  });
}

function rpcFetch(method, params) {
  return window.selector.call("external", {
    entity: "__pwFetch",
    key: "apply",
    args: [null, [NEAR_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
    }]],
  });
}

// ─── Non-extractable Ed25519 Session Key ────────────────────

var _sessionKeyCache = null; // { publicKey, publicKeyBytes, privateKey (CryptoKey handle), sessionKeyId }

async function generateSessionKey() {
  // Always extractable so we can store private key in memory
  var keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign"]
  );
  
  var rawPub = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  var pubBytes = new Uint8Array(rawPub);
  
  // Debug: log raw bytes
  try { window.parent.postMessage({ method: 'pw-debug', log: 'generateSessionKey: pubBytes len=' + pubBytes.length + ' first4=[' + pubBytes[0] + ',' + pubBytes[1] + ',' + pubBytes[2] + ',' + pubBytes[3] + ']' }, '*'); } catch(e) {}

  // Sanity check — Ed25519 public key MUST be 32 bytes
  if (pubBytes.length !== 32) {
    throw new Error("Ed25519 public key is " + pubBytes.length + " bytes, expected 32");
  }

  var b58 = base58Encode(pubBytes);
  var pubKeyStr = "ed25519:" + b58;

  // Debug: log encoded result
  try { window.parent.postMessage({ method: 'pw-debug', log: 'generateSessionKey: b58="' + b58 + '" (len=' + b58.length + ') fullKey="' + pubKeyStr + '"' }, '*'); } catch(e) {}

  // Export private key as JWK for in-memory storage
  var privJWK = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  
  return {
    publicKey: pubKeyStr,
    publicKeyBytes: pubBytes,
    privateKey: keyPair.privateKey,
    privateKeyJWK: privJWK,
  };
}

// ─── Session key storage via parent bridge ──────────

function storeSessionKeyParent(keyData, sessionKeyId) {
  var data = { sessionKeyId: sessionKeyId, publicKey: keyData.publicKey, privateKeyJWK: keyData.privateKeyJWK };
  return window.selector.call("storage.set", { key: "passkey_session_key", value: JSON.stringify(data) })
    .then(function() {
      try { window.parent.postMessage({ method: 'pw-debug', log: 'Session key saved to parent storage: id=' + sessionKeyId }, '*'); } catch(e) {}
    });
}

function loadSessionKeyParent() {
  return window.selector.call("storage.get", { key: "passkey_session_key" })
    .then(function(v) {
      if (!v) {
        try { window.parent.postMessage({ method: 'pw-debug', log: 'loadSessionKeyParent: no key in parent storage' }, '*'); } catch(e) {}
        return null;
      }
      var data = JSON.parse(v);
      try { window.parent.postMessage({ method: 'pw-debug', log: 'loadSessionKeyParent: loaded id=' + data.sessionKeyId + ' pub=' + data.publicKey }, '*'); } catch(e) {}
      return crypto.subtle.importKey("jwk", data.privateKeyJWK, { name: "Ed25519" }, true, ["sign"])
        .then(function(privKey) {
          return { privateKey: privKey, publicKey: data.publicKey, sessionKeyId: data.sessionKeyId };
        });
    });
}

// ─── Borsh serialization ────────────────────────────────────

function bU32(n) { var b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function bStr(s) { var e = new TextEncoder().encode(s); return new Uint8Array([...bU32(e.length), ...e]); }
function bU64(n) { var b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; }
function bU128(n) { var lo = BigInt(n) & ((1n << 64n) - 1n); var hi = BigInt(n) >> 64n;
  var b = new Uint8Array(16); new DataView(b.buffer).setBigUint64(0, lo, true); new DataView(b.buffer).setBigUint64(8, BigInt(hi), true); return b; }

function concat() {
  var total = 0;
  for (var i = 0; i < arguments.length; i++) total += arguments[i].length;
  var out = new Uint8Array(total);
  var off = 0;
  for (var i = 0; i < arguments.length; i++) { out.set(arguments[i], off); off += arguments[i].length; }
  return out;
}

// Serialize request with ops (for session key management — CreateSession, etc.)
function borshRequestMsgWithOps(msg) {
  var opsParts = [];
  for (var i = 0; i < msg.ops.length; i++) {
    var op = msg.ops[i];
    if (op.type === "create_session") {
      opsParts.push(new Uint8Array([3]));
      opsParts.push(bStr(op.session_key_id));
      opsParts.push(bStr(op.public_key));
      opsParts.push(bU32(op.ttl_secs));
    }
  }
  return concat(
    bStr(msg.chain_id || CHAIN_ID),
    bStr(msg.signer_id),
    bU32(msg.nonce),
    bU32(msg.created_at),
    bU32(msg.timeout || 600),
    bU32(msg.ops.length),
    concat.apply(null, opsParts),
    bU32(0), // PromiseDAG.after
    bU32(0), // PromiseDAG.then
  );
}

// Serialize request with DAG actions for session key signing
function borshRequestMsgWithActions(msg) {
  var thenParts = [];
  for (var i = 0; i < msg.then.length; i++) {
    var promise = msg.then[i];
    thenParts.push(bStr(promise.receiver_id));
    thenParts.push(new Uint8Array([0])); // refund_to: None
    thenParts.push(bU32(promise.actions.length));
    for (var j = 0; j < promise.actions.length; j++) {
      var act = promise.actions[j];
      if (act.action === "function_call") {
        thenParts.push(new Uint8Array([2])); // FunctionCall discriminant
        thenParts.push(bStr(act.function_name || ""));
        var argsBytes = act.args ? Uint8Array.from(atob(act.args), function(c) { return c.charCodeAt(0); }) : new Uint8Array(0);
        thenParts.push(bU32(argsBytes.length));
        thenParts.push(argsBytes);
        thenParts.push(bU128(act.deposit || "0"));
        thenParts.push(bU64(act.min_gas || "30000000000000"));
        thenParts.push(bU64(act.gas_weight || "0"));
      } else if (act.action === "transfer") {
        thenParts.push(new Uint8Array([0])); // Transfer discriminant
        thenParts.push(bU128(act.deposit || "0"));
      }
    }
  }
  return concat(
    bStr(msg.chain_id || CHAIN_ID),
    bStr(msg.signer_id),
    bU32(msg.nonce),
    bU32(msg.created_at),
    bU32(msg.timeout || 300),
    bU32(0), // 0 ops
    bU32(0), // PromiseDAG.after empty
    bU32(msg.then.length),
    concat.apply(null, thenParts),
  );
}

async function sha256Raw(bytes) {
  var hash = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(hash);
}

function secureNonce() {
  var b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0];
}

// ─── Base58 ─────────────────────────────────────────────────

var B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes) {
  var d = [], z = 0;
  for (var i = 0; i < bytes.length; i++) {
    var c = bytes[i];
    for (var j = 0; j < d.length; j++) {
      c += d[j] * 256;
      d[j] = c % 58;
      c = Math.floor(c / 58);
    }
    while (c) { d.push(c % 58); c = Math.floor(c / 58); }
    if (bytes[i] === 0 && i === z) z++;
  }
  var s = "";
  for (var i = 0; i < z; i++) s += B58[0];
  for (var i = d.length - 1; i >= 0; i--) s += B58[d[i]];
  return s;
}

// ─── QR ─────────────────────────────────────────────────────

function qrImg(data, size) {
  size = size || 200;
  return '<img src="https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size + '&data=' + encodeURIComponent(data) + '" style="width:' + size + 'px;height:' + size + 'px;border-radius:12px;" />';
}

// ─── UI ─────────────────────────────────────────────────────

function show(html) {
  var root = document.getElementById("root");
  if (!root) { root = document.createElement("div"); root.id = "root"; document.body.appendChild(root); }
  root.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px;";
  root.innerHTML = html;
  window.selector.ui.showIframe();
}

function hide() {
  window.selector.ui.hideIframe();
}

function renderQR(sessionId, title, subtitle) {
  var uri = "nearpasskey://connect?relay=" + encodeURIComponent(RELAY_URL) + "&session=" + sessionId;
  var deepLink = "https://near-passkey-wallet.pages.dev/?connect=1&relay=" + encodeURIComponent(RELAY_URL) + "&session=" + sessionId;

  var isMobile = window.selector.outerWidth < 768;

  var qrSection = isMobile
    ? '<div id="pw-qr-wrap" style="display:none;margin-top:16px;">' +
        '<div style="background:#fff;padding:14px;border-radius:16px;display:inline-block;">' +
          qrImg(uri, 200) +
        '</div>' +
      '</div>'
    : '<div style="background:#fff;padding:14px;border-radius:16px;display:inline-block;">' +
        qrImg(uri, 200) +
      '</div>';

  var toggleQr = isMobile
    ? '<div style="margin-top:12px;"><a id="pw-toggle-qr" href="#" style="color:#10b981;font-size:13px;text-decoration:underline;">Scan from another device</a></div>'
    : '<div style="font-size:11px;color:#666;margin-top:8px;">or open on this device</div>';

  var openBtn = '<button id="pw-open" style="width:100%;max-width:280px;padding:14px;border:none;border-radius:12px;background:#10b981;color:#fff;font-size:16px;font-weight:600;cursor:pointer;' + (isMobile ? 'margin-top:0;' : 'margin-top:12px;') + '">' +
    (isMobile ? 'Open Passkey Wallet' : 'Open on this device') + '</button>';

  show(
    '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#fff;text-align:center;">' +
      '<div style="font-size:20px;font-weight:600;margin-bottom:6px;">' + title + '</div>' +
      '<div style="font-size:13px;color:#999;margin-bottom:20px;">' + subtitle + '</div>' +
      qrSection +
      (isMobile ? '' : '<div style="margin-top:16px;">') +
        openBtn +
      (isMobile ? '' : '</div>') +
      toggleQr +
      '<div style="margin-top:16px;font-size:12px;color:#888;display:flex;align-items:center;gap:8px;justify-content:center;">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:#10b981;animation:pw-p 2s infinite;"></span>' +
        'Waiting for wallet...' +
      '</div>' +
      '<style>@keyframes pw-p{0%,100%{opacity:1}50%{opacity:.3}}</style>' +
    '</div>'
  );

  document.getElementById("pw-open").addEventListener("click", function() {
    window.selector.call("open", { url: deepLink });
  });

  if (isMobile) {
    document.getElementById("pw-toggle-qr").addEventListener("click", function(e) {
      e.preventDefault();
      var wrap = document.getElementById("pw-qr-wrap");
      wrap.style.display = wrap.style.display === "none" ? "block" : "none";
    });
  }
}

// ─── Core flow ──────────────────────────────────────────────

function connectFlow(request, title, subtitle) {
  // Debug: log what we're about to send
  try { window.parent.postMessage({ method: 'pw-debug', log: 'connectFlow: sending request=' + JSON.stringify(request).substring(0, 300) }, '*'); } catch(e) {}

  return relayFetch("/v1/session", { name: window.selector?.location || "dApp" })
    .then(function(session) {
      var sid = session.sessionId;
      renderQR(sid, title, subtitle);

      return relayFetch("/v1/session/" + sid + "/request", request).then(function() {
        return new Promise(function(resolve, reject) {
          var start = Date.now();
          var settled = false;

          function poll() {
            if (settled) return;
            if (Date.now() - start > 300000) {
              settled = true;
              clearInterval(timer);
              hide();
              reject(new Error("Timed out"));
              return;
            }
            relayFetch("/v1/session/" + sid + "/response?wait=2").then(function(resp) {
              if (settled || !resp) return;
              settled = true;
              clearInterval(timer);
              hide();

              if (resp.rejected) {
                reject(new Error("User rejected"));
              } else if (resp.accountId) {
                resolve({ accounts: [{ accountId: resp.accountId, publicKey: resp.publicKey }], sessionKeyId: resp.sessionKeyId });
              } else if (resp.outcome) {
                resolve(resp.outcome);
              } else if (resp.signedMessage) {
                resolve(resp.signedMessage);
              } else {
                reject(new Error("Unexpected response"));
              }
            }).catch(function() {});
          }

          var timer = setInterval(poll, 2000);
          poll();

          document.addEventListener("visibilitychange", function onVis() {
            if (document.visibilityState === "visible") { poll(); }
          });
        });
      });
    })
    .catch(function(err) {
      hide();
      throw err;
    });
}

// ─── Persistent accounts via parent storage bridge ──────────

function getStoredAccounts() {
  return window.selector.call("storage.get", { key: "passkey_accounts" })
    .then(function(v) { try { return JSON.parse(v) || []; } catch(e) { return []; } });
}

function setStoredAccounts(accounts) {
  return window.selector.call("storage.set", { key: "passkey_accounts", value: JSON.stringify(accounts) })
    .catch(function() {});
}

function clearStoredAccounts() {
  return window.selector.call("storage.remove", { key: "passkey_accounts" })
    .then(function() { return window.selector.call("storage.remove", { key: "passkey_session_key_id" }); });
}

// ─── Session key signing + direct relay submission ──────────

async function signAndSubmitLocal(accountId, sessionKeyId, privateKey, receiverId, dagActions) {
  var nonce = secureNonce();
  var now = Math.floor(Date.now() / 1000);

  // Borsh-serialize with actual DAG actions
  var borshBytes = borshRequestMsgWithActions({
    chain_id: CHAIN_ID,
    signer_id: accountId,
    nonce: nonce,
    created_at: now - 30,
    timeout: 300,
    then: [{ receiver_id: receiverId, actions: dagActions }],
  });

  // Raw SHA-256 of borsh bytes — NO domain prefix (session keys, not passkeys)
  var msgHash = await sha256Raw(borshBytes);

  // Sign with non-extractable session key
  var signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, msgHash);

  // Build args for w_execute_session
  var args = {
    session_key_id: sessionKeyId,
    signature: base58Encode(new Uint8Array(signature)),
    msg: {
      chain_id: CHAIN_ID,
      signer_id: accountId,
      nonce: nonce,
      created_at: new Date((now - 30) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      timeout_secs: 300,
      request: { ops: [], out: { after: [], then: [{ receiver_id: receiverId, actions: dagActions }] } },
    },
  };

  // Submit via wallet relay
  var argsBase64 = btoa(JSON.stringify(args));
  var result = await window.selector.call("external", {
    entity: "__pwFetch",
    key: "apply",
    args: [null, [WALLET_RELAY_URL + "/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method_name: "w_execute_session",
        args_base64: argsBase64,
        wallet_account_id: accountId,
      }),
    }]],
  });

  return result;
}

// ─── NearWalletBase ─────────────────────────────────────────

var wallet = {
  signIn: function(data) {
    // Generate session key BEFORE connecting
    return generateSessionKey().then(function(keyData) {
      var sessionKeyId = "dapp-" + Date.now().toString(36) + "-" + secureNonce().toString(36);

      // Debug: log what we got
      try { window.parent.postMessage({ method: 'pw-debug', log: 'Session key generated: pub=' + keyData.publicKey + ' id=' + sessionKeyId }, '*'); } catch(e) {}

      // Save to parent storage IMMEDIATELY — iframe may be destroyed after connectFlow returns
      return storeSessionKeyParent(keyData, sessionKeyId).then(function() {
        return connectFlow(
          {
            type: "signIn",
            network: (data && data.network) || "testnet",
            sessionPublicKey: keyData.publicKey,
            sessionKeyId: sessionKeyId,
          },
          "Scan to Connect",
          "Open Passkey Wallet to connect"
        ).then(function(result) {
          var accounts = result.accounts || result;
          return setStoredAccounts(accounts).then(function() {
            return accounts;
          });
        });
      });
    });
  },
  signInAndSignMessage: function() { return Promise.reject(new Error("Not supported")); },
  signOut: function() {
    // Clear session key from parent storage
    return window.selector.call("storage.remove", { key: "passkey_session_key" })
      .then(function() { return clearStoredAccounts(); });
  },
  getAccounts: function() { return getStoredAccounts(); },
  signAndSendTransaction: function(params) {
    // Try local session key signing first (no wallet tab needed)
    return loadSessionKeyParent().then(function(stored) {
      if (stored && stored.privateKey && stored.sessionKeyId) {
        // Build DAG actions from params
        var dagActions = (params.actions || []).map(function(a) {
          if (a.type === "Transfer") return { action: "transfer", deposit: a.params?.amount || "0" };
          if (a.type === "FunctionCall") return { action: "function_call", function_name: a.params?.methodName || "", args: a.params?.args ? btoa(JSON.stringify(a.params.args)) : "", deposit: a.params?.deposit || "0", min_gas: a.params?.gas || "30000000000000", gas_weight: "0" };
          return { action: "transfer", deposit: "0" };
        });
        var accountId = params.signerId;
        return signAndSubmitLocal(accountId, stored.sessionKeyId, stored.privateKey, params.receiverId, dagActions).then(function(result) {
          if (result.status === "Failure") {
            throw new Error("Tx failed: " + JSON.stringify(result).slice(0, 300));
          }
          return result;
        });
      }

      // Fallback: relay through wallet tab (passkey signing)
      return connectFlow(
        {
          type: "signAndSendTransaction",
          signerId: params.signerId,
          receiverId: params.receiverId,
          actions: params.actions,
        },
        "Approve Transaction",
        "Open wallet to sign"
      );
    });
  },
  signAndSendTransactions: function(params) {
    var self = this, results = [], chain = Promise.resolve();
    (params.transactions || []).forEach(function(tx) {
      chain = chain.then(function() { return self.signAndSendTransaction({ network: params.network, signerId: params.signerId, receiverId: tx.receiverId, actions: tx.actions }); })
        .then(function(o) { results.push(o); });
    });
    return chain.then(function() { return results; });
  },
  signMessage: function(params) {
    // Use session key to sign locally if available
    return loadSessionKeyParent().then(function(stored) {
      if (stored && stored.privateKey && stored.sessionKeyId) {
        var nonceBytes = new Uint8Array(params.nonce);
        var msgBytes = new TextEncoder().encode(params.message);
        // Concatenate nonce + message for signing
        var payload = new Uint8Array(nonceBytes.length + msgBytes.length);
        payload.set(nonceBytes, 0);
        payload.set(msgBytes, nonceBytes.length);

        return crypto.subtle.sign({ name: "Ed25519" }, stored.privateKey, payload).then(function(sig) {
          try { window.parent.postMessage({ method: 'pw-debug', log: 'signMessage: signed locally with session key' }, '*'); } catch(e) {}
          return {
            signedMessage: {
              message: params.message,
              recipient: params.recipient,
              nonce: Array.from(nonceBytes),
              signature: base58Encode(new Uint8Array(sig)),
              publicKey: stored.publicKey,
            },
          };
        });
      }
      // Fallback: relay through wallet tab
      return connectFlow(
        { type: "signMessage", message: params.message, recipient: params.recipient, nonce: Array.from(params.nonce) },
        "Sign Message",
        "Open wallet to sign"
      );
    });
  },
  signDelegateActions: function() { return Promise.reject(new Error("Not supported")); },
};

window.selector.ready(wallet);
