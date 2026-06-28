/**
 * Lightweight code search service — TF-IDF based semantic search (no embedding model needed).
 *
 * Lets agents search "where is the heartbeat logic" or "how does task dispatch work"
 * and get ranked file/symbol matches. Pure JS, zero external dependencies.
 *
 * Not as precise as embedding-based search, but captures keyword + context overlap
 * well enough for "find where X is implemented" queries.
 */

export interface SearchResult {
  path: string;
  score: number;
  matched_symbols: string[];
  snippet: string;
}

export interface CodeSearchResult {
  query: string;
  total_matches: number;
  results: SearchResult[];
}

// Simple tokenizer: lowercase, split on non-alphanumeric, filter stop words.
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'in', 'on',
  'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'up', 'down', 'out',
  'how', 'what', 'where', 'when', 'why', 'which', 'who', 'whom',
  'this', 'that', 'these', 'those', 'i', 'it', 'its', 'or', 'and',
  'not', 'no', 'but', 'if', 'then', 'else', 'so', 'than', 'too', 'very',
]);

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

export function searchCode(
  query: string,
  files: Array<{ path: string; content: string; symbols?: string[] }>,
  limit: number = 10,
): CodeSearchResult {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return { query, total_matches: 0, results: [] };
  }

  // Build per-file token frequency maps.
  const fileTokens: Array<{ path: string; tokens: Map<string, number>; symbols: string[]; content: string }> = [];
  const docFreq: Map<string, number> = new Map(); // token → number of docs containing it

  for (const f of files) {
    const tokens = tokenize(f.content);
    const freq: Map<string, number> = new Map();
    for (const t of tokens) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
    // Also include path tokens (file path is strong signal).
    const pathTokens = tokenize(f.path.replace(/[/\\]/g, ' '));
    for (const pt of pathTokens) {
      freq.set(pt, (freq.get(pt) || 0) + 3); // path tokens weighted higher
    }
    // Include symbol names (strong signal).
    const symNames = (f.symbols || []).map((s) => s.toLowerCase());
    for (const sn of symNames) {
      for (const tok of tokenize(sn)) {
        freq.set(tok, (freq.get(tok) || 0) + 5); // symbol tokens weighted highest
      }
    }
    fileTokens.push({ path: f.path, tokens: freq, symbols: f.symbols || [], content: f.content });
    for (const t of freq.keys()) {
      docFreq.set(t, (docFreq.get(t) || 0) + 1);
    }
  }

  const N = fileTokens.length;
  const results: SearchResult[] = [];

  for (const ft of fileTokens) {
    let score = 0;
    const matchedSymbols: string[] = [];

    for (const qt of queryTokens) {
      const tf = ft.tokens.get(qt) || 0;
      if (tf === 0) continue;
      const df = docFreq.get(qt) || 1;
      // TF-IDF: term frequency * inverse document frequency
      const idf = Math.log(N / df) + 1;
      score += tf * idf;

      // Check if this token matches a symbol name
      for (const sym of ft.symbols) {
        if (sym.toLowerCase().includes(qt)) {
          matchedSymbols.push(sym);
        }
      }
    }

    if (score > 0) {
      // Extract a snippet around the first matched token.
      let snippet = '';
      const lowerContent = ft.content.toLowerCase();
      for (const qt of queryTokens) {
        const idx = lowerContent.indexOf(qt);
        if (idx >= 0) {
          const start = Math.max(0, idx - 50);
          const end = Math.min(ft.content.length, idx + qt.length + 100);
          snippet = '...' + ft.content.slice(start, end).replace(/\n/g, ' ') + '...';
          break;
        }
      }

      results.push({
        path: ft.path,
        score: Math.round(score * 100) / 100,
        matched_symbols: [...new Set(matchedSymbols)].slice(0, 5),
        snippet: snippet.slice(0, 200),
      });
    }
  }

  results.sort((a, b) => b.score - a.score);

  return {
    query,
    total_matches: results.length,
    results: results.slice(0, limit),
  };
}
