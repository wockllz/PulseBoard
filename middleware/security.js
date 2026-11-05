"use strict";
/**
 * Hardened response headers. No extra dependency, applies to every route.
 * CSP allows inline styles/scripts because the dashboards render dynamic UI,
 * but blocks third-party origins and framing.
 */
function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-src 'self' blob:; " +
      "frame-ancestors 'self'; form-action 'self'"
  );
  next();
}

module.exports = { securityHeaders };
