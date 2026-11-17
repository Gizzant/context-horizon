import { ERROR_CODES, LedgerError } from './errors.mjs';

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
      let j = i + 1;
      let buf = '';
      while (j < expr.length) {
        if (expr[j] === '"' && expr[j - 1] !== '\\') break;
        buf += expr[j];
        j += 1;
      }
      if (j >= expr.length) {
        throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, 'Unterminated string literal');
      }
      tokens.push({ type: 'STRING', value: buf });
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
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
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

/**
 * Compiles a filter expression string into `(event) => boolean`.
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
      const inner = parseExpr();
      consume(')');
      return inner;
    }
    if (tok.type === 'NOT') {
      consume('NOT');
      const inner = parsePrimary();
      return (evt) => !inner(evt);
    }
    const fieldTok = consume('IDENT');
    const opTok = consume('OP');
    const valTok = consume();
    if (!['STRING', 'NUMBER', 'BOOLEAN', 'NULL'].includes(valTok.type)) {
      throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Unexpected literal token: ${valTok.type}`);
    }
    const target = valTok.value;
    return (evt) => {
      const actual = resolveField(evt, fieldTok.value);
      switch (opTok.value) {
        case '==': return actual === target;
        case '!=': return actual !== target;
        case '>': return actual > target;
        case '>=': return actual >= target;
        case '<': return actual < target;
        case '<=': return actual <= target;
        default: return false;
      }
    };
  }

  function parseExpr() {
    let left = parsePrimary();
    while (peek() && (peek().type === 'AND' || peek().type === 'OR')) {
      const op = consume().type;
      const right = parsePrimary();
      const prevLeft = left;
      left = op === 'AND'
        ? (evt) => prevLeft(evt) && right(evt)
        : (evt) => prevLeft(evt) || right(evt);
    }
    return left;
  }

  const fn = parseExpr();
  if (pos !== tokens.length) {
    throw new LedgerError(ERROR_CODES.ERR_DSL_SYNTAX, `Unexpected trailing token ${tokens[pos].value}`);
  }
  return fn;
}
