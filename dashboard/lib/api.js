// dashboard/lib/api.js
//
// Shared HTTP and base-URL helpers for dashboard pages.
// Plain browser global (no ES modules). Populates window.CodexUtils.
// Depends only on window.CodexUtils being defined (format.js first is fine).
(function () {
  "use strict";
  var C = (window.CodexUtils = window.CodexUtils || {});

  // Normalise a base URL: trim and strip trailing slashes.
  C.normalizeBaseUrl = function (value) {
    var fallback = window.location.origin + "/agent";
    return String(value || fallback).trim().replace(/\/+$/, "");
  };

  // Standard JSON request headers, with a Bearer token when a JWT is supplied.
  C.authHeaders = function (jwt) {
    var headers = { "Content-Type": "application/json" };
    if (jwt) headers.Authorization = "Bearer " + jwt;
    return headers;
  };

  // Core request helper. Returns parsed JSON (or { detail: text } for non-JSON
  // bodies). Throws an Error carrying .status and .payload on non-2xx responses.
  // `body` is optional and JSON-encoded when provided.
  C.api = function (baseUrl, jwt, method, path, body) {
    var base = C.normalizeBaseUrl(baseUrl);
    var options = { method: method, headers: C.authHeaders(jwt), cache: "no-store" };
    if (body !== undefined) options.body = JSON.stringify(body);
    return fetch(base + path, options).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch (e) {
            payload = { detail: text };
          }
        }
        if (!response.ok) {
          var err = new Error("HTTP " + response.status + ": " + ((payload && payload.detail) || ""));
          err.status = response.status;
          err.payload = payload;
          throw err;
        }
        return payload;
      });
    });
  };

  // Coerce an API payload to an array (bare array, or { data: [...] }).
  C.collection = function (payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.data)) return payload.data;
    return [];
  };
})();
