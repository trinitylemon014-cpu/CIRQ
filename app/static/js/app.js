/* CIRQ front-end. No authorization logic lives here: the server decides everything. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const csrf = () => ($('meta[name="csrf-token"]') || {}).content || "";

  async function api(url, { method = "POST", body, json } = {}) {
    const headers = { "X-CSRFToken": csrf(), "X-Requested-With": "fetch" };
    let payload = body;
    if (json !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(json); }
    const res = await fetch(url, { method, headers, body: method === "GET" ? undefined : payload, credentials: "same-origin" });
    let data = {};
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok) { const err = new Error(data.error || "Something went wrong."); err.status = res.status; throw err; }
    return data;
  }
  function toast(msg, kind = "info") {
    let box = $(".flashes");
    if (!box) { box = document.createElement("div"); box.className = "flashes"; document.body.append(box); }
    const el = document.createElement("div");
    el.className = "flash " + kind;
    el.innerHTML = '<span></span><button type="button" data-dismiss aria-label="Dismiss">✕</button>';
    el.firstChild.textContent = msg;
    box.append(el);
    setTimeout(() => el.remove(), 5000);
  }
  setTimeout(() => $$(".flash").forEach((f) => f.remove()), 6000);

  /* ---------- generic click handlers (event delegation) ---------- */
  document.addEventListener("click", async (e) => {
    const t = e.target;
    const c = (sel) => t.closest(sel);

    if (c("[data-dismiss]")) { c(".flash").remove(); return; }
    if (c("[data-open]")) { const d = document.getElementById(c("[data-open]").dataset.open); d && d.showModal(); return; }
    if (c("[data-close]")) { const d = c("dialog"); d && d.close(); return; }
    if (t.tagName === "DIALOG") { t.close(); return; }

    const menuBtn = c("[data-menu]");
    $$(".menu.open").forEach((m) => { if (!menuBtn || m !== menuBtn.closest(".menu")) m.classList.remove("open"); });
    if (menuBtn) { menuBtn.closest(".menu").classList.toggle("open"); return; }

    const pw = c("[data-toggle-pw]");
    if (pw) { const inp = document.getElementById(pw.dataset.togglePw); inp.type = inp.type === "password" ? "text" : "password"; return; }

    const cp = c("[data-copy]");
    if (cp) {
      try { await navigator.clipboard.writeText(cp.dataset.copy); toast("Link copied", "success"); }
      catch (_) { window.prompt("Copy this link:", cp.dataset.copy); }
      return;
    }

    const rep = c("[data-report]");
    if (rep) {
      e.preventDefault();
      const [type, id] = rep.dataset.report.split(":");
      const d = $("#report-dialog"); const f = $("[data-report-form]", d);
      f.target_type.value = type; f.target_id.value = id; d.showModal(); return;
    }

    const like = c("[data-like]");
    if (like) {
      like.disabled = true;
      try {
        const r = await api(`/posts/${like.dataset.like}/like`);
        like.classList.toggle("liked", r.liked); like.setAttribute("aria-pressed", r.liked);
        $("[data-count]", like).textContent = r.count;
      } catch (err) { toast(err.message, "error"); }
      like.disabled = false; return;
    }

    const fol = c("[data-follow]");
    if (fol) {
      fol.disabled = true;
      try {
        const r = await api(`/u/${fol.dataset.follow}/follow`);
        $$(`[data-follow="${fol.dataset.follow}"]`).forEach((b) => {
          b.textContent = r.following ? "Following" : "Follow"; b.classList.toggle("following", r.following); b.dataset.following = r.following ? 1 : 0;
        });
        const n = $("[data-followers]"); if (n) n.textContent = r.followers;
      } catch (err) { toast(err.message, "error"); }
      fol.disabled = false; return;
    }

    const edit = c("[data-edit-post]");
    if (edit) { const card = c(".post"); $("[data-edit-form]", card).hidden = false; const cap = $("[data-caption]", card); cap && (cap.hidden = true); card.querySelector(".menu").classList.remove("open"); return; }
    if (c("[data-cancel-edit]")) { const card = c(".post"); $("[data-edit-form]", card).hidden = true; const cap = $("[data-caption]", card); cap && (cap.hidden = false); return; }

    const story = c("[data-story]");
    if (story) { openStory(story.dataset.story); return; }

    const more = c("#load-more");
    if (more) { loadMore(more); return; }
  });

  document.addEventListener("submit", async (e) => {
    const f = e.target;
    if (f.dataset.confirm && !window.confirm(f.dataset.confirm)) { e.preventDefault(); return; }
    if (f.matches("[data-report-form]")) {
      e.preventDefault();
      try { const r = await api(f.action, { body: new FormData(f) }); toast(r.message, "success"); f.closest("dialog").close(); f.reset(); }
      catch (err) { toast(err.message, "error"); }
      return;
    }
    if (f.matches("[data-comment-form]")) {
      e.preventDefault();
      const btn = $("button", f); btn.disabled = true;
      try {
        const r = await api(f.action, { body: new FormData(f) });
        const list = $("[data-comment-list]"); const none = $("[data-no-comments]"); none && none.remove();
        list.insertAdjacentHTML("beforeend", r.html); f.reset();
        const n = $("[data-comment-count]"); n && (n.textContent = `(${r.count})`);
      } catch (err) { toast(err.message, "error"); }
      btn.disabled = false; return;
    }
    if (f.matches('[action$="/delete"][data-ajax]')) { /* reserved */ }
  });

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches('input[type="file"]')) {
      const lbl = t.closest("label") && $("[data-file-label]", t.closest("label"));
      if (lbl && t.files[0]) lbl.textContent = t.files[0].name;
      if (t.dataset.autosubmit && t.files[0]) document.getElementById(t.dataset.autosubmit).submit();
    }
    if (t.matches("[data-toggle-manual]")) {
      $("#manual-block").hidden = !t.checked; $("#email-block").hidden = t.checked;
    }
  });

  /* ---------- infinite "load more" ---------- */
  async function loadMore(btn) {
    const target = $(btn.dataset.target);
    const marker = $$("[data-more-cursor]", target).pop();
    if (!marker) { btn.hidden = true; return; }
    const url = new URL(target.dataset.feedUrl, location.origin);
    url.searchParams.set("before", marker.dataset.moreCursor); url.searchParams.set("partial", "1");
    btn.disabled = true; btn.textContent = "Loading…";
    try {
      const res = await fetch(url, { credentials: "same-origin", headers: { "X-Requested-With": "fetch" } });
      const html = await res.text(); marker.remove(); target.insertAdjacentHTML("beforeend", html);
      btn.hidden = !$$("[data-more-cursor]", target).length;
    } catch (_) { toast("Couldn't load more.", "error"); }
    btn.disabled = false; btn.textContent = "Load more";
  }

  /* ---------- stories ---------- */
  let viewer;
  function ensureViewer() {
    if (viewer) return viewer;
    viewer = document.createElement("div"); viewer.className = "story-viewer"; viewer.setAttribute("role", "dialog"); viewer.setAttribute("aria-label", "Story");
    viewer.innerHTML = `<div class="story-box"><div class="story-bars"></div><div class="story-head"><span class="av" style="--s:38px"></span><b data-su></b><span class="grow"></span><button class="icon-btn" data-sdel hidden aria-label="Delete story" style="color:#fff">🗑</button><button class="icon-btn" data-sclose aria-label="Close" style="color:#fff">✕</button></div>
      <div data-smedia style="width:100%;height:100%"></div><div class="story-cap" data-scap></div>
      <button class="story-hit prev" aria-label="Previous"></button><button class="story-hit next" aria-label="Next"></button></div>`;
    document.body.append(viewer);
    $("[data-sclose]", viewer).onclick = closeStory;
    viewer.addEventListener("click", (e) => { if (e.target === viewer) closeStory(); });
    document.addEventListener("keydown", (e) => { if (!viewer.classList.contains("open")) return; if (e.key === "Escape") closeStory(); if (e.key === "ArrowRight") step(1); if (e.key === "ArrowLeft") step(-1); });
    $(".next", viewer).onclick = () => step(1); $(".prev", viewer).onclick = () => step(-1);
    $("[data-sdel]", viewer).onclick = async () => {
      if (!confirm("Delete this story?")) return;
      try { await api(`/stories/${S.items[S.i].id}/delete`); toast("Story deleted", "success"); closeStory(); location.reload(); } catch (err) { toast(err.message, "error"); }
    };
    return viewer;
  }
  const S = { items: [], i: 0, timer: null, user: null };
  async function openStory(username) {
    ensureViewer();
    try {
      const r = await api(`/stories/api/${username}`, { method: "GET" });
      if (!r.stories.length) { toast("No active stories", "info"); return; }
      S.items = r.stories; S.i = Math.max(0, r.stories.findIndex((s) => !s.seen)); S.user = r;
      $("[data-su]", viewer).textContent = r.user.username; const av = $(".av", viewer);
      av.innerHTML = r.user.avatar ? `<img src="${r.user.avatar}" alt="">` : r.user.username[0]; $("[data-sdel]", viewer).hidden = !r.me;
      viewer.classList.add("open"); document.body.style.overflow = "hidden"; show();
    } catch (err) { toast(err.message, "error"); }
  }
  function show() {
    clearTimeout(S.timer);
    const s = S.items[S.i]; const bars = $(".story-bars", viewer);
    bars.innerHTML = S.items.map((_, k) => `<i><b style="width:${k < S.i ? 100 : 0}%"></b></i>`).join("");
    const holder = $("[data-smedia]", viewer); holder.innerHTML = "";
    let dur = 5000;
    if (s.type === "video") {
      const v = document.createElement("video"); v.src = s.src; v.autoplay = true; v.playsInline = true; v.controls = false; holder.append(v);
      v.onloadedmetadata = () => { dur = Math.min(30000, (v.duration || 8) * 1000); run(dur); }; v.onended = () => step(1); v.onerror = () => run(4000);
    } else { const im = document.createElement("img"); im.src = s.src; im.alt = "Story"; holder.append(im); run(dur); }
    $("[data-scap]", viewer).textContent = s.caption || "";
    api(`/stories/${s.id}/view`).catch(() => {});
  }
  function run(ms) {
    const b = $$(".story-bars b", viewer)[S.i]; if (!b) return;
    b.style.transition = `width ${ms}ms linear`; requestAnimationFrame(() => requestAnimationFrame(() => (b.style.width = "100%")));
    S.timer = setTimeout(() => step(1), ms);
  }
  function step(d) { S.i += d; if (S.i < 0) S.i = 0; if (S.i >= S.items.length) closeStory(); else show(); }
  function closeStory() { clearTimeout(S.timer); viewer.classList.remove("open"); $("[data-smedia]", viewer).innerHTML = ""; document.body.style.overflow = ""; }

  /* ---------- reels: play only the visible one, lazy-load sources, never autoplay audio ---------- */
  const reels = $("#reels");
  if (reels) {
    let muted = true;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        const v = $("video", en.target); if (!v) return;
        if (!v.src && v.dataset.src && en.intersectionRatio > 0.1) v.src = v.dataset.src;
        if (en.isIntersecting && en.intersectionRatio > 0.65) { v.muted = muted; v.play().catch(() => {}); } else v.pause();
      });
      const last = $$("[data-reel]", reels).slice(-2)[0];
      if (last && entries.some((en) => en.target === last && en.isIntersecting)) loadMoreReels();
    }, { root: reels, threshold: [0.1, 0.65] });
    const watch = () => $$("[data-reel]", reels).forEach((r) => { if (!r._w) { r._w = 1; io.observe(r); } });
    watch();
    reels.addEventListener("click", (e) => {
      const tg = e.target.closest("[data-reel-toggle]"); const mu = e.target.closest("[data-reel-mute]");
      if (tg) { const v = $("video", tg.closest("[data-reel]")); v.paused ? v.play() : v.pause(); }
      if (mu) { muted = !muted; $$("video", reels).forEach((v) => (v.muted = muted));
        $$("[data-reel-mute]", reels).forEach((b) => { b.innerHTML = `<svg class="i"><use href="#i-${muted ? "mute" : "volume"}"/></svg>`; b.setAttribute("aria-label", muted ? "Unmute" : "Mute"); }); }
    });
    let busy = false;
    async function loadMoreReels() {
      const cur = reels.dataset.cursor; if (!cur || busy) return; busy = true;
      try {
        const res = await fetch(`${reels.dataset.moreUrl}?before=${encodeURIComponent(cur)}&partial=1`, { credentials: "same-origin" });
        const html = await res.text();
        reels.dataset.cursor = res.headers.get("X-Next-Cursor") || "";
        reels.insertAdjacentHTML("beforeend", html); watch();
      } catch (_) { /* try again on next scroll */ }
      busy = false;
    }
  }

  /* ---------- chat ---------- */
  const chat = $(".chat-wrap");
  if (chat) {
    const box = $("#bubbles"), form = $("#chat-form");
    const bottom = () => (box.scrollTop = box.scrollHeight); bottom();
    let last = chat.dataset.last || "";
    const keepLast = () => { const m = $$(".msg", box).pop(); if (m) last = m.dataset.ts; };
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); const btn = $("button", form);
      if (!form.body.value.trim() && !form.attachment.files.length) return;
      btn.disabled = true;
      try {
        const r = await api(form.action, { body: new FormData(form) });
        const empty = $("p.muted", box); empty && empty.remove();
        box.insertAdjacentHTML("beforeend", r.html); last = r.ts; form.reset(); bottom();
      } catch (err) { toast(err.message, "error"); }
      btn.disabled = false; form.body.focus();
    });
    form.attachment.addEventListener("change", () => { if (form.attachment.files[0]) toast("Attached: " + form.attachment.files[0].name, "info"); });
    setInterval(async () => {   // polling fallback (no websockets needed)
      if (document.hidden) return;
      try {
        const r = await api(`${chat.dataset.poll}?after=${encodeURIComponent(last)}`, { method: "GET" });
        if (r.html) { box.insertAdjacentHTML("beforeend", r.html); last = r.ts; bottom(); }
      } catch (_) { /* transient */ }
    }, 4000);
    keepLast();
  }

  /* ---------- CIRQ FLIP (collectible student cards) ---------- */
  const flip = $("#flip");
  if (flip) {
    const deck = $("#flip-deck"), msg = $("#flip-msg"), sub = $("#flip-sub"), res = $("#flip-result"), startBtn = $("#flip-start"), stage = $("#stage");
    const mark = flip.dataset.mark; let busy = false, current = null;
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const short = (n) => (n >= 10000 ? Math.round(n / 1000) + "K" : n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n));
    const hearts = (left) => $$("#flip-hearts i").forEach((h, k) => h.classList.toggle("off", k >= left));
    function fillBack(card, p, extra) {   // all text is set with textContent, so student names can never inject markup
      const inner = $(".back .in", card); inner.textContent = "";
      card.classList.remove("r0", "r1", "r2", "r3", "r4", "r5", "r6", "dev");
      card.classList.add(p.developer ? "dev" : "r" + Math.min(p.tier_index, 6));
      const rating = el("div", "rating"); rating.append(el("b", "", p.developer ? "DEV" : short(p.followers)), el("small", "", p.developer ? "CIRQ" : "FOL")); inner.append(rating);
      if (p.developer) { const c = el("div", "crown"); c.innerHTML = '<svg class="i fill"><use href="#i-award"/></svg>'; inner.append(c); }
      const pt = el("div", "portrait");
      if (p.avatar) { const im = document.createElement("img"); im.src = p.avatar; im.alt = ""; pt.append(im); } else pt.textContent = (p.name || "?")[0];
      const np = el("div", "nameplate"); np.append(el("b", "", p.name), el("small", "", p.school || (p.username ? "@" + p.username : "")), el("span", "tierbar", p.developer ? "The Developer" : p.tier));
      inner.append(pt, np, el("i", "shine")); if (extra) card.classList.add(extra);
    }
    function build(n) {
      deck.textContent = "";
      for (let i = 0; i < n; i++) {
        const b = el("button", "pcard r0"); b.type = "button"; b.dataset.card = i; b.disabled = true; b.setAttribute("aria-label", "Card " + (i + 1));
        const f = el("span", "face front"), fi = el("span", "in"), im = document.createElement("img"); im.src = mark; im.alt = ""; fi.append(im, el("span", "num", String(i + 1).padStart(2, "0")), el("i", "shine")); f.append(fi);
        const bk = el("span", "face back"); bk.append(el("span", "in")); const fl = el("span", "flipper"); fl.append(f, bk); b.append(fl); deck.append(b);
      }
    }
    function paint(s) {
      current = s;
      if (deck.children.length !== s.cards) build(s.cards);
      hearts(s.guesses_left);
      $$(".pcard", deck).forEach((c) => { c.classList.remove("flipped", "win", "reveal", "miss"); c.disabled = s.status !== "active"; });
      s.flipped.forEach((f) => { const c = deck.children[f.card]; fillBack(c, f.profile); c.classList.add("flipped", f.correct ? "win" : "miss"); c.disabled = true; });
      if (s.status === "active") {
        msg.textContent = "Choose the developer card"; sub.textContent = `${s.guesses_left} guess${s.guesses_left === 1 ? "" : "es"} left. Flip a card to see who's behind it.`;
        startBtn.hidden = true; res.hidden = true; return;
      }
      const dev = s.developer;
      if (s.status === "lost") { const c = deck.children[s.answer_index]; fillBack(c, dev); c.classList.add("flipped", "reveal"); }
      msg.textContent = s.status === "won" ? "You found the developer! 🎉" : "Out of guesses";
      sub.textContent = s.status === "won" ? `That was ${dev.name}.` : `${dev.name} was hiding behind card ${s.answer_index + 1}.`;
      startBtn.hidden = false; startBtn.textContent = "Play again";
      const old = $("#mystery"); if (old) { const big = el("button", "pcard mystery flipped dev"); big.type = "button"; big.disabled = true; big.id = "mystery";
        const fr = el("span", "face front"); fr.append(el("span", "in")); const bk = el("span", "face back"); bk.append(el("span", "in")); const fl = el("span", "flipper"); fl.append(fr, bk); big.append(fl); fillBack(big, dev); old.replaceWith(big); }
    }
    async function begin() {
      startBtn.classList.add("loading");
      try { const old = $("#mystery"); paint(await api(flip.dataset.start)); } catch (err) { toast(err.message, "error"); sub.textContent = err.message; }
      startBtn.classList.remove("loading");
    }
    startBtn.addEventListener("click", begin);
    deck.addEventListener("click", async (e) => {
      const c = e.target.closest(".pcard"); if (!c || c.disabled || busy) return; busy = true; c.classList.add("selected");
      try {
        const s = await api(flip.dataset.guess, { json: { card: +c.dataset.card } });
        c.classList.remove("selected"); paint(s);
        if (s.status === "won") {
          res.hidden = false; res.className = "reward-pop"; res.textContent = "";
          const amt = s.reward && s.reward.coins ? "+" + s.reward.coins : "";
          if (amt) res.append(el("div", "amount", amt), el("div", "muted", "app coins added to your wallet"));
          res.append(el("p", "", s.reward && s.reward.note && !amt ? s.reward.note : `You spotted ${s.developer.name}!`));
          if (s.developer.username) { const a = el("a", "link", "Visit " + s.developer.name + "'s profile"); a.href = "/u/" + s.developer.username; res.append(a); }
          if (s.reward && s.reward.coins) toast(s.reward.note, "success");
          res.scrollIntoView({ behavior: "smooth", block: "center" });
        } else if (s.status === "lost") toast("No guesses left. Try another round!", "info");
      } catch (err) { c.classList.remove("selected"); toast(err.message, "error"); }
      busy = false;
    });
    api(flip.dataset.state, { method: "GET" }).then((s) => { if (s.active) paint(s); }).catch(() => {});
  }

  /* ---------- trivia ---------- */
  const tv = $("#trivia");
  if (tv) {
    const prompt = $("#t-prompt"), opts = $("#t-opts"), timer = $("#t-timer b"), pos = $("#t-pos"), pts = $("#t-pts"), note = $("#t-note");
    let raf, answered = false, q;
    async function load() {
      try { q = await api(tv.dataset.q, { method: "GET" }); } catch (err) { toast(err.message, "error"); return; }
      if (q.done) { location.href = q.redirect; return; }
      answered = false; note.textContent = ""; pos.textContent = `Question ${q.position} / ${q.total}`; pts.textContent = q.points;
      prompt.textContent = q.prompt; opts.innerHTML = "";
      q.options.forEach((o, i) => { const b = document.createElement("button"); b.type = "button"; b.className = "opt"; b.textContent = o; b.onclick = () => send(i); opts.append(b); });
      const total = q.time_limit * 1000, startAt = performance.now() - (total - q.remaining_ms);
      cancelAnimationFrame(raf);
      const tick = () => {
        const left = Math.max(0, total - (performance.now() - startAt));
        timer.style.transform = `scaleX(${left / total})`; timer.parentElement.classList.toggle("low", left < total * 0.25);
        if (left <= 0 && !answered) { send(null); return; }
        if (!answered) raf = requestAnimationFrame(tick);
      };
      tick();
    }
    async function send(choice) {
      if (answered) return; answered = true; cancelAnimationFrame(raf);
      $$(".opt", opts).forEach((b) => (b.disabled = true));
      try {
        const r = await api(tv.dataset.a, { json: { choice, position: q.position } });
        if (r.done) { location.href = r.redirect; return; }
        note.textContent = choice === null ? "Time's up!" : "Answer locked in."; setTimeout(load, 700);
      } catch (err) { toast(err.message, "error"); setTimeout(load, 900); }
    }
    load();
  }
})();
