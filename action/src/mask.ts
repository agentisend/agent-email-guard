/**
 * One walk over a source file.
 * `code` blanks comments and string data and keeps ${...} / f-string {...} as code,
 * so a send call in a comment or a string is not a call, and line numbers stay put.
 * `surface` blanks comments and keeps string data, for JSON with comments.
 * `modules` are the specifiers of real import / require strings (JS and Go).
 * Python and PHP imports are keywords in `code`, not strings.
 */

export type Lang = 'js' | 'py' | 'php' | 'go';

export type CapturedModule = { spec: string; runtime: boolean };

export function langOf(ext: string): Lang {
  if (ext === '.py') return 'py';
  if (ext === '.php') return 'php';
  if (ext === '.go') return 'go';
  return 'js';
}

export function splitCode(source: string, lang: Lang): { code: string; surface: string; modules: CapturedModule[] } {
  const code = new Array<string>(source.length);
  const surface = new Array<string>(source.length);
  const modules: CapturedModule[] = [];
  let i = 0;
  let goMode: 'none' | 'seek' | 'block' = 'none';
  let goParens = 0;

  const blank = (ch: string) => (ch === '\n' ? '\n' : ' ');

  const setCode = (ch: string) => {
    code[i] = ch;
    surface[i] = ch;
    i += 1;
  };

  const setComment = (ch: string) => {
    const b = blank(ch);
    code[i] = b;
    surface[i] = b;
    i += 1;
  };

  const setString = (ch: string) => {
    code[i] = blank(ch);
    surface[i] = ch;
    i += 1;
  };

  const lineComment = (mark: string) => {
    for (const ch of mark) setComment(ch);
    while (i < source.length && source.charAt(i) !== '\n') setComment(source.charAt(i));
  };

  const blockComment = () => {
    setComment('/');
    setComment('*');
    while (i < source.length && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) {
      setComment(source.charAt(i));
    }
    if (i < source.length) {
      setComment('*');
      setComment('/');
    }
  };

  const previousWord = (index: number): { word: string; throughParen: boolean; at: number } => {
    let j = index - 1;
    while (j >= 0 && /\s/.test(source.charAt(j))) j -= 1;
    let throughParen = false;
    if (source.charAt(j) === '(') {
      throughParen = true;
      j -= 1;
      while (j >= 0 && /\s/.test(source.charAt(j))) j -= 1;
    }
    const end = j + 1;
    while (j >= 0 && /[A-Za-z_$]/.test(source.charAt(j))) j -= 1;
    return { word: source.slice(j + 1, end), throughParen, at: j + 1 };
  };

  const isKeyword = (at: number): boolean => at <= 0 || !/[A-Za-z0-9_$.]/.test(source.charAt(at - 1));

  const typeOnly = (index: number): boolean => {
    const filled = code.slice(0, index).join('');
    const found = [...filled.matchAll(/\bimport\s+type\b|\bexport\s+type\b|\bimport\b|\bexport\b/g)];
    const last = found[found.length - 1];
    if (last === undefined) return false;
    return /\btype\b/.test(last[0]);
  };

  const captureJs = (spec: string, quoteAt: number) => {
    const prev = previousWord(quoteAt);
    if (!isKeyword(prev.at)) return;
    if (prev.word === 'from') {
      modules.push({ spec, runtime: !typeOnly(quoteAt) });
      return;
    }
    if (prev.word === 'require' && prev.throughParen) {
      modules.push({ spec, runtime: true });
      return;
    }
    if (prev.word === 'import') {
      modules.push({ spec, runtime: true });
    }
  };

  const parseQuoted = (quote: string, escapes: boolean, quoteAt: number) => {
    setString(quote);
    let spec = '';
    while (i < source.length) {
      const c = source.charAt(i);
      if (escapes && c === '\\') {
        setString(c);
        if (i < source.length) {
          spec += source.charAt(i);
          setString(source.charAt(i));
        }
        continue;
      }
      if (c === quote) {
        setString(c);
        if (lang === 'js') captureJs(spec, quoteAt);
        if (lang === 'go' && (goMode === 'seek' || goMode === 'block')) {
          modules.push({ spec, runtime: true });
          if (goMode === 'seek') goMode = 'none';
        }
        return;
      }
      spec += c;
      setString(c);
    }
  };

  const parseTemplate = () => {
    setCode('`');
    while (i < source.length) {
      const c = source.charAt(i);
      if (c === '\\') {
        setString(c);
        if (i < source.length) setString(source.charAt(i));
        continue;
      }
      if (c === '`') {
        setCode('`');
        return;
      }
      if (c === '$' && source.charAt(i + 1) === '{') {
        setCode('$');
        setCode('{');
        parseCode('}');
        if (i < source.length && source.charAt(i) === '}') setCode('}');
        continue;
      }
      setString(c);
    }
  };

  const pythonPrefix = (quoteAt: number): string => {
    let j = quoteAt - 1;
    let prefix = '';
    while (j >= 0 && /[rRuUbBfF]/.test(source.charAt(j))) {
      prefix = source.charAt(j) + prefix;
      j -= 1;
    }
    return prefix;
  };

  const parsePyString = (quote: string, triple: boolean, fstring: boolean, raw: boolean) => {
    const open = triple ? quote + quote + quote : quote;
    for (const ch of open) setString(ch);
    while (i < source.length) {
      const c = source.charAt(i);
      if (!raw && c === '\\') {
        setString(c);
        if (i < source.length) setString(source.charAt(i));
        continue;
      }
      if (fstring && c === '{') {
        if (source.charAt(i + 1) === '{') {
          setString('{');
          setString('{');
          continue;
        }
        setCode('{');
        parseCode('}');
        if (i < source.length && source.charAt(i) === '}') setCode('}');
        continue;
      }
      if (fstring && c === '}' && source.charAt(i + 1) === '}') {
        setString('}');
        setString('}');
        continue;
      }
      if (c === quote) {
        if (!triple) {
          setString(quote);
          return;
        }
        if (source.charAt(i + 1) === quote && source.charAt(i + 2) === quote) {
          setString(quote);
          setString(quote);
          setString(quote);
          return;
        }
      }
      setString(c);
    }
  };

  const peekWord = (index: number): string => {
    let j = index;
    if (!/[A-Za-z_]/.test(source.charAt(j))) return '';
    const start = j;
    while (j < source.length && /[A-Za-z0-9_]/.test(source.charAt(j))) j += 1;
    return source.slice(start, j);
  };

  const parseCode = (stop?: string): void => {
    while (i < source.length) {
      const c = source.charAt(i);
      const next = source.charAt(i + 1);
      if (stop !== undefined && c === stop) return;

      if ((lang === 'py' || lang === 'php') && c === '#') {
        lineComment('#');
        continue;
      }
      if (lang !== 'py' && c === '/' && next === '/') {
        lineComment('//');
        continue;
      }
      if (lang !== 'py' && c === '/' && next === '*') {
        blockComment();
        continue;
      }

      if (lang === 'go' && goMode !== 'none' && (c === '"' || c === '`')) {
        parseQuoted(c, c === '"', i);
        continue;
      }
      if (lang === 'go' && goMode === 'seek' && c === '(') {
        setCode(c);
        goMode = 'block';
        goParens = 1;
        continue;
      }
      if (lang === 'go' && goMode === 'block' && c === '(') {
        setCode(c);
        goParens += 1;
        continue;
      }
      if (lang === 'go' && goMode === 'block' && c === ')') {
        setCode(c);
        goParens -= 1;
        if (goParens === 0) goMode = 'none';
        continue;
      }

      if (lang === 'py' && (c === "'" || c === '"')) {
        const prefix = pythonPrefix(i);
        const triple = next === c && source.charAt(i + 2) === c;
        parsePyString(c, triple, /f/i.test(prefix), /r/i.test(prefix));
        continue;
      }

      if ((lang === 'js' || lang === 'php') && (c === "'" || c === '"')) {
        parseQuoted(c, true, i);
        continue;
      }

      if (lang === 'js' && c === '`') {
        parseTemplate();
        continue;
      }

      if (lang === 'go' && c === '"') {
        parseQuoted(c, true, i);
        continue;
      }
      if (lang === 'go' && c === '`') {
        parseQuoted(c, false, i);
        continue;
      }

      if (lang === 'go' && goMode === 'none' && peekWord(i) === 'import' && (i === 0 || !/[A-Za-z0-9_]/.test(source.charAt(i - 1)))) {
        const word = peekWord(i);
        for (const ch of word) setCode(ch);
        goMode = 'seek';
        continue;
      }

      setCode(c);
    }
  };

  parseCode();

  for (let n = 0; n < source.length; n += 1) {
    if (code[n] === undefined || surface[n] === undefined) throw new Error('splitCode left a hole');
  }
  const text = code.join('');
  const surfaceText = surface.join('');
  if (text.length !== source.length || surfaceText.length !== source.length) {
    throw new Error('splitCode changed the file length');
  }
  return { code: text, surface: surfaceText, modules };
}
