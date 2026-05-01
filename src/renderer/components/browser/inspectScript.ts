// Element-picker script injected into the webview via
// `webview.executeJavaScript()`. Activates a hover-outline overlay and a
// one-shot click handler that captures a structured fingerprint of the
// clicked element. Esc cancels and resolves null.
//
// The fingerprint is what an AI coding agent actually needs to grep the
// codebase: selector, ARIA role + accessible name (Playwright-style),
// data-testid, classes, ancestors, plus a tiny subset of computed styles
// and the element's own outerHTML. Mirrors Chrome DevTools MCP's
// "snapshot over screenshot" guidance: structured grep targets, not raw
// rendered HTML.

export interface PickedElement {
  selector: string;
  tagName: string;
  id?: string;
  classes: string[];
  testId?: string;
  ariaLabel?: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  rect: { x: number; y: number; width: number; height: number };
  computedStyles: Record<string, string>;
  outerHTML: string;
  ancestors: Array<{
    tagName: string;
    id?: string;
    classes: string[];
    testId?: string;
    role?: string;
  }>;
}

export const INSPECT_SCRIPT = `
(function () {
  return new Promise((resolve) => {
    if (window.__kangenticInspectActive) {
      resolve(null);
      return;
    }
    window.__kangenticInspectActive = true;

    // Remove any prior persistent pick highlight - the new inspect replaces it.
    document.querySelectorAll('[data-kangentic-pick]').forEach((el) => el.remove());

    const overlay = document.createElement('div');
    overlay.setAttribute('data-kangentic-inspector', '1');
    overlay.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483647',
      'border:2px solid #ff3b3b',
      'background:rgba(255,59,59,0.12)',
      'box-sizing:border-box',
      'top:0',
      'left:0',
      'width:0',
      'height:0',
      'transition:top 30ms ease-out,left 30ms ease-out,width 30ms ease-out,height 30ms ease-out',
    ].join(';');
    document.documentElement.appendChild(overlay);

    function isOurOverlay(el) {
      return el && el.hasAttribute && el.hasAttribute('data-kangentic-inspector');
    }

    const ROLE_MAP = {
      a: 'link', button: 'button', img: 'img',
      h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
      nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
      aside: 'complementary', section: 'region', article: 'article',
      ul: 'list', ol: 'list', li: 'listitem',
      table: 'table', tr: 'row', td: 'cell', th: 'columnheader',
      form: 'form', select: 'combobox', textarea: 'textbox',
    };

    function getRole(el) {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'submit' || t === 'button') return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        return 'textbox';
      }
      return ROLE_MAP[tag];
    }

    function getAccessibleName(el) {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const target = document.getElementById(labelledBy);
        if (target && target.textContent) return target.textContent.trim();
      }
      const alt = el.getAttribute('alt');
      if (alt) return alt.trim();
      const title = el.getAttribute('title');
      if (title) return title.trim();
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder.trim();
      const text = (el.textContent || '').trim();
      if (text) return text.length > 100 ? text.slice(0, 100) + '...' : text;
      return '';
    }

    function buildSelector(el) {
      if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
      const segments = [];
      let current = el;
      while (current && current !== document.body && segments.length < 5) {
        const tag = current.tagName.toLowerCase();
        let segment = tag;
        const testId = current.getAttribute('data-testid') || current.getAttribute('data-test-id');
        if (current.id) {
          segment = tag + '#' + current.id;
          segments.unshift(segment);
          break;
        } else if (testId) {
          segment += '[data-testid="' + testId + '"]';
        } else if (current.classList && current.classList.length) {
          segment += '.' + Array.from(current.classList).slice(0, 2).join('.');
        }
        segments.unshift(segment);
        current = current.parentElement;
      }
      return segments.join(' > ');
    }

    function captureFingerprint(el) {
      const computed = window.getComputedStyle(el);
      const STYLE_KEYS = [
        'display', 'position', 'color', 'backgroundColor', 'fontSize',
        'fontFamily', 'fontWeight', 'lineHeight', 'width', 'height',
        'margin', 'padding', 'border', 'borderRadius', 'opacity', 'zIndex',
      ];
      const computedStyles = {};
      for (const key of STYLE_KEYS) {
        computedStyles[key] = computed[key];
      }
      const rect = el.getBoundingClientRect();
      const ancestors = [];
      let parent = el.parentElement;
      while (parent && parent !== document.body && ancestors.length < 4) {
        ancestors.push({
          tagName: parent.tagName,
          id: parent.id || undefined,
          classes: Array.from(parent.classList || []),
          testId: parent.getAttribute('data-testid') || parent.getAttribute('data-test-id') || undefined,
          role: parent.getAttribute('role') || undefined,
        });
        parent = parent.parentElement;
      }
      return {
        selector: buildSelector(el),
        tagName: el.tagName,
        id: el.id || undefined,
        classes: Array.from(el.classList || []),
        testId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        role: getRole(el),
        accessibleName: getAccessibleName(el),
        text: (el.textContent || '').trim().slice(0, 200),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        computedStyles,
        outerHTML: (el.outerHTML || '').slice(0, 800),
        ancestors,
      };
    }

    function cleanup() {
      window.__kangenticInspectActive = false;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      try { overlay.remove(); } catch (e) { /* ignore */ }
    }

    // Convert the hover overlay into a persistent pick indicator so the user
    // sees what they selected. Different color so it's clear this isn't the
    // active hover anymore. Inspect listeners are detached, but new
    // scroll/resize listeners track the element's live position so the
    // overlay follows scrolling/reflow until cleared.
    function persistPick(targetEl) {
      window.__kangenticInspectActive = false;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      overlay.removeAttribute('data-kangentic-inspector');
      overlay.setAttribute('data-kangentic-pick', '1');
      overlay.style.borderColor = '#3b82f6';
      overlay.style.background = 'rgba(59, 130, 246, 0.12)';
      overlay.style.transition = 'none';

      function syncRect() {
        if (!targetEl.isConnected) {
          // Element removed from DOM (SPA route, react re-render). Drop the
          // overlay rather than stranding it at stale coordinates.
          syncTeardown();
          try { overlay.remove(); } catch (_) { /* ignore */ }
          return;
        }
        var rect = targetEl.getBoundingClientRect();
        overlay.style.top = rect.top + 'px';
        overlay.style.left = rect.left + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
      }

      function syncTeardown() {
        window.removeEventListener('scroll', syncRect, true);
        window.removeEventListener('resize', syncRect);
        if (resizeObserver) resizeObserver.disconnect();
      }

      // Stash the teardown callback on the overlay so CLEAR_PICK_SCRIPT can
      // dispose listeners when the pick is cleared from React.
      overlay.__kangenticPickTeardown = syncTeardown;

      // capture: true so we observe scrolls in any nested scrollable
      // ancestor (Chromium dispatches scroll events on the scrollable
      // element, not bubbling). resize handles viewport changes.
      window.addEventListener('scroll', syncRect, true);
      window.addEventListener('resize', syncRect);

      // ResizeObserver catches in-place layout changes (font load, image
      // load, content edits) without scroll/resize.
      // var (not let): hoisting puts the declaration above syncTeardown so
      // its closure can reference resizeObserver before this assignment.
      var resizeObserver = null;
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(syncRect);
        resizeObserver.observe(targetEl);
      }

      syncRect();
    }

    function onMove(event) {
      const target = event.target;
      if (!target || isOurOverlay(target)) return;
      const rect = target.getBoundingClientRect();
      overlay.style.top = rect.top + 'px';
      overlay.style.left = rect.left + 'px';
      overlay.style.width = rect.width + 'px';
      overlay.style.height = rect.height + 'px';
    }

    function onClick(event) {
      const target = event.target;
      if (!target || isOurOverlay(target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      const fingerprint = captureFingerprint(target);
      persistPick(target);
      resolve(fingerprint);
    }

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup();
        resolve(null);
      }
    }

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
})();
`;

/** Removes any persistent pick indicator left in the page by INSPECT_SCRIPT,
 *  including its scroll/resize listeners. */
export const CLEAR_PICK_SCRIPT = `
document.querySelectorAll('[data-kangentic-pick]').forEach((el) => {
  if (typeof el.__kangenticPickTeardown === 'function') {
    try { el.__kangenticPickTeardown(); } catch (_) { /* ignore */ }
  }
  el.remove();
});
`;
