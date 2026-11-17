import { ERROR_CODES, LedgerError } from './errors.mjs';

function unescapeString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '\\') {
      if (i + 1 >= raw.length) {
        throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, 'Dangling escape in string literal');
      }
      const next = raw[i + 1];
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === '\\') out += '\\';
      else if (next === '"') out += '"';
      else out += next;
      i += 1;
    } else {
      out += raw[i];
    }
  }
  return out;
}

/**
 * Tokenizes a filter expression into typed tokens.
 *
 * @param {string} expr
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
      let j = i + 1;
      let closed = false;
      while (j < expr.length) {
        if (expr[j] === '\\') {
          j += 2;
          continue;
        }
        if (expr[j] === '"') {
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, 'Unterminated string literal');
      }
      tokens.push({ type: 'STRING', value: unescapeString(expr.slice(i + 1, j)) });
      i = j + 1;
      continue;
    }
    const two = expr.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '>=' || two === '<=') {
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
  const parts = String(pathStr).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function equalsDsl(actual, target) {
  if ((actual === null || actual === undefined) && (target === null || target === undefined)) {
    return true;
  }
  return actual === target;
}

function compareRel(actual, target, op) {
  if (actual === null || actual === undefined || target === null || target === undefined) {
    return false;
  }
  if (typeof actual === 'number' && Number.isNaN(actual)) return false;
  switch (op) {
    case '>': return actual > target;
    case '>=': return actual >= target;
    case '<': return actual < target;
    case '<=': return actual <= target;
    default: return false;
  }
}

/**
 * Compiles a filter expression string into `(event) => boolean`.
 * Precedence: () > NOT > AND > OR.
 *
 * @param {string} expr
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

  function consumeLiteral() {
    const tok = consume();
    if (!['STRING', 'NUMBER', 'BOOLEAN', 'NULL'].includes(tok.type)) {
      throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Unexpected literal token: ${tok.type}`);
    }
    return tok.value;
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
    if (nextTok && nextTok.type === 'IN') {
      consume('IN');
      consume('(');
      if (peek()?.type === ')') {
        throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, 'Empty IN () list is not allowed');
      }
      const listVals = [consumeLiteral()];
      while (peek()?.type === ',') {
        consume(',');
        listVals.push(consumeLiteral());
      }
      consume(')');
      return (evt) => {
        const actual = resolveField(evt, fieldTok.value);
        return listVals.some((v) => equalsDsl(actual, v));
      };
    }

    const opTok = consume('OP');
    const target = consumeLiteral();
    return (evt) => {
      const actual = resolveField(evt, fieldTok.value);
      if (opTok.value === '==') return equalsDsl(actual, target);
      if (opTok.value === '!=') return !equalsDsl(actual, target);
      return compareRel(actual, target, opTok.value);
    };
  }

  function parseNot() {
    if (peek()?.type === 'NOT') {
      consume('NOT');
      const inner = parseNot();
      return (evt) => !inner(evt);
    }
    return parsePrimary();
  }

  function parseAnd() {
    let left = parseNot();
    while (peek()?.type === 'AND') {
      consume('AND');
      const right = parseNot();
      const prev = left;
      left = (evt) => prev(evt) && right(evt);
    }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (peek()?.type === 'OR') {
      consume('OR');
      const right = parseAnd();
      const prev = left;
      left = (evt) => prev(evt) || right(evt);
    }
    return left;
  }

  const fn = parseOr();
  if (pos !== tokens.length) {
    throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Unexpected trailing token ${tokens[pos].value}`);
  }
  return fn;
}
