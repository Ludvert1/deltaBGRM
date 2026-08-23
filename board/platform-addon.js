/* ═════════════════════════════════════════════════════════════════════════
   PLATFORM ADD-ON  —  injected into the board by scripts/build-board.mjs
   ═════════════════════════════════════════════════════════════════════════

   Everything the board already did still works exactly as before. This adds
   the four things the board could not do on its own:

   1. CART DEPARTURE DEADLINE
      The board's cutoff is when bags must be AT the aircraft. Carts have to
      leave the bag room before that, by however long the tow takes from that
      pier. This computes the real "carts leave by" time and shows it.

   2. ESCALATING ALERTS
      The stock board chimed once, at cutoff, whether or not the cart was
      already gone. This warns ahead of the cart deadline, escalates, repeats
      while overdue, goes quiet the moment Cart Out is recorded, and can raise
      a system notification so it still lands when the tab is in the background.

   3. A STANDING NEXT-OUT BAR
      A fixed strip showing the next carts due out with live countdowns, so an
      agent can see at a glance what leaves next without reading the whole board.

   4. PLATFORM SYNC
      Pushes the timestamped step trail — including who recorded each step —
      to /api/ingest, which is what lets the platform attribute a late
      departure to the step that caused it. The same payload seeds the
      schedule, so tomorrow's board has flights and gates without any key.

   ───────────────────────────────────────────────────────────────────────── */
