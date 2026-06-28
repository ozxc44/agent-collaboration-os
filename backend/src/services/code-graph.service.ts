/**
 * Code graph service — regex-based symbol/dependency extraction (no native deps).
 *
 * Replaces tree-sitter for environments where native compilation isn't available
 * (e.g. slim Docker). Extracts function/class/type signatures, import dependencies,
 * and call-site references from source code. Results are structured JSON suitable
 * for agent queries like "which files define function X" or "what does file Y import".
 */

export interface CodeSymbol {
  name: string;
  type: 'function' | 'class' | 'const' | 'type' | 'interface' | 'method';
  line: number;
  signature: string;
}

export interface CodeFileEntry {
  path: string;
  language: string;
  size_bytes: number;
  symbols: CodeSymbol[];
  imports: string[];
  exports: string[];
}

export interface CodeGraph {
  project_id: string;
  total_files: number;
  files: CodeFileEntry[];
  // Reverse index: symbol name → files that define it
  symbol_index: Record<string, string[]>;
  // Dependency edges: file → files it imports
  dependency_edges: Record<string, string[]>;
}

const EXT_LANG: Record<string, string> = {
  '.ts': 'TypeScript', '.js': 'JavaScript', '.tsx': 'TypeScript', '.jsx': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.rb': 'Ruby',
  '.sh': 'Shell', '.vue': 'Vue', '.svelte': 'Svelte',
};

export function extractSymbols(content: string, language: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (language === 'TypeScript' || language === 'JavaScript') {
      // Functions
      let m = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
      if (m) { symbols.push({ name: m[1], type: 'function', line: i + 1, signature: trimmed.slice(0, 120) }); continue; }
      // Arrow/const functions
      m = trimmed.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/);
      if (m) { symbols.push({ name: m[1], type: 'function', line: i + 1, signature: trimmed.slice(0, 120) }); continue; }
      // Classes
      m = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (m) { symbols.push({ name: m[1], type: 'class', line: i + 1, signature: trimmed.slice(0, 120) }); continue; }
      // Interfaces
      m = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
      if (m) { symbols.push({ name: m[1], type: 'interface', line: i + 1, signature: trimmed.slice(0, 120) }); continue; }
      // Types
      m = trimmed.match(/^(?:export\s+)?type\s+(\w+)\s*=/);
      if (m) { symbols.push({ name: m[1], type: 'type', line: i + 1, signature: trimmed.slice(0, 120) }); continue; }
      // Methods (inside class, indented)
      m = trimmed.match(/^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(\w+)\s*\(/);
      if (m && !['if', 'for', 'while', 'switch', 'catch', 'return', 'const', 'let', 'var'].includes(m[1])) {
        symbols.push({ name: m[1], type: 'method', line: i + 1, signature: trimmed.slice(0, 120) });
        continue;
      }
    } else if (language === 'Python') {
      let m = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
      if (m) { symbols.push({ name: m[1], type: 'function', line: i + 1, signature: trimmed.slice(0, 120) }); continue; }
      m = trimmed.match(/^class\s+(\w+)/);
      if (m) { symbols.push({ name: m[1], type: 'class', line: i + 1, signature: trimmed.slice(0, 120) }); continue; }
    }
  }

  return symbols;
}

export function extractImports(content: string, language: string): string[] {
  const imports: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (language === 'TypeScript' || language === 'JavaScript') {
      // import X from './path'
      let m = trimmed.match(/(?:import|require)\s*\(?\s*['"]([^'"]+)['"]/);
      if (m) { imports.push(m[1]); continue; }
      m = trimmed.match(/from\s+['"]([^'"]+)['"]/);
      if (m) { imports.push(m[1]); continue; }
    } else if (language === 'Python') {
      let m = trimmed.match(/^(?:from\s+([\w.]+)\s+)?import\s+(.+)/);
      if (m) {
        const mod = m[1] || m[2].trim().split(/\s+as\s+/)[0].trim();
        imports.push(mod);
        continue;
      }
    }
  }

  return imports.slice(0, 30); // cap
}

export function buildCodeGraph(
  projectId: string,
  files: Array<{ path: string; content: string; sizeBytes: number }>,
): CodeGraph {
  const entries: CodeFileEntry[] = [];
  const symbolIndex: Record<string, string[]> = {};
  const depEdges: Record<string, string[]> = {};

  for (const f of files) {
    const ext = '.' + (f.path.split('.').pop() || '').toLowerCase();
    const language = EXT_LANG[ext] || 'Unknown';
    if (language === 'Unknown') continue;

    const symbols = extractSymbols(f.content, language);
    const imports = extractImports(f.content, language);
    const exports = symbols.filter((s) => s.type === 'function' || s.type === 'class' || s.type === 'const').map((s) => s.name);

    entries.push({ path: f.path, language, size_bytes: f.sizeBytes, symbols, imports, exports });

    // Build symbol index
    for (const sym of symbols) {
      if (!symbolIndex[sym.name]) symbolIndex[sym.name] = [];
      if (!symbolIndex[sym.name].includes(f.path)) symbolIndex[sym.name].push(f.path);
    }

    // Build dependency edges (resolve relative imports to file paths)
    const resolvedDeps: string[] = [];
    for (const imp of imports) {
      if (imp.startsWith('.') || imp.startsWith('/')) {
        // Relative import — try to resolve
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
        const resolved = (dir + imp).replace(/\.ts$|\.js$|\.py$/, '');
        resolvedDeps.push(resolved);
      } else {
        resolvedDeps.push(imp); // Package import
      }
    }
    depEdges[f.path] = resolvedDeps;
  }

  return {
    project_id: projectId,
    total_files: entries.length,
    files: entries,
    symbol_index: symbolIndex,
    dependency_edges: depEdges,
  };
}
