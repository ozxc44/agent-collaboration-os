// dashboard/lib/markdown.js
//
// Shared allowlist-safe Markdown renderer for dashboard pages.
// Plain browser global (no ES modules). Populates window.CodexUtils.
// Depends on CodexUtils.escapeHtml (format.js), which must load first.
(function () {
  "use strict";
  var C = (window.CodexUtils = window.CodexUtils || {});

  // Allowed URL schemes for links and images in rendered markdown.
  var SAFE_LINK_SCHEMES = /^(https?|mailto):/i;
  var SAFE_IMG_SCHEMES = /^(https?|data:image\/(?!svg))/i;

  function isRelative(s) {
    // No colon before the first slash (e.g. "about.md"), or an explicit
    // relative prefix ("/x", "./x", "../x").
    return /^[^:]*$/.test(s) || s.charAt(0) === "/" || s.slice(0, 2) === "./" || s.slice(0, 3) === "../";
  }

  // True for link hrefs that are safe to render (relative or allowlisted scheme).
  C.isSafeLinkUrl = function (url) {
    if (!url) return false;
    var raw = String(url).trim();
    var s = raw.toLowerCase();
    if (isRelative(s)) return true;
    return SAFE_LINK_SCHEMES.test(raw);
  };

  // True for image srcs that are safe to render (allowlisted scheme).
  C.isSafeImgSrc = function (url) {
    if (!url) return false;
    var raw = String(url).trim();
    var s = raw.toLowerCase();
    if (isRelative(s)) return true;
    return SAFE_IMG_SCHEMES.test(raw);
  };

  // Inline markdown: code, emphasis, links, images. Input is escaped first.
  C.inlineMarkdown = function (text) {
    var s = C.escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (m, alt, url) {
      if (C.isSafeImgSrc(url)) return '<img src="' + url + '" alt="' + alt + '" style="max-width:100%">';
      return '<span style="color:var(--bad);font-size:12px;">[blocked image]</span>';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, label, url) {
      if (C.isSafeLinkUrl(url)) return '<a href="' + url + '" target="_blank" rel="noopener">' + label + "</a>";
      return '<span style="color:var(--bad);font-size:12px;">[blocked link]</span>';
    });
    return s;
  };

  // Block-aware markdown: headings, hr, blockquote, lists, fenced code, paragraphs.
  C.simpleMarkdown = function (text) {
    if (!text) return "";
    var lines = text.split("\n");
    var out = [];
    var inCodeBlock = false;
    var codeContent = [];
    var inList = false;
    var listType = "";
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.match(/^```/)) {
        if (inCodeBlock) {
          out.push("<pre><code>" + C.escapeHtml(codeContent.join("\n")) + "</code></pre>");
          codeContent = [];
          inCodeBlock = false;
        } else {
          if (inList) { out.push("</" + listType + ">"); inList = false; }
          inCodeBlock = true;
        }
        continue;
      }
      if (inCodeBlock) { codeContent.push(line); continue; }
      var hMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (hMatch) {
        if (inList) { out.push("</" + listType + ">"); inList = false; }
        out.push("<h" + hMatch[1].length + ">" + C.inlineMarkdown(hMatch[2]) + "</h" + hMatch[1].length + ">");
        continue;
      }
      if (line.match(/^[-*_]{3,}\s*$/)) {
        if (inList) { out.push("</" + listType + ">"); inList = false; }
        out.push("<hr>");
        continue;
      }
      var bqMatch = line.match(/^>\s?(.*)$/);
      if (bqMatch) {
        if (inList) { out.push("</" + listType + ">"); inList = false; }
        out.push("<blockquote>" + C.inlineMarkdown(bqMatch[1]) + "</blockquote>");
        continue;
      }
      var ulMatch = line.match(/^[\-\*]\s+(.+)$/);
      if (ulMatch) {
        if (!inList || listType !== "ul") {
          if (inList) out.push("</" + listType + ">");
          out.push("<ul>");
          inList = true;
          listType = "ul";
        }
        out.push("<li>" + C.inlineMarkdown(ulMatch[1]) + "</li>");
        continue;
      }
      var olMatch = line.match(/^\d+\.\s+(.+)$/);
      if (olMatch) {
        if (!inList || listType !== "ol") {
          if (inList) out.push("</" + listType + ">");
          out.push("<ol>");
          inList = true;
          listType = "ol";
        }
        out.push("<li>" + C.inlineMarkdown(olMatch[1]) + "</li>");
        continue;
      }
      if (inList) { out.push("</" + listType + ">"); inList = false; }
      if (!line.trim()) continue;
      out.push("<p>" + C.inlineMarkdown(line) + "</p>");
    }
    if (inCodeBlock) out.push("<pre><code>" + C.escapeHtml(codeContent.join("\n")) + "</code></pre>");
    if (inList) out.push("</" + listType + ">");
    return out.join("\n");
  };
})();