(function platformAddon() {
  "use strict";

  var ORIGIN = window.location.origin;
  var FEED = ORIGIN + "/api/feed";
  var INGEST = ORIGIN + "/api/ingest";
  var SYNC_MS = 120000;

  /* ── tow time from bag room to plane side, per pier ─────────────────────
     These are the numbers every alert depends on. Walk the route with a
     stopwatch and set them for your floor: Ops Entry → Settings, or edit the
     defaults here. A two-minute error here is a two-minute error everywhere. */
  var DEFAULT_TRANSIT = { A: 6, B: 7, C: 9, D: 11 };
  var FALLBACK_TRANSIT = 8;

  function transitFor(pier) {
    var map = (settings && settings.cartTransit) || DEFAULT_TRANSIT;
    var v = map[(pier || "").toUpperCase()];
    return typeof v === "number" && v > 0 ? v : FALLBACK_TRANSIT;
  }

  /* ── the deadline ─────────────────────────────────────────────────────── */

  /** Minutes after midnight by which carts must roll out of the bag room. */
  function cartDeadlineMinutes(f) {
    var etd = parseTimeToMinutes(f.eta || f.sched);
    if (etd == null) return null;
    return etd - (settings.cutoffBuffer || 45) - transitFor(f.pierSide);
  }

  function minutesToDeadline(f) {
    var d = cartDeadlineMinutes(f);
    if (d == null) return null;
    var diff = d - nowMinutes();
    // The board's clock wraps at midnight; keep late-night flights sane.
    if (diff > 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    return diff;
  }

  function cartIsOut(f) {
    return Boolean(
      f.cartOutActual ||
        f.status === "cartOut" ||
        f.status === "deliveredAtGate" ||
        f.status === "complete",
    );
  }

  function stillNeedsCart(f) {
    if (!f) return false;
    if (f.status === "canceled" || f.status === "diverted") return false;
    return !cartIsOut(f);
  }

  function fmtMinutes(m) {
    // nowMinutes() carries seconds as a fraction, so round before display.
    var r = Math.round(m);
    var sign = r < 0 ? "-" : "";
    var a = Math.abs(r);
    var h = Math.floor(a / 60);
    var mm = a % 60;
    return sign + (h > 0 ? h + "h " : "") + mm + "m";
  }

  /* ── keep the board's own variance honest ───────────────────────────────
     The stock computeVariance() measured cart-out against the cutoff, ignoring
     tow time — so a cart that left with four minutes to walk an eleven-minute
     route counted as on time. Overriding it here means the OTP on the floor
     and the OTP in the platform's reports are the same number. */
  var _originalComputeVariance = window.computeVariance;
  window.computeVariance = function (f) {
    if (!f || !f.cartOutActual) return null;
    var deadline = cartDeadlineMinutes(f);
    var actual = parseTimeToMinutes(f.cartOutActual);
    if (deadline == null || actual == null) {
      return _originalComputeVariance ? _originalComputeVariance(f) : null;
    }
    var v = deadline - actual;
    if (v > 720) v -= 1440;
    if (v < -720) v += 1440;
    return v; // positive = rolled with time in hand
  };

  /* ── alerting ─────────────────────────────────────────────────────────── */

  var WARN_AT = [10, 5, 0]; // minutes before the cart deadline
  var OVERDUE_REPEAT_MS = 60000;
  var fired = Object.create(null); // flightId:threshold → true
  var lastOverdue = Object.create(null); // flightId → timestamp
  var addonBoot = Date.now();
  var notificationsAsked = false;

  function askForNotifications() {
    if (notificationsAsked) return;
    notificationsAsked = true;
    try {
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    } catch (e) {}
  }
  // Permission prompts require a gesture, and audio needs one too.
  document.addEventListener("click", askForNotifications, { once: true });
  document.addEventListener("touchstart", askForNotifications, { once: true });

  function notify(title, body) {
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        var n = new Notification(title, { body: body, tag: title, renotify: true });
        setTimeout(function () {
          n.close();
        }, 20000);
      }
    } catch (e) {}
  }

  function alertBanner(f, minutes) {
    var el = document.getElementById("pa-banner");
    if (!el) return;
    var overdue = minutes <= 0;
    el.className = "pa-banner show " + (overdue ? "pa-overdue" : "pa-warn");
    el.innerHTML =
      '<div class="pa-banner-head">' +
      (overdue ? "CARTS OUT NOW" : "CARTS OUT IN " + Math.round(minutes) + " MIN") +
      "</div>" +
      '<div class="pa-banner-sub">' +
      esc(f.flight) +
      " → " +
      esc(f.dest || "???") +
      " · Gate " +
      esc(f.gate || "?") +
      " · Pier " +
      esc(f.pierSide || "?") +
      (f.carts ? " · " + esc(f.carts) + " carts" : "") +
      "</div>" +
      '<div class="pa-banner-sub">Leave by ' +
      esc(fmtTime(cartDeadlineMinutes(f))) +
      " · " +
      transitFor(f.pierSide) +
      " min to plane side</div>";
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      el.classList.remove("show");
    }, overdue ? 15000 : 9000);
  }

  function checkAlerts() {
    // Don't fire a burst of alerts for history the moment the page loads.
    if (Date.now() - addonBoot < 4000) return;

    flights.forEach(function (f) {
      if (!stillNeedsCart(f)) {
        delete lastOverdue[f.id];
        return;
      }
      var m = minutesToDeadline(f);
      if (m == null) return;

      // Stop nagging about something that has clearly already gone.
      var etd = parseTimeToMinutes(f.eta || f.sched);
      if (etd != null && etd - nowMinutes() < -5) return;

      for (var i = 0; i < WARN_AT.length; i++) {
        var threshold = WARN_AT[i];
        var key = f.id + ":" + threshold;
        if (m <= threshold && !fired[key]) {
          fired[key] = true;
          alertBanner(f, Math.max(0, Math.round(m)));
          chime();
          if (threshold === 0) {
            notify("CARTS OUT NOW — " + f.flight, "Gate " + (f.gate || "?") + " · pier " + (f.pierSide || "?"));
          }
          break;
        }
      }

      if (m < 0) {
        var last = lastOverdue[f.id] || 0;
        if (Date.now() - last > OVERDUE_REPEAT_MS) {
          lastOverdue[f.id] = Date.now();
          alertBanner(f, m);
          chime();
          notify(
            "OVERDUE " + fmtMinutes(Math.abs(m)) + " — " + f.flight,
            "Carts should already be at gate " + (f.gate || "?"),
          );
        }
      }
    });
  }

  /* ── the standing next-out bar ─────────────────────────────────────────── */

  function renderBar() {
    var el = document.getElementById("pa-bar");
    if (!el) return;

    var due = flights
      .filter(stillNeedsCart)
      .map(function (f) {
        return { f: f, m: minutesToDeadline(f) };
      })
      .filter(function (x) {
        return x.m != null && x.m > -45 && x.m < 240;
      })
      .sort(function (a, b) {
        return a.m - b.m;
      })
      .slice(0, 4);

    if (due.length === 0) {
      el.innerHTML =
        '<div class="pa-bar-empty">No carts due out in the next four hours.</div>';
      return;
    }

    el.innerHTML =
      '<div class="pa-bar-label">Carts out next</div>' +
      due
        .map(function (x) {
          var cls = x.m <= 0 ? "pa-chip-over" : x.m <= 5 ? "pa-chip-crit" : x.m <= 15 ? "pa-chip-warn" : "";
          return (
            '<div class="pa-chip ' +
            cls +
            '" onclick="openEdit(\'' +
            x.f.id +
            "')\">" +
            '<span class="pa-chip-flt">' +
            esc(x.f.flight) +
            "</span>" +
            '<span class="pa-chip-gate">G' +
            esc(x.f.gate || "?") +
            " · " +
            esc(x.f.pierSide || "?") +
            "</span>" +
            '<span class="pa-chip-time">' +
            (x.m <= 0 ? "GO NOW" : fmtMinutes(x.m)) +
            "</span>" +
            '<span class="pa-chip-by">by ' +
            esc(fmtTime(cartDeadlineMinutes(x.f))) +
            "</span>" +
            "</div>"
          );
        })
        .join("");
  }

  /* ── per-row "carts leave by" badge ────────────────────────────────────
     The board rebuilds #rows wholesale every second, so decorating on a timer
     would flicker. Watching for the replacement and decorating synchronously
     right after it does not. */
  function decorateRows() {
    var rows = document.querySelectorAll("#rows .row[data-id]");
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.querySelector(".pa-cartby")) continue;
      // A flight that has gone, finished or cancelled has no cart deadline
      // left to meet — badging it is noise on an already busy row.
      if (/r-departed|r-complete|r-canceled/.test(row.className)) continue;
      var f = flights.find(function (x) {
        return x.id === row.getAttribute("data-id");
      });
      if (!f) continue;
      var deadline = cartDeadlineMinutes(f);
      if (deadline == null) continue;

      var badge = document.createElement("div");
      var out = cartIsOut(f);
      var m = minutesToDeadline(f);
      badge.className =
        "pa-cartby" +
        (out ? " pa-done" : m != null && m <= 0 ? " pa-over" : m != null && m <= 10 ? " pa-soon" : "");
      badge.innerHTML = out
        ? "CART OUT " + esc(f.cartOutActual || "✓")
        : "CARTS BY " + esc(fmtTime(deadline)) + (m != null ? " · " + (m <= 0 ? "GO" : fmtMinutes(m)) : "");
      row.appendChild(badge);
    }
  }

  var rowsEl = document.getElementById("rows");
  if (rowsEl && "MutationObserver" in window) {
    new MutationObserver(decorateRows).observe(rowsEl, { childList: true });
  }

  /* ── platform sync ─────────────────────────────────────────────────────── */

  var deviceId;
  try {
    deviceId = localStorage.getItem("aus_bagroom_device");
    if (!deviceId) {
      deviceId = "dev-" + Math.random().toString(36).slice(2, 9);
      localStorage.setItem("aus_bagroom_device", deviceId);
    }
  } catch (e) {
    deviceId = "dev-anon";
  }

  function setSyncStatus(text, bad) {
    var el = document.getElementById("pa-sync");
    if (!el) return;
    el.textContent = text;
    el.className = "pa-sync" + (bad ? " pa-sync-bad" : "");
  }

  function syncOps(reason) {
    if (!Array.isArray(flights) || flights.length === 0) return;
    fetch(INGEST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        station: settings.station || "AUS",
        postedAt: new Date().toISOString(),
        device: deviceId,
        reason: reason || "interval",
        flights: flights,
      }),
      keepalive: true,
    })
      .then(function (r) {
        return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status));
      })
      .then(function (j) {
        setSyncStatus(
          "Synced " +
            j.stored +
            " flights · " +
            (j.schedule ? j.schedule.today + " scheduled" : "") +
            " · " +
            new Date().toLocaleTimeString(),
        );
      })
      .catch(function (e) {
        setSyncStatus("Sync failed: " + e.message, true);
      });
  }

  /* Push immediately when a step is recorded — that timestamp is the evidence
     the platform attributes a late departure with, and it should not sit in
     one device's localStorage waiting for the next interval. */
  var _record = window.recordStatusTransition;
  if (typeof _record === "function") {
    window.recordStatusTransition = function (flightId, newStatus, byInitials, empId) {
      _record.apply(this, arguments);
      // Clear the alert state so a cart that just went out stops nagging.
      if (newStatus === "cartOut") {
        delete lastOverdue[flightId];
        WARN_AT.forEach(function (t) {
          fired[flightId + ":" + t] = true;
        });
      }
      setTimeout(function () {
        syncOps("step:" + newStatus);
      }, 250);
    };
  }

  setTimeout(function () {
    syncOps("boot");
  }, 8000);
  setInterval(function () {
    syncOps("interval");
  }, SYNC_MS);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") syncOps("hidden");
  });
  window.addEventListener("pagehide", function () {
    syncOps("pagehide");
  });

  /* ── feed self-configuration ───────────────────────────────────────────── */

  try {
    var stale = settings.feedUrl && /workers\.dev/i.test(settings.feedUrl);
    if (!settings.feedUrl || stale) {
      settings.feedUrl = FEED;
      if (!settings.feedInterval || settings.feedInterval < 30) settings.feedInterval = 120;
      saveSettings();
      var input = document.getElementById("s-feedurl");
      if (input) input.value = settings.feedUrl;
      startFeedPolling();
      fetchLiveFeed();
    }
  } catch (e) {}

  /* ── tow-time editor ───────────────────────────────────────────────────── */

  window.paEditTransit = function () {
    var current = (settings && settings.cartTransit) || DEFAULT_TRANSIT;
    var answer = prompt(
      "Tow time from the bag room to plane side, in minutes, per pier.\n\n" +
        "This sets when carts must leave. Format: A,B,C,D",
      [current.A, current.B, current.C, current.D].join(","),
    );
    if (!answer) return;
    var parts = answer.split(",").map(function (n) {
      return Math.max(1, Math.min(45, parseInt(n, 10) || FALLBACK_TRANSIT));
    });
    settings.cartTransit = { A: parts[0], B: parts[1], C: parts[2], D: parts[3] };
    saveSettings();
    fired = Object.create(null);
    renderBar();
    alert(
      "Tow times saved.\n\nCarts now leave " +
        settings.cartTransit.A +
        "/" +
        settings.cartTransit.B +
        "/" +
        settings.cartTransit.C +
        "/" +
        settings.cartTransit.D +
        " minutes before the bag cutoff on piers A/B/C/D.",
    );
  };


  /* ── station clock guard ───────────────────────────────────────────────
     Every deadline here is computed from the device's own clock against
     schedule times published in station local time. A tablet left on the
     wrong timezone would therefore alert at confidently wrong moments, and
     nothing else in the board would look amiss. Check it once, loudly. */
  var STATION_TZ = "America/Chicago";
  function checkClock() {
    try {
      var now = new Date();
      var stationHour = Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: STATION_TZ,
          hour: "2-digit",
          hour12: false,
        }).format(now),
      ) % 24;
      var stationMinute = Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: STATION_TZ,
          minute: "2-digit",
        }).format(now),
      );
      var deviceMinutes = now.getHours() * 60 + now.getMinutes();
      var stationMinutes = stationHour * 60 + stationMinute;
      var drift = deviceMinutes - stationMinutes;
      if (drift > 720) drift -= 1440;
      if (drift < -720) drift += 1440;

      if (Math.abs(drift) >= 5) {
        var el = document.getElementById("pa-clock-warning");
        if (!el) {
          el = document.createElement("div");
          el.id = "pa-clock-warning";
          el.className = "pa-clockwarn";
          document.body.appendChild(el);
        }
        el.innerHTML =
          "<strong>This device's clock is " +
          fmtMinutes(Math.abs(drift)) +
          " " +
          (drift > 0 ? "ahead of" : "behind") +
          " Austin time.</strong> Every cart deadline and alert on this screen " +
          "will be wrong by that much. Set the device to " +
          STATION_TZ +
          " before working from it.";
      }
    } catch (e) {}
  }
  checkClock();
  setInterval(checkClock, 300000);

  /* ── mount ─────────────────────────────────────────────────────────────── */

  var mount = document.createElement("div");
  mount.innerHTML =
    '<div class="pa-banner" id="pa-banner"></div>' +
    '<div class="pa-barwrap">' +
    '<div class="pa-bar" id="pa-bar"></div>' +
    '<div class="pa-barside">' +
    '<span class="pa-sync" id="pa-sync">Sync pending…</span>' +
    '<button class="pa-gear" onclick="paEditTransit()" title="Set tow time to plane side">⏱ Tow times</button>' +
    "</div>" +
    "</div>";
  document.body.appendChild(mount);

  setInterval(function () {
    renderBar();
    checkAlerts();
  }, 1000);
  renderBar();
  decorateRows();
})();
