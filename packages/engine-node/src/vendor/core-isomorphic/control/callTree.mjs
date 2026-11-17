/**
 * @file src/core-isomorphic/control/callTree.mjs
 * Real-Time Call-Tree & Execution Span Tracking (Feature 24).
 *
 * Implements in-process span lifecycle tracking, parent-child call-tree assembly,
 * critical path calculation, ASCII tree rendering, and USTF v1-compliant flamegraph data.
 * Pure ESM with strictly 0 node:* imports adhering to Claude Mod Laws 1–5.
 */

/**
 * Creates an execution span compliant with USTF v1 span schema.
 *
 * @param {object} [options]
 * @returns {object}
 */
export function createSpan(options = {}) {
  const now = typeof options.startTimeMs === 'number'
    ? options.startTimeMs
    : (typeof options.startMs === 'number' ? options.startMs : Date.now());

  const spanId = options.spanId || options.toolCallId || ('span-' + Math.random().toString(36).slice(2, 10));
  const name = options.name || options.toolName || 'anonymous';
  const kind = options.kind || 'tool';
  const parentSpanId = options.parentSpanId !== undefined ? options.parentSpanId : null;

  const durationMs = typeof options.durationMs === 'number'
    ? options.durationMs
    : (typeof options.duration === 'number' ? options.duration : null);

  const endTimeMs = durationMs !== null ? now + durationMs : (options.endTimeMs ?? options.endMs ?? null);

  return {
    spanId,
    parentSpanId,
    kind,
    name,
    startTimeMs: now,
    endTimeMs,
    durationMs,
    status: options.status || 'ok',
    metadata: options.metadata ? { ...options.metadata } : {},
    children: [],
    // Backward compatibility aliases
    toolCallId: spanId,
    toolName: name,
    startMs: now,
    endMs: endTimeMs
  };
}

/**
 * Ends an in-flight execution span and computes its duration.
 *
 * @param {object} span
 * @param {object} [options]
 * @returns {object}
 */
export function endSpan(span, options = {}) {
  if (!span || typeof span !== 'object') return span;

  const end = options.endTimeMs ?? options.endMs ?? (
    typeof options.durationMs === 'number'
      ? (span.startTimeMs + options.durationMs)
      : Date.now()
  );

  const durationMs = typeof options.durationMs === 'number'
    ? Math.max(0, options.durationMs)
    : Math.max(0, Number((end - span.startTimeMs).toFixed(2)));

  span.endTimeMs = end;
  span.endMs = end;
  span.durationMs = durationMs;

  if (options.status) {
    span.status = options.status;
  }
  if (options.error) {
    span.error = String(options.error);
    if (!options.status) span.status = 'error';
  }
  if (options.metadata) {
    span.metadata = { ...span.metadata, ...options.metadata };
  }

  return span;
}

/**
 * Closes any unclosed spans in an array (e.g. at turn completion).
 *
 * @param {Array<object>} spans
 * @param {object} [options]
 * @returns {Array<object>}
 */
export function closeUnclosedSpans(spans, options = {}) {
  if (!Array.isArray(spans)) return [];
  const defaultEndTime = options.endTimeMs ?? Date.now();
  const status = options.status || 'ok';

  for (const span of spans) {
    if (span && typeof span === 'object' && (span.durationMs == null || span.endTimeMs == null)) {
      const fallbackEnd = span.startTimeMs ? Math.max(span.startTimeMs, defaultEndTime) : defaultEndTime;
      endSpan(span, { endTimeMs: fallbackEnd, status });
    }
  }
  return spans;
}

/**
 * Assembles a flat list of spans into a hierarchical tree.
 * Iterative implementation avoids stack overflow even on 50+ nested levels.
 *
 * @param {Array<object>} spans
 * @returns {Array<object>} Root spans with populated .children
 */
