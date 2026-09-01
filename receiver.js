'use strict';

const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();

// The browser refuses to set these; one rejected header must not take the whole request down.
const FORBIDDEN_HEADERS = new Set([
  'user-agent', 'referer', 'referrer', 'cookie', 'cookie2', 'host', 'origin',
  'connection', 'content-length', 'accept-encoding', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'via', 'date', 'dnt', 'keep-alive',
]);

// Captured on the first load: cloning from it keeps a previous item's DRM config out of the next one.
let baseConfig = null;

// The sender's subtitle style. CAF does not apply MediaInfo.textTrackStyle by itself when shaka
// renders the cues, so it is re-applied explicitly once each load completes.
let pendingTextStyle = null;

function sanitizeHeaders(headers) {
  const clean = {};
  if (!headers || typeof headers !== 'object') return clean;
  for (const name of Object.keys(headers)) {
    const value = headers[name];
    if (value === null || value === undefined) continue;
    if (FORBIDDEN_HEADERS.has(String(name).toLowerCase())) continue;
    clean[name] = String(value);
  }
  return clean;
}

// Request handlers mutate requestInfo in place; CAF ignores the return value.
function headerApplier(headers) {
  return function (requestInfo) {
    requestInfo.headers = Object.assign({}, requestInfo.headers, headers);
  };
}

function isNonEmptyObject(value) {
  return !!value && typeof value === 'object' && Object.keys(value).length > 0;
}

function enableDebugOverlay() {
  if (typeof cast === 'undefined' || !cast.debug || !cast.debug.CastDebugLogger) return;
  const logger = cast.debug.CastDebugLogger.getInstance();
  logger.setEnabled(true);
  logger.showDebugLogs(true);
}

playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD,
  function (request) {
    if (!request || !request.media) return request;

    // The sender puts everything on MediaInfo.customData; LoadRequestData.customData is the fallback.
    const data = request.media.customData || request.customData || {};

    pendingTextStyle = request.media.textTrackStyle || null;

    if (data.debug === true) enableDebugOverlay();
    debugToSender({
      what: 'load',
      url: String(request.media.contentUrl || request.media.contentId || '').slice(0, 160),
      ctype: request.media.contentType || null,
      stype: request.media.streamType || null,
    });
    // Mixed-content verdict: can this https page fetch a LAN http url at all? One probe says it.
    var probeUrl = String(request.media.contentUrl || request.media.contentId || '');
    if (probeUrl.indexOf('http://') === 0) {
      try {
        fetch(probeUrl, { method: 'GET', headers: { Range: 'bytes=0-1' } }).then(function (r) {
          debugToSender({ what: 'probe', ok: true, status: r.status });
        }).catch(function (e) {
          debugToSender({ what: 'probe', ok: false, err: String(e).slice(0, 200) });
        });
      } catch (e) {
        debugToSender({ what: 'probe', ok: false, err: 'throw ' + String(e).slice(0, 180) });
      }
    }

    if (baseConfig === null) {
      baseConfig = Object.assign({}, playerManager.getPlaybackConfig() || new cast.framework.PlaybackConfig());
    }
    const config = Object.assign(new cast.framework.PlaybackConfig(), baseConfig);

    const drmType = String(data.drmType || 'NONE').toUpperCase();
    const licenseUrl = typeof data.licenseUrl === 'string' && data.licenseUrl ? data.licenseUrl : null;
    // Start high instead of crawling up: live channels were anchoring at the lowest rendition.
    const shakaConfig = { abr: { defaultBandwidthEstimate: 8000000 } };
    // The sender's quality cap: shaka reads restrictions at load, which is why a change reloads.
    if (typeof data.maxHeight === 'number' && data.maxHeight > 0) {
      shakaConfig.abr.restrictions = { maxHeight: data.maxHeight };
    }

    if (isNonEmptyObject(data.clearkeys)) {
      // shaka takes the hex kid -> hex key map verbatim, which is the form the sender already carries.
      shakaConfig.drm = { clearKeys: Object.assign({}, data.clearkeys) };
    } else if (drmType === 'CLEARKEY' && licenseUrl) {
      shakaConfig.drm = { servers: { 'org.w3.clearkey': licenseUrl } };
    } else if (drmType === 'WIDEVINE' && licenseUrl) {
      config.licenseUrl = licenseUrl;
      config.protectionSystem = cast.framework.ContentProtection.WIDEVINE;
    }

    const headers = sanitizeHeaders(data.headers);
    if (Object.keys(headers).length > 0) {
      const apply = headerApplier(headers);
      config.manifestRequestHandler = apply;
      config.segmentRequestHandler = apply;
      config.licenseRequestHandler = apply;
    }

    if (isNonEmptyObject(shakaConfig)) config.shakaConfig = shakaConfig;
    playerManager.setPlaybackConfig(config);

    return request;
  }
);

