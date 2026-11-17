import { ERROR_CODES, LedgerError } from './errors.mjs';

function parseStringLiteral(expr, startIdx) {
  let j = startIdx + 1;
  let buf = '';
  while (j < expr.length) {
    const ch = expr[j];
    if (ch === '"') {
      return { value: buf, nextIndex: j + 1 };
    }
    if (ch === '\\') {
      j += 1;
      if (j >= expr.length) {
        throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, 'Unterminated escape sequence in string literal');
      }
      const esc = expr[j];
      if (esc === '\\') {
        buf += '\\';
        j += 1;
      } else if (esc === '"') {
        buf += '"';
        j += 1;
      } else if (esc === 'n') {
        buf += '\n';
        j += 1;
      } else if (esc === 't') {
        buf += '\t';
        j += 1;
      } else if (esc === 'u') {
        if (expr[j + 1] === '{') {
          const closeIdx = expr.indexOf('}', j + 2);
          if (closeIdx === -1) {
            throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, 'Unterminated \\u{...} escape sequence');
          }
          const hex = expr.slice(j + 2, closeIdx);
          if (!/^[0-9A-Fa-f]{1,6}$/.test(hex)) {
            throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Invalid unicode escape \\u{${hex}}`);
          }
          const cp = Number.parseInt(hex, 16);
          if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
            throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Invalid or surrogate unicode code point: ${hex}`);
          }
          buf += String.fromCodePoint(cp);
          j = closeIdx + 1;
        } else {
          const hex = expr.slice(j + 1, j + 5);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
            throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Invalid \\uXXXX escape: ${hex}`);
          }
          const cp = Number.parseInt(hex, 16);
          if (cp >= 0xd800 && cp <= 0xdfff) {
            throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Lone surrogate code point disallowed: ${hex}`);
          }
          buf += String.fromCodePoint(cp);
          j += 5;
        }
      } else {
        throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Unknown string escape \\${esc}`);
      }
      continue;
    }
    buf += ch;
    j += 1;
  }
  throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, 'Unterminated string literal');
}

/**
 * Tokenizes a filter expression into typed tokens.
 *
 * @param {string} expr
 * @returns {Array<{ type: string, value: any }>}
 */
export function tokenizeDsl(expr) {
  if (typeof expr !== 'string' || !expr.trim()) {
    throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, 'Filter expression must be a non-empty string');
  }
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ type: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      const parsed = parseStringLiteral(expr, i);
      tokens.push({ type: 'STRING', value: parsed.value });
      i = parsed.nextIndex;
      continue;
    }
    const two = expr.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '>=' || two === '<=' || two === '~=') {
      tokens.push({ type: 'OP', value: two });
      i += 2;
      continue;
    }
    if (ch === '>' || ch === '<') {
      tokens.push({ type: 'OP', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const m = /^-?\d+(?:\.\d+)?/.exec(expr.slice(i));
      if (m) {
        tokens.push({ type: 'NUMBER', value: Number(m[0]) });
        i += m[0].length;
        continue;
      }
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(expr.slice(i));
    if (ident) {
      const word = ident[0];
      const upper = word.toUpperCase();
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT' || upper === 'IN') {
        tokens.push({ type: upper, value: upper });
      } else if (upper === 'TRUE' || upper === 'FALSE') {
        tokens.push({ type: 'BOOLEAN', value: upper === 'TRUE' });
      } else if (upper === 'NULL') {
        tokens.push({ type: 'NULL', value: null });
      } else {
        tokens.push({ type: 'IDENT', value: word });
      }
      i += word.length;
      continue;
    }
    throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Unexpected character: ${ch}`);
  }
  return tokens;
}

function resolveField(obj, pathStr) {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = String(pathStr).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = Object.prototype.hasOwnProperty.call(cur, part) ? cur[part] : undefined;
  }
  return cur;
}

function normalizeLiteralValue(val) {
  return typeof val === 'string' ? val.normalize('NFC') : val;
}

function isLiteralToken(tok) {
  return Boolean(tok && ['STRING', 'NUMBER', 'BOOLEAN', 'NULL'].includes(tok.type));
}

/**
 * Compiles a filter expression string into `(event) => boolean`.
 * Operator precedence: `()` > `NOT` > `AND` > `OR`.
 *
 * @param {string} expr
 * @returns {(event: object) => boolean}
 */
