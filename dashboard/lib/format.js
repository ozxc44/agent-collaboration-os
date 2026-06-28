// dashboard/lib/format.js
//
// Shared formatting and HTML-escaping helpers for dashboard pages.
// Plain browser global (no ES modules). Populates window.CodexUtils.
// Must load before dashboard/lib/api.js and dashboard/lib/markdown.js because
// the markdown renderer depends on CodexUtils.escapeHtml.
(function () {
  "use strict";
  var C = (window.CodexUtils = window.CodexUtils || {});

  // HTML-escape for element text. Null/undefined → "" (never renders "null").
  C.escapeHtml = function (value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  // HTML-escape plus backtick escaping, for attribute values.
  C.escapeAttr = function (value) {
    return C.escapeHtml(value).replace(/`/g, "&#96;");
  };

  // Human-readable byte size. Empty/NaN input → "". Supports up to GB.
  C.formatBytes = function (bytes) {
    if (bytes == null || bytes === "") return "";
    var n = Number(bytes);
    if (!isFinite(n)) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(1) + " GB";
  };

  // Relative time. lang="en" (default) or "zh". Invalid dates pass through.
  C.formatDate = function (iso, lang) {
    if (!iso) return "";
    var labels = lang === "zh"
      ? { now: "刚刚", min: "分钟前", hour: "小时前", day: "天前" }
      : { now: "just now", min: "min ago", hour: "h ago", day: "days ago" };
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      var now = new Date();
      var diff = now - d;
      if (diff < 60000) return labels.now;
      if (diff < 3600000) return Math.floor(diff / 60000) + " " + labels.min;
      if (diff < 86400000) return Math.floor(diff / 3600000) + " " + labels.hour;
      if (diff < 604800000) return Math.floor(diff / 86400000) + " " + labels.day;
      return d.toLocaleDateString();
    } catch (e) {
      return iso;
    }
  };

  // First 8 chars of an id, coerced to string for safety.
  C.shortId = function (id) {
    return id ? String(id).slice(0, 8) : "";
  };

  // Display label for a project visibility value.
  C.visibilityLabel = function (value) {
    if (value === "public") return "Public";
    if (value === "private") return "Private";
    return value ? String(value) : "Project";
  };
})();
