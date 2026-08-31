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

// The receiver's own eyes, sent to the sender: devtools is not reachable on every device.
function debugToSender(payload) {
  try { context.sendCustomMessage(CHANNEL_NS, undefined, Object.assign({ type: 'debug' }, payload)); } catch (e) {}
}

context.addCustomMessageListener(CHANNEL_NS, function (event) {
  const data = event.data || {};
  if (data.type !== 'cap') return;
  const player = innerPlayerOrNull();
  if (!player || typeof player.configure !== 'function') return;
  const h = Number(data.maxHeight) || 0;
  // 0 = back to auto. Applies on the next segment: no reload needed on this path.
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
  // shaka on HLS too, so DRM config and the request handlers above work on every stream type.
  useShakaForHls: true,
  customNamespaces: (function () { const ns = {}; ns[CHANNEL_NS] = cast.framework.system.MessageType.JSON; return ns; })(),
  // Default idle timeout: a live stream keeps reporting progress and stays alive, a stopped VOD should not.
  disableIdleTimeout: false,
});