export function compileFilter(expr) {
  const tokens = tokenizeDsl(expr);
  let pos = 0;

  function peek() {
    return tokens[pos] || null;
  }

  function consume(expectedType = null) {
    const tok = tokens[pos];
    if (!tok || (expectedType && tok.type !== expectedType)) {
      throw new LedgerError(
        ERROR_CODES.ERR_DSL_SYNTAX,
        `Expected ${expectedType || 'token'}, got ${tok ? tok.type : 'EOF'}`
      );
    }
    pos += 1;
    return tok;
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, 'Unexpected end of filter');
    if (tok.type === '(') {
      consume('(');
      const inner = parseOr();
      consume(')');
      return inner;
    }

    const fieldTok = consume('IDENT');
    const nextTok = peek();
    if (!nextTok) {
      throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Expected operator after ${fieldTok.value}`);
    }

    if (nextTok.type === 'IN') {
      consume('IN');
      consume('(');
      const listValues = [];
      const firstVal = consume();
      if (!isLiteralToken(firstVal)) {
        throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Unexpected literal in IN list: ${firstVal.type}`);
      }
      listValues.push(normalizeLiteralValue(firstVal.value));
      while (peek() && peek().type === ',') {
        consume(',');
        const item = consume();
        if (!isLiteralToken(item)) {
          throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Unexpected literal in IN list: ${item.type}`);
        }
        listValues.push(normalizeLiteralValue(item.value));
      }
      consume(')');

      const targetSet = new Set(listValues);
      return (evt) => {
        const actual = resolveField(evt, fieldTok.value);
        if (actual === undefined) return false;
        return targetSet.has(normalizeLiteralValue(actual));
      };
    }

    const opTok = consume('OP');
    const valTok = consume();
    if (!isLiteralToken(valTok)) {
      throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Unexpected literal token: ${valTok.type}`);
    }

    const targetNorm = normalizeLiteralValue(valTok.value);
    const targetLower = typeof targetNorm === 'string' ? targetNorm.toLowerCase() : null;

    return (evt) => {
      const actual = resolveField(evt, fieldTok.value);
      const actualNorm = normalizeLiteralValue(actual);
      switch (opTok.value) {
        case '==':
          return actualNorm === targetNorm;
        case '!=':
          return actual !== undefined && actualNorm !== targetNorm;
        case '~=':
          return (
            typeof actualNorm === 'string' &&
            targetLower !== null &&
            actualNorm.toLowerCase() === targetLower
          );
        case '>':
          if (typeof actual === 'number' && typeof targetNorm === 'number') {
            return Number.isFinite(actual) && actual > targetNorm;
          }
          if (typeof actualNorm === 'string' && typeof targetNorm === 'string') {
            return actualNorm > targetNorm;
          }
          return false;
        case '>=':
          if (typeof actual === 'number' && typeof targetNorm === 'number') {
            return Number.isFinite(actual) && actual >= targetNorm;
          }
          if (typeof actualNorm === 'string' && typeof targetNorm === 'string') {
            return actualNorm >= targetNorm;
          }
          return false;
        case '<':
          if (typeof actual === 'number' && typeof targetNorm === 'number') {
            return Number.isFinite(actual) && actual < targetNorm;
          }
          if (typeof actualNorm === 'string' && typeof targetNorm === 'string') {
            return actualNorm < targetNorm;
          }
          return false;
        case '<=':
          if (typeof actual === 'number' && typeof targetNorm === 'number') {
            return Number.isFinite(actual) && actual <= targetNorm;
          }
          if (typeof actualNorm === 'string' && typeof targetNorm === 'string') {
            return actualNorm <= targetNorm;
          }
          return false;
        default:
          return false;
      }
    };
  }

  function parseNot() {
    if (peek() && peek().type === 'NOT') {
      consume('NOT');
      const inner = parseNot();
      return (evt) => !inner(evt);
    }
    return parsePrimary();
  }

  function parseAnd() {
    let left = parseNot();
    while (peek() && peek().type === 'AND') {
      consume('AND');
      const right = parseNot();
      const prevLeft = left;
      left = (evt) => prevLeft(evt) && right(evt);
    }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().type === 'OR') {
      consume('OR');
      const right = parseAnd();
      const prevLeft = left;
      left = (evt) => prevLeft(evt) || right(evt);
    }
    return left;
  }

  const fn = parseOr();
  if (pos !== tokens.length) {
    throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Unexpected trailing token ${tokens[pos].value}`);
  }
  return fn;
}
