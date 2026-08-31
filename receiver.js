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

    if (baseConfig === null) {
      baseConfig = Object.assign({}, playerManager.getPlaybackConfig() || new cast.framework.PlaybackConfig());
    }
    const config = Object.assign(new cast.framework.PlaybackConfig(), baseConfig);

    const drmType = String(data.drmType || 'NONE').toUpperCase();
    const licenseUrl = typeof data.licenseUrl === 'string' && data.licenseUrl ? data.licenseUrl : null;
    const shakaConfig = {};

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

// Logged only: the default CAF error screen is the one the viewer should see.
playerManager.addEventListener(cast.framework.events.EventType.ERROR, function (event) {
  console.error('playback error', event.detailedErrorCode, event.error);
});

context.start({
  // shaka on HLS too, so DRM config and the request handlers above work on every stream type.
  useShakaForHls: true,
  // Default idle timeout: a live stream keeps reporting progress and stays alive, a stopped VOD should not.
  disableIdleTimeout: false,
});