export function buildCallTree(spans) {
  if (!Array.isArray(spans) || spans.length === 0) return [];

  const spanMap = new Map();
  const roots = [];

  // Clone spans to avoid mutating original objects
  for (const s of spans) {
    if (!s || typeof s !== 'object') continue;
    const id = s.spanId || s.toolCallId;
    if (!id) continue;
    spanMap.set(id, {
      ...s,
      spanId: id,
      children: []
    });
  }

  for (const node of spanMap.values()) {
    const parentId = node.parentSpanId;
    if (parentId && spanMap.has(parentId)) {
      spanMap.get(parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Computes the critical path duration across sequential and parallel execution spans.
 * Dynamic programming over topological intervals:
 * criticalPath[i] = duration[i] + max({ criticalPath[j] for j where end[j] <= start[i] } union {0})
 *
 * @param {Array<object>} spans
 * @returns {number} Critical path duration in milliseconds
 */
export function computeCriticalPath(spans) {
  if (!Array.isArray(spans) || spans.length === 0) return 0;

  // Filter valid spans and sort by start timestamp
  const normalized = spans
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const start = typeof s.startTimeMs === 'number' ? s.startTimeMs : (typeof s.startMs === 'number' ? s.startMs : 0);
      const dur = typeof s.durationMs === 'number' ? s.durationMs : 0;
      const end = typeof s.endTimeMs === 'number' ? s.endTimeMs : (typeof s.endMs === 'number' ? s.endMs : (start + dur));
      return { start, dur, end };
    })
    .sort((a, b) => a.start - b.start);

  if (normalized.length === 0) return 0;

  const n = normalized.length;
  const cp = new Array(n).fill(0);
  let maxCriticalPath = 0;

  for (let i = 0; i < n; i++) {
    const curr = normalized[i];
    let maxPredecessorCp = 0;

    for (let j = 0; j < i; j++) {
      if (normalized[j].end <= curr.start) {
        if (cp[j] > maxPredecessorCp) {
          maxPredecessorCp = cp[j];
        }
      }
    }

    cp[i] = curr.dur + maxPredecessorCp;
    if (cp[i] > maxCriticalPath) {
      maxCriticalPath = cp[i];
    }
  }

  return maxCriticalPath;
}

/**
 * Renders an ASCII representation of the call tree or USTF trajectory.
 *
 * @param {object|Array} trajectoryOrTree
 * @param {object} [options]
 * @returns {string}
 */
export function renderCallTree(trajectoryOrTree, options = {}) {
  if (!trajectoryOrTree) return '';

  // Case 1: USTF trajectory with turns
  if (trajectoryOrTree.turns && Array.isArray(trajectoryOrTree.turns)) {
    const sessionId = trajectoryOrTree.sessionId || 'session-default';
    const host = trajectoryOrTree.host || 'antigravity';
    let out = `Session: ${sessionId} [${host}]\n`;

    for (let tIdx = 0; tIdx < trajectoryOrTree.turns.length; tIdx++) {
      const turn = trajectoryOrTree.turns[tIdx];
      if (!turn || typeof turn !== 'object') continue;
      const isLastTurn = tIdx === trajectoryOrTree.turns.length - 1;
      const turnDuration = turn.durationMs ?? 0;
      const turnIndex = turn.turnIndex ?? (tIdx + 1);

      out += `└── Turn ${turnIndex} [${turnDuration}ms]\n`;

      const toolSpans = Array.isArray(turn.toolSpans) ? turn.toolSpans : [];
      for (let sIdx = 0; sIdx < toolSpans.length; sIdx++) {
        const s = toolSpans[sIdx];
        if (!s || typeof s !== 'object') continue;
        const isLastSpan = sIdx === toolSpans.length - 1;
        const branch = isLastSpan ? '    └── ' : '    ├── ';
        const name = s.toolName || s.name || 'tool';
        const dur = s.durationMs ?? 0;
        const status = s.status || 'ok';
        out += `${branch}${name} [${dur}ms] (${status})\n`;
      }
    }
    return out;
  }

  // Case 2: Tree of spans (either roots array or single root)
  const roots = Array.isArray(trajectoryOrTree) ? trajectoryOrTree : [trajectoryOrTree];
  let out = '';

  // Iterative DFS stack: { node, depth, isLast, prefix }
  const stack = [];
  for (let i = roots.length - 1; i >= 0; i--) {
    stack.push({ node: roots[i], depth: 0, isLast: i === roots.length - 1, prefix: '' });
  }

  while (stack.length > 0) {
    const { node, depth, isLast, prefix } = stack.pop();
    if (!node || typeof node !== 'object') continue;

    const branch = depth === 0 ? '' : (isLast ? '└── ' : '├── ');
    const name = node.name || node.toolName || 'span';
    const dur = node.durationMs ?? 0;
    const status = node.status ? ` (${node.status})` : '';

    out += `${prefix}${branch}${name} [${dur}ms]${status}\n`;

    const children = Array.isArray(node.children) ? node.children : [];
    const childPrefix = depth === 0 ? '' : (prefix + (isLast ? '    ' : '│   '));

    for (let c = children.length - 1; c >= 0; c--) {
      stack.push({
        node: children[c],
        depth: depth + 1,
        isLast: c === children.length - 1,
        prefix: childPrefix
      });
    }
  }

  return out;
}

/**
 * Builds flamegraph data structure (Speedscope & Chrome Trace format).
 *
 * @param {Array<object>} spans
 * @param {object} [options]
 * @returns {object}
 */
export function buildFlamegraphData(spans, options = {}) {
  if (!Array.isArray(spans) || spans.length === 0) {
    return {
      version: '0.0.1',
      $schema: 'https://www.speedscope.app/file-format-schema.json',
      shared: { frames: [] },
      profiles: []
    };
  }

  const frameMap = new Map();
  const frames = [];

  function getFrameIndex(name) {
    if (frameMap.has(name)) return frameMap.get(name);
    const idx = frames.length;
    frames.push({ name });
    frameMap.set(name, idx);
    return idx;
  }

  let minTime = Infinity;
  let maxTime = 0;
  const events = [];

  for (const s of spans) {
    if (!s || typeof s !== 'object') continue;
    const name = s.name || s.toolName || 'tool';
    const frameIdx = getFrameIndex(name);
    const start = typeof s.startTimeMs === 'number' ? s.startTimeMs : (typeof s.startMs === 'number' ? s.startMs : 0);
    const dur = typeof s.durationMs === 'number' ? s.durationMs : 0;
    const end = typeof s.endTimeMs === 'number' ? s.endTimeMs : (typeof s.endMs === 'number' ? s.endMs : (start + dur));

    if (start < minTime) minTime = start;
    if (end > maxTime) maxTime = end;

    events.push({ type: 'O', frame: frameIdx, at: start });
    events.push({ type: 'C', frame: frameIdx, at: end });
  }

  // Sort events chronologically, close events before open at same timestamp
  events.sort((a, b) => (a.at === b.at ? (a.type === 'C' ? -1 : 1) : a.at - b.at));

  return {
    version: '0.0.1',
    $schema: 'https://www.speedscope.app/file-format-schema.json',
    shared: { frames },
    profiles: [
      {
        type: 'evented',
        name: options.name || 'Highbeam Call-Tree',
        unit: 'milliseconds',
        startValue: minTime === Infinity ? 0 : minTime,
        endValue: maxTime,
        events
      }
    ]
  };
}