// --- Quality channel. Where the runtime exposes its inner player the sender gets the REAL variant
// ladder and can cap it live; where it does not, the sender silently falls back to reload-with-cap.
const CHANNEL_NS = 'urn:x-cast:app.mediaclient.cast';

function innerPlayerOrNull() {
  return typeof playerManager.getShakaPlayer === 'function' ? playerManager.getShakaPlayer() : null;
}

function broadcastLevels() {
  const player = innerPlayerOrNull();
  if (!player || typeof player.getVariantTracks !== 'function') return;
  const byHeight = new Map();
  player.getVariantTracks().forEach(function (t) {
    if (!t.height) return;
    const cur = byHeight.get(t.height);
    if (!cur || (t.bandwidth || 0) > cur.bandwidth) {
      byHeight.set(t.height, { height: t.height, width: t.width || 0, bandwidth: t.bandwidth || 0, active: !!t.active });
    } else if (t.active) {
      cur.active = true;
    }
  });
  const levels = Array.from(byHeight.values()).sort(function (a, b) { return b.height - a.height; });
  if (levels.length) context.sendCustomMessage(CHANNEL_NS, undefined, { type: 'levels', levels: levels });
}

playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, broadcastLevels);
playerManager.addEventListener(cast.framework.events.EventType.BITRATE_CHANGED, broadcastLevels);

playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, function () {
  if (!pendingTextStyle) return;
  try {
    playerManager.getTextTracksManager().setTextTrackStyle(pendingTextStyle);
    debugToSender({ what: 'ttstyle', ok: true });
  } catch (e) {
    debugToSender({ what: 'ttstyle', ok: false, err: String(e).slice(0, 160) });
  }
  // The DASH text renderer ignores TextTrackStyle through every sanctioned channel (measured:
  // applied ok, drawn default): CSS with !important is what actually reaches its elements.
  try { applyStyleCss(pendingTextStyle); } catch (e) { debugToSender({ what: 'ttcss', err: String(e).slice(0, 160) }); }
  reportCaptionDom();
});

/** '#RRGGBBAA' (the cast wire form) to rgba(); '#RRGGBB' passes through. */
function cssColor(hash) {
  if (typeof hash !== 'string' || hash[0] !== '#') return null;
  const h = hash.slice(1);
  if (h.length === 6) return hash;
  if (h.length !== 8) return null;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const a = parseInt(h.slice(6, 8), 16) / 255;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(3) + ')';
}

function applyStyleCss(style) {
  const fg = cssColor(style.foregroundColor);
  const bg = cssColor(style.backgroundColor);
  const edgeColor = cssColor(style.edgeColor) || '#000000';
  const type = String(style.edgeType || '').toUpperCase();
  let edge = '';
  if (type === 'OUTLINE' || type === 'RAISED' || type === 'DEPRESSED') {
    edge = 'text-shadow: -1px -1px 0 E, 1px -1px 0 E, -1px 1px 0 E, 1px 1px 0 E !important;'.replace(/E/g, edgeColor);
  } else if (type === 'DROP_SHADOW') {
    edge = 'text-shadow: 2px 2px 3px ' + edgeColor + ' !important;';
  } else if (type === 'NONE') {
    edge = 'text-shadow: none !important;';
  }
  const scale = typeof style.fontScale === 'number' && style.fontScale > 0 ? style.fontScale : 1;
  const bolder = style.fontStyle === 'BOLD' || style.fontStyle === 'BOLD_ITALIC';
  const italic = style.fontStyle === 'ITALIC' || style.fontStyle === 'BOLD_ITALIC';
  const decl =
    (fg ? 'color: ' + fg + ' !important;' : '') +
    (bg ? 'background-color: ' + bg + ' !important;' : '') +
    'font-size: ' + Math.round(scale * 100) + '% !important;' + edge +
    (bolder ? 'font-weight: bold !important;' : '') +
    (italic ? 'font-style: italic !important;' : '');
  const css = 'video::cue { ' + decl + ' }\n' +
    '.shaka-text-container, .shaka-text-container * { ' + decl + ' }';
  const host = document.querySelector('cast-media-player');
  const roots = [document.head];
  if (host && host.shadowRoot) roots.push(host.shadowRoot);
  roots.forEach(function (root, i) {
    let el = root.querySelector('#ttcss' + i);
    if (!el) {
      el = document.createElement('style');
      el.id = 'ttcss' + i;
      root.appendChild(el);
    }
    el.textContent = css;
  });
  debugToSender({ what: 'ttcss', ok: true, shadow: !!(host && host.shadowRoot) });
}

