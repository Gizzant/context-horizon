/* Highbeam v4.0 User Guide — Shared Navigation, Theme, Tabs, Copy, Scrollspy & Search */
(function () {
  'use strict';

  var SITE_PAGES = [
    { id: 'index', href: 'index.html', title: 'Overview', group: 'Foundations' },
    { id: 'concepts', href: 'concepts.html', title: 'Core Concepts & Mental Model', group: 'Foundations' },
    { id: 'flight-modes', href: 'flight-modes.html', title: 'Flight Modes & Enforcement', group: 'Foundations' },
    { id: 'surfaces', href: 'surfaces.html', title: 'Antigravity vs. Claude Code', group: 'Foundations' },
    { id: 'glossary', href: 'glossary.html', title: 'Terminology & Glossary', group: 'Foundations' },

    { id: 'installation', href: 'installation.html', title: 'Installation & Migration', group: 'Getting Started' },
    { id: 'tutorials', href: 'tutorials.html', title: 'Hands-On Tutorials', group: 'Getting Started' },

    { id: 'cli-reference', href: 'cli-reference.html', title: 'CLI & Binaries Reference', group: 'Reference' },
    { id: 'commands-skills', href: 'commands-skills.html', title: 'Slash Commands, Skills & Agents', group: 'Reference' },
    { id: 'detectors', href: 'detectors.html', title: 'Detector Catalog (DET-01..32)', group: 'Reference' },
    { id: 'hooks-lifecycle', href: 'hooks-lifecycle.html', title: 'Lifecycle Hooks & Control FSM', group: 'Reference' },
    { id: 'configuration', href: 'configuration.html', title: 'Configuration & Security Sandbox', group: 'Reference' },
    { id: 'mcp-daemon-api', href: 'mcp-daemon-api.html', title: 'MCP, HTTP Daemon & Micro-IPC', group: 'Reference' },

    { id: 'architecture', href: 'architecture.html', title: 'System Architecture & Internals', group: 'Architecture & Ops' },
    { id: 'pro-troubleshooting', href: 'pro-troubleshooting.html', title: 'Pro FinOps & Troubleshooting', group: 'Architecture & Ops' }
  ];

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (_e) { return null; }
  }

  function storageSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch (_e) {}
  }

  /* 1. Theme Management */
  var savedTheme = storageGet('ah_docs_theme');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }

  function currentThemeMode() {
    return document.documentElement.getAttribute('data-theme') || 'auto';
  }

  function cycleTheme(btn) {
    var cur = currentThemeMode();
    var next = cur === 'auto' ? 'light' : (cur === 'light' ? 'dark' : 'auto');
    if (next === 'auto') {
      document.documentElement.removeAttribute('data-theme');
      storageSet('ah_docs_theme', 'auto');
    } else {
      document.documentElement.setAttribute('data-theme', next);
      storageSet('ah_docs_theme', next);
    }
    updateThemeButton(btn);
  }

  function updateThemeButton(btn) {
    if (!btn) return;
    var mode = currentThemeMode();
    var label = mode === 'auto' ? 'Theme: Auto' : (mode === 'light' ? 'Theme: Light' : 'Theme: Dark');
    btn.textContent = label;
    btn.setAttribute('aria-label', 'Switch color theme. Current ' + label);
  }

  /* 2. Render Global Chrome (Header, Sidebar, Prev/Next Pager, Footer, Search Modal) */
  function renderChrome() {
    var pageId = document.body.getAttribute('data-page') || 'index';
    var isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    var shortcutLabel = isMac ? '⌘K' : 'Ctrl+K';

    var headerEl = document.getElementById('site-header');
    if (headerEl) {
      headerEl.innerHTML =
        '<div class="site-header-inner">' +
          '<div class="brand-cluster">' +
            '<button type="button" class="mobile-nav-btn" id="mobile-nav-toggle" aria-label="Toggle navigation menu">' +
              '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 4h12M2 8h12M2 12h12"/></svg>' +
            '</button>' +
            '<a href="index.html" class="brand-link">' +
              '<svg width="24" height="24" viewBox="0 0 128 128" aria-hidden="true">' +
                '<rect width="128" height="128" rx="26" fill="#161618"/>' +
                '<path d="M 22 44 Q 64 96 106 44" fill="none" stroke="#2997FF" stroke-width="8" stroke-linecap="round"/>' +
                '<rect x="24" y="64" width="14" height="18" rx="3" fill="#1A73E8"/>' +
                '<rect x="42" y="64" width="14" height="18" rx="3" fill="#30D158"/>' +
                '<rect x="60" y="64" width="14" height="18" rx="3" fill="#FF453A"/>' +
                '<rect x="78" y="64" width="14" height="18" rx="3" fill="#FF9F0A"/>' +
                '<rect x="96" y="64" width="10" height="18" rx="3" fill="#636366"/>' +
              '</svg>' +
              '<span>Highbeam</span>' +
            '</a>' +
            '<span class="brand-divider">/</span>' +
            '<span class="brand-subtitle">Developer Guide</span>' +
            '<span class="version-pill">ctxtop 4.0</span>' +
          '</div>' +
          '<div class="header-actions">' +
            '<button type="button" class="search-trigger" id="search-open-btn" aria-label="Search documentation">' +
              '<span class="search-trigger-label">Search documentation...</span>' +
              '<span class="search-kbd">' + shortcutLabel + '</span>' +
            '</button>' +
            '<button type="button" class="theme-toggle" id="theme-toggle-btn"></button>' +
          '</div>' +
        '</div>';
    }

    var sidebarEl = document.getElementById('site-sidebar');
    if (sidebarEl) {
      var groups = [];
      var byGroup = {};
      SITE_PAGES.forEach(function (p) {
        if (!byGroup[p.group]) {
          byGroup[p.group] = [];
          groups.push(p.group);
        }
        byGroup[p.group].push(p);
      });

      var navHtml = '';
      groups.forEach(function (g) {
        navHtml += '<div class="nav-group"><p class="nav-group-title">' + g + '</p><ul class="nav-list">';
        byGroup[g].forEach(function (p) {
          var currentAttr = p.id === pageId ? ' aria-current="page"' : '';
          navHtml += '<li class="nav-item"><a href="' + p.href + '"' + currentAttr + '>' + p.title + '</a></li>';
        });
        navHtml += '</ul></div>';
      });
      sidebarEl.innerHTML = navHtml;
    }

    var pagerEl = document.getElementById('chapter-pager');
    if (pagerEl) {
      var idx = SITE_PAGES.findIndex(function (p) { return p.id === pageId; });
      var prev = idx > 0 ? SITE_PAGES[idx - 1] : null;
      var next = idx >= 0 && idx < SITE_PAGES.length - 1 ? SITE_PAGES[idx + 1] : null;
      var pagerHtml = '';
      if (prev) {
        pagerHtml +=
          '<a class="pager-card prev" href="' + prev.href + '">' +
            '<span class="pager-label">Previous</span>' +
            '<span class="pager-title">' + prev.title + '</span>' +
          '</a>';
      } else {
        pagerHtml += '<div></div>';
      }
      if (next) {
        pagerHtml +=
          '<a class="pager-card next" href="' + next.href + '">' +
            '<span class="pager-label">Next</span>' +
            '<span class="pager-title">' + next.title + '</span>' +
          '</a>';
      }
      pagerEl.innerHTML = pagerHtml;
    }

    var footerEl = document.getElementById('doc-footer');
    if (footerEl) {
      footerEl.innerHTML =
        '<span>Highbeam (<code>ctxtop</code> v4.0.0) for Google Antigravity &amp; Claude Code.</span>' +
        '<span>100% Local Read-Only Telemetry &middot; Zero Network Calls &middot; MIT Core</span>';
    }

    /* Search Modal Injection */
    var modalHost = document.createElement('div');
    modalHost.className = 'search-backdrop';
    modalHost.id = 'search-backdrop';
    modalHost.hidden = true;
    modalHost.innerHTML =
      '<div class="search-modal" role="dialog" aria-modal="true" aria-label="Search documentation">' +
        '<div class="search-input-row">' +
          '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4.5 4.5"/></svg>' +
          '<input type="search" class="search-input" id="search-modal-input" placeholder="Search commands, flags, DET-01..32, hooks, config keys..." autocomplete="off" />' +
          '<span class="search-kbd">Esc</span>' +
        '</div>' +
        '<ul class="search-results" id="search-modal-results"></ul>' +
        '<div class="search-footer">' +
          '<span>Use Up/Down arrows to navigate, Enter to open</span>' +
          '<span id="search-count-label">Offline index ready</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modalHost);

    var themeBtn = document.getElementById('theme-toggle-btn');
    updateThemeButton(themeBtn);
    if (themeBtn) {
      themeBtn.addEventListener('click', function () { cycleTheme(themeBtn); });
    }

    var mobileBtn = document.getElementById('mobile-nav-toggle');
    if (mobileBtn) {
      mobileBtn.addEventListener('click', function () {
        document.body.classList.toggle('nav-open');
      });
    }
  }

  /* 3. Right-Rail "On This Page" Scrollspy */
  function setupScrollspy() {
    var tocRail = document.getElementById('site-toc');
    if (!tocRail) return;
    var headings = Array.prototype.slice.call(document.querySelectorAll('.doc-main h2[id], .doc-main h3[id]'));
    if (!headings.length) {
      tocRail.innerHTML = '';
      return;
    }

    var listHtml = '<p class="toc-title">On This Page</p><ul class="toc-list">';
    headings.forEach(function (h) {
      var cls = h.tagName === 'H3' ? ' class="toc-h3"' : '';
      listHtml += '<li' + cls + '><a href="#' + h.id + '" data-toc-link="' + h.id + '">' + h.textContent + '</a></li>';
    });
    listHtml += '</ul>';
    tocRail.innerHTML = listHtml;

    var links = Array.prototype.slice.call(tocRail.querySelectorAll('a[data-toc-link]'));
    function setActive(id) {
      links.forEach(function (a) {
        a.classList.toggle('is-active', a.getAttribute('data-toc-link') === id);
      });
    }

    if ('IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            setActive(entry.target.id);
          }
        });
      }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });

      headings.forEach(function (h) { observer.observe(h); });
      setActive(headings[0].id);
    }
  }

  /* 4. One-Click Copy Buttons on Code Blocks */
  function setupCopyButtons() {
    var blocks = Array.prototype.slice.call(document.querySelectorAll('.code-block'));
    blocks.forEach(function (block) {
      var pre = block.querySelector('pre');
      if (!pre) return;
      var btn = block.querySelector('.copy-btn');
      if (!btn) {
        var header = block.querySelector('.code-header');
        if (!header) {
          header = document.createElement('div');
          header.className = 'code-header';
          header.innerHTML = '<span>Code</span>';
          block.insertBefore(header, pre);
        }
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        header.appendChild(btn);
      }

      btn.addEventListener('click', function () {
        var raw = pre.innerText || pre.textContent || '';
        function markCopied() {
          var prev = btn.textContent;
          btn.textContent = 'Copied';
          btn.setAttribute('data-copied', 'true');
          setTimeout(function () {
            btn.textContent = prev === 'Copied' ? 'Copy' : prev;
            btn.removeAttribute('data-copied');
          }, 1800);
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(raw).then(markCopied).catch(function () {
            fallbackCopy(raw, markCopied);
          });
        } else {
          fallbackCopy(raw, markCopied);
        }
      });
    });
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_e) {}
    document.body.removeChild(ta);
    done();
  }

  /* 5. Interactive Surface Tabs */
  function setupTabs() {
    var tabContainers = Array.prototype.slice.call(document.querySelectorAll('.tabs'));
    var preferredSurface = storageGet('ah_preferred_surface');

    function activateTab(container, targetKey, persist) {
      var buttons = Array.prototype.slice.call(container.querySelectorAll('.tab-btn'));
      var panels = Array.prototype.slice.call(container.querySelectorAll('.tab-panel'));
      var matched = buttons.some(function (b) { return b.getAttribute('data-tab') === targetKey; });
      if (!matched) return;

      buttons.forEach(function (b) {
        var active = b.getAttribute('data-tab') === targetKey;
        b.setAttribute('aria-selected', active ? 'true' : 'false');
        b.tabIndex = active ? 0 : -1;
      });
      panels.forEach(function (p) {
        p.hidden = p.getAttribute('data-panel') !== targetKey;
      });

      if (persist && container.hasAttribute('data-sync-surface')) {
        storageSet('ah_preferred_surface', targetKey);
        tabContainers.forEach(function (other) {
          if (other !== container && other.hasAttribute('data-sync-surface')) {
            activateTab(other, targetKey, false);
          }
        });
      }
    }

    tabContainers.forEach(function (container) {
      var buttons = Array.prototype.slice.call(container.querySelectorAll('.tab-btn'));
      buttons.forEach(function (btn, index) {
        btn.addEventListener('click', function () {
          activateTab(container, btn.getAttribute('data-tab'), true);
        });
        btn.addEventListener('keydown', function (ev) {
          if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
            ev.preventDefault();
            var dir = ev.key === 'ArrowRight' ? 1 : -1;
            var nextIdx = (index + dir + buttons.length) % buttons.length;
            buttons[nextIdx].focus();
            activateTab(container, buttons[nextIdx].getAttribute('data-tab'), true);
          }
        });
      });

      if (preferredSurface && container.hasAttribute('data-sync-surface')) {
        activateTab(container, preferredSurface, false);
      }
    });
  }

  /* 6. Inline Filterable Lists & Tables (Detectors, Glossary, CLI) */
  function setupInlineFilters() {
    var bars = Array.prototype.slice.call(document.querySelectorAll('[data-filter-root]'));
    bars.forEach(function (bar) {
      var targetSelector = bar.getAttribute('data-filter-root');
      var items = Array.prototype.slice.call(document.querySelectorAll(targetSelector));
      var input = bar.querySelector('.filter-input');
      var pills = Array.prototype.slice.call(bar.querySelectorAll('.filter-pill'));
      var countEl = bar.querySelector('.filter-count');
      var activeTag = 'all';

      function apply() {
        var q = input ? input.value.trim().toLowerCase() : '';
        var visible = 0;
        items.forEach(function (el) {
          var tags = (el.getAttribute('data-tags') || '').toLowerCase();
          var text = (el.textContent || '').toLowerCase();
          var tagMatch = activeTag === 'all' || tags.split(/\s+/).indexOf(activeTag) !== -1;
          var qMatch = !q || text.indexOf(q) !== -1;
          var show = tagMatch && qMatch;
          el.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        if (countEl) {
          countEl.textContent = visible + ' of ' + items.length + ' shown';
        }
      }

      if (input) {
        input.addEventListener('input', apply);
      }
      pills.forEach(function (pill) {
        pill.addEventListener('click', function () {
          activeTag = pill.getAttribute('data-tag') || 'all';
          pills.forEach(function (p) {
            p.setAttribute('aria-pressed', p === pill ? 'true' : 'false');
          });
          apply();
        });
      });
      apply();
    });
  }

  /* 7. Instant Cmd+K / Ctrl+K Client-Side Search Modal */
  function setupSearchModal() {
    var backdrop = document.getElementById('search-backdrop');
    var openBtn = document.getElementById('search-open-btn');
    var input = document.getElementById('search-modal-input');
    var resultsEl = document.getElementById('search-modal-results');
    var countLabel = document.getElementById('search-count-label');
    if (!backdrop || !input || !resultsEl) return;

    var selectedIdx = 0;
    var currentMatches = [];

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function openModal() {
      backdrop.hidden = false;
      input.value = '';
      renderResults('');
      setTimeout(function () { input.focus(); }, 10);
    }

    function closeModal() {
      backdrop.hidden = true;
    }

    function scoreEntry(entry, tokens) {
      var title = (entry.title || '').toLowerCase();
      var section = (entry.section || '').toLowerCase();
      var keywords = (entry.keywords || '').toLowerCase();
      var body = (entry.body || '').toLowerCase();
      var total = 0;
      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        var s = 0;
        if (title === t || section === t) s += 60;
        else if (title.indexOf(t) !== -1) s += 30;
        if (section.indexOf(t) !== -1) s += 24;
        if (keywords.indexOf(t) !== -1) s += 20;
        if (body.indexOf(t) !== -1) s += 8;
        if (s === 0) return 0;
        total += s;
      }
      return total;
    }

    function renderResults(query) {
      var index = Array.isArray(window.AH_SEARCH_INDEX) ? window.AH_SEARCH_INDEX : [];
      var trimmed = query.trim().toLowerCase();
      var tokens = trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];

      if (!tokens.length) {
        currentMatches = index.slice(0, 10);
        if (countLabel) countLabel.textContent = index.length + ' indexed sections';
      } else {
        var scored = [];
        index.forEach(function (entry) {
          var sc = scoreEntry(entry, tokens);
          if (sc > 0) scored.push({ entry: entry, score: sc });
        });
        scored.sort(function (a, b) { return b.score - a.score; });
        currentMatches = scored.slice(0, 18).map(function (x) { return x.entry; });
        if (countLabel) countLabel.textContent = scored.length + ' matching sections';
      }

      selectedIdx = 0;
      if (!currentMatches.length) {
        resultsEl.innerHTML = '<li style="padding:18px 14px;color:var(--ink-secondary);font-size:0.88rem;">No matching sections found. Try searching for a command (<code>doctor</code>, <code>init</code>), a detector (<code>DET-08</code>), or a concept (<code>C*</code>, <code>TurnZeroGate</code>).</li>';
        return;
      }

      resultsEl.innerHTML = currentMatches.map(function (m, i) {
        var selClass = i === selectedIdx ? ' class="is-selected"' : '';
        return (
          '<li class="search-result-item">' +
            '<a href="' + escapeHtml(m.href) + '"' + selClass + ' data-res-idx="' + i + '">' +
              '<div class="search-result-meta">' + escapeHtml(m.pageTitle) + '</div>' +
              '<div class="search-result-title">' + escapeHtml(m.section || m.title) + '</div>' +
              '<div class="search-result-snippet">' + escapeHtml(m.body) + '</div>' +
            '</a>' +
          '</li>'
        );
      }).join('');
    }

    function updateSelection(delta) {
      var links = Array.prototype.slice.call(resultsEl.querySelectorAll('a[data-res-idx]'));
      if (!links.length) return;
      selectedIdx = (selectedIdx + delta + links.length) % links.length;
      links.forEach(function (a, i) {
        a.classList.toggle('is-selected', i === selectedIdx);
      });
      if (links[selectedIdx] && links[selectedIdx].scrollIntoView) {
        links[selectedIdx].scrollIntoView({ block: 'nearest' });
      }
    }

    if (openBtn) openBtn.addEventListener('click', openModal);
    backdrop.addEventListener('click', function (ev) {
      if (ev.target === backdrop) closeModal();
    });
    input.addEventListener('input', function () {
      renderResults(input.value);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); updateSelection(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); updateSelection(-1); }
      else if (ev.key === 'Enter') {
        var links = resultsEl.querySelectorAll('a[data-res-idx]');
        if (links[selectedIdx]) {
          ev.preventDefault();
          var targetHref = links[selectedIdx].getAttribute('href');
          closeModal();
          window.location.href = targetHref;
        }
      }
    });

    document.addEventListener('keydown', function (ev) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        if (backdrop.hidden) openModal();
        else closeModal();
      } else if (ev.key === 'Escape' && !backdrop.hidden) {
        ev.preventDefault();
        closeModal();
      }
    });
  }

  function initSite() {
    renderChrome();
    setupScrollspy();
    setupCopyButtons();
    setupTabs();
    setupInlineFilters();
    setupSearchModal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSite);
  } else {
    initSite();
  }
})();
