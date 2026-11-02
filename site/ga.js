// Google Analytics (GA4) with one consent choice for codeoutbox.com AND
// app.codeoutbox.com. The choice lives in a cookie on .codeoutbox.com (localStorage
// is per-origin, so the app never saw a "yes" given on the marketing site).
//
//   <script src="/ga.js" data-ga="G-XXXX"></script>
//   <a data-track="cta_click" data-track-location="hero">…</a>   → event + params
//   window.coTrack("create_list")                                 → event from code
//
// Served as-is by the site (nginx) and by the app (GET /ga.js).
(function () {
  var s = document.currentScript;
  var id = s && s.getAttribute("data-ga");
  window.coTrack = function () {};
  if (!id) return;

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;
  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
  });
  gtag("js", new Date());
  gtag("config", id);
  var tag = document.createElement("script");
  tag.async = true;
  tag.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
  document.head.appendChild(tag);

  var shared = /(^|\.)codeoutbox\.com$/.test(location.hostname) ? "; domain=.codeoutbox.com" : "";
  function write(v) {
    document.cookie =
      "co_consent=" + v + "; path=/; max-age=31536000; SameSite=Lax" +
      (location.protocol === "https:" ? "; Secure" : "") + shared;
  }
  function read() {
    var m = document.cookie.match(/(?:^|; )co_consent=(granted|denied)/);
    if (m) return m[1];
    try {
      var old = localStorage.getItem("co_consent"); // pre-cookie choice on the marketing site
      if (old === "granted" || old === "denied") {
        write(old);
        return old;
      }
    } catch (e) {}
    return null;
  }
  function apply(v) {
    gtag("consent", "update", { analytics_storage: v === "granted" ? "granted" : "denied" });
  }

  window.coTrack = function (name, params) {
    gtag("event", name, params || {});
  };
  document.addEventListener(
    "click",
    function (e) {
      var t = e.target && e.target.closest && e.target.closest("[data-track]");
      if (!t) return;
      var p = {};
      for (var i = 0; i < t.attributes.length; i++) {
        var a = t.attributes[i];
        if (a.name.indexOf("data-track-") === 0) p[a.name.slice(11)] = a.value;
      }
      window.coTrack(t.getAttribute("data-track"), p);
    },
    true,
  );

  var choice = read();
  if (choice) {
    apply(choice);
    return;
  }

  function banner() {
    var el = document.createElement("div");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Cookie consent");
    el.style.cssText =
      "position:fixed;left:16px;right:16px;bottom:16px;max-width:680px;margin:0 auto;background:#0A0A0A;color:#fafafa;" +
      "border:1px solid #333;border-radius:12px;padding:14px 18px;font:14px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;" +
      "display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;z-index:9999;box-shadow:0 8px 30px rgba(0,0,0,.4)";
    el.innerHTML =
      '<span>We use one analytics cookie to learn what’s useful, nothing more. <a href="https://codeoutbox.com/privacy.html" style="color:#F59E0B">Privacy</a></span>' +
      '<span style="display:flex;gap:8px;flex-shrink:0">' +
      '<button type="button" data-v="denied" style="background:transparent;color:#ccc;border:1px solid #444;border-radius:8px;padding:8px 14px;cursor:pointer;font:inherit">Decline</button>' +
      '<button type="button" data-v="granted" style="background:#F59E0B;color:#1a1200;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font:inherit;font-weight:600">Accept</button></span>';
    el.addEventListener("click", function (e) {
      var v = e.target && e.target.getAttribute && e.target.getAttribute("data-v");
      if (!v) return;
      write(v);
      apply(v);
      el.remove();
    });
    document.body.appendChild(el);
  }
  if (document.body) banner();
  else document.addEventListener("DOMContentLoaded", banner);
})();