// The caption DOM as it really is, reported once the cues are on screen: the next hunt starts from
// facts instead of guessed class names.
function reportCaptionDom() {
  setTimeout(function () {
    try {
      const found = [];
      const scan = function (root) {
        root.querySelectorAll('*').forEach(function (el) {
          const c = String(el.className || '');
          if (/text|caption|subtitle|cue/i.test(c) && found.length < 12) {
            found.push(el.tagName + '.' + c.slice(0, 60));
          }
        });
      };
      scan(document);
      const host = document.querySelector('cast-media-player');
      if (host && host.shadowRoot) scan(host.shadowRoot);
      debugToSender({ what: 'capdom', found: found });
    } catch (e) {
      debugToSender({ what: 'capdom', err: String(e).slice(0, 120) });
    }
  }, 12000);
}

// Bumped on every deploy: Pages caches ~10 min, and without this the sender log cannot say
// WHICH receiver actually ran — that ambiguity already cost one round of debugging.
const RECEIVER_V = 7;

// The receiver's own eyes, sent to the sender: devtools is not reachable on every device.
function debugToSender(payload) {
  try { context.sendCustomMessage(CHANNEL_NS, undefined, Object.assign({ type: 'debug', v: RECEIVER_V }, payload)); } catch (e) {}
}

// Life of a load, event by event: where a silent black screen actually stops is here, not a guess.
var seenEvents = {};
[
  'PLAYER_LOAD_COMPLETE', 'LOADED_METADATA', 'LOADED_DATA', 'CAN_PLAY', 'PLAYING',
  'WAITING', 'BUFFERING', 'STALLED', 'SUSPEND', 'RATE_CHANGE', 'PAUSE',
].forEach(function (name) {
  var type = cast.framework.events.EventType[name];
  if (!type) return;
  playerManager.addEventListener(type, function () {
    seenEvents[name] = (seenEvents[name] || 0) + 1;
    if (seenEvents[name] > 3) return;
    var stats = null;
    try { var st = playerManager.getStats(); stats = st.width + 'x' + st.height + '@' + Math.round(st.streamBandwidth / 1000) + 'k'; } catch (e) {}
    debugToSender({ what: 'ev', ev: name, n: seenEvents[name], stats: stats });
  });
});
playerManager.addEventListener(cast.framework.events.EventType.MEDIA_STATUS, function (event) {
  var state = event.mediaStatus && event.mediaStatus.playerState;
  if (state && state !== seenEvents._lastState) {
    seenEvents._lastState = state;
    debugToSender({ what: 'state', state: state });
  }
});

context.addCustomMessageListener(CHANNEL_NS, function (event) {
  const data = event.data || {};
  if (data.type !== 'cap') return;
  const player = innerPlayerOrNull();
  if (!player || typeof player.configure !== 'function') return;
  const h = Number(data.maxHeight) || 0;
  // Restrictions ONLY, nothing clever: the variant jump with a cleared buffer, its safeMargin
  // variant and the edge seek all wedged the box's pipeline on BUFFERING+PAUSE (measured). The
  // sender now applies a cap by reloading; this stays for senders already installed.
  player.configure({ abr: { restrictions: { maxHeight: h > 0 ? h : Infinity } } });
  setTimeout(broadcastLevels, 1000);
});

// Logged AND reported to the sender: the default CAF error screen stays for the viewer.
playerManager.addEventListener(cast.framework.events.EventType.ERROR, function (event) {
  console.error('playback error', event.detailedErrorCode, event.error);
  var detail = null;
  try { detail = JSON.stringify(event.error).slice(0, 400); } catch (e) {}
  debugToSender({ what: 'error', code: event.detailedErrorCode || 0, reason: event.reason || null, detail: detail });
});

context.start({
  // MPL for HLS, shaka for DASH: measured on a Samsung panel, shaka's TS transmux downloads
  // segments for ever and never produces LOADED_METADATA. The request handlers apply to both
  // players, and every DRM stream here is DASH, which stays on shaka regardless.
  useShakaForHls: false,
  customNamespaces: (function () { const ns = {}; ns[CHANNEL_NS] = cast.framework.system.MessageType.JSON; return ns; })(),
  // Default idle timeout: a live stream keeps reporting progress and stays alive, a stopped VOD should not.
  disableIdleTimeout: false,
});
