/* ============================================================================
 * Friendly ERP — marketing site motion.
 *
 * ~2KB, no dependencies. Three jobs:
 *   1. reveal elements as they scroll into view
 *   2. count stat numbers up when they first appear
 *   3. flag the nav once the page has scrolled
 *
 * Two rules this file must never break:
 *   - Content is NEVER hidden by JS. The CSS hides [data-reveal], and the
 *     no-js/failure path below force-shows everything. A marketing page that
 *     renders blank because a script 404'd is worse than one with no motion.
 *   - prefers-reduced-motion wins. If someone asked their OS for less motion,
 *     we show everything immediately and observe nothing.
 * ==========================================================================*/
(function () {
  'use strict';

  var reduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function showAll() {
    var els = document.querySelectorAll('[data-reveal]');
    for (var i = 0; i < els.length; i++) els[i].classList.add('in');
  }

  // No IntersectionObserver (or motion is unwanted)? Show it all, do nothing else.
  if (reduced || !('IntersectionObserver' in window)) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showAll);
    } else { showAll(); }
    return;
  }

  function init() {
    /* ── 1. Scroll reveals ────────────────────────────────────────────────── */
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);            // one-shot: never re-hide on scroll up
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

    var reveals = document.querySelectorAll('[data-reveal]');
    for (var i = 0; i < reveals.length; i++) {
      // Anything already on screen at load reveals immediately — otherwise the
      // hero would sit invisible until the user scrolls, which looks broken.
      var r = reveals[i].getBoundingClientRect();
      if (r.top < window.innerHeight * 0.9) reveals[i].classList.add('in');
      else io.observe(reveals[i]);
    }

    // Stagger: each child of a group gets an incremental transition-delay.
    var groups = document.querySelectorAll('[data-reveal-group]');
    for (var g = 0; g < groups.length; g++) {
      var kids = groups[g].children;
      for (var k = 0; k < kids.length; k++) kids[k].style.setProperty('--i', k);
    }

    /* ── 2. Count-up stats ────────────────────────────────────────────────── */
    function countUp(el) {
      var target = parseFloat(el.getAttribute('data-count'));
      var suffix = el.getAttribute('data-suffix') || '';
      var decimals = (el.getAttribute('data-decimals') | 0);
      var dur = 1300, t0 = null;

      function frame(ts) {
        if (t0 === null) t0 = ts;
        var p = Math.min((ts - t0) / dur, 1);
        // easeOutExpo — fast start, soft landing. Reads as "settling" rather
        // than a linear odometer.
        var eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
        el.textContent = (target * eased).toFixed(decimals) + suffix;
        if (p < 1) requestAnimationFrame(frame);
        else el.textContent = target.toFixed(decimals) + suffix;
      }
      requestAnimationFrame(frame);
    }

    var counters = document.querySelectorAll('[data-count]');
    if (counters.length) {
      var cio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          countUp(e.target);
          cio.unobserve(e.target);
        });
      }, { threshold: 0.6 });
      for (var c = 0; c < counters.length; c++) cio.observe(counters[c]);
    }

    /* ── 3. Nav shadow on scroll ──────────────────────────────────────────── */
    var nav = document.querySelector('.nav');
    if (nav) {
      var ticking = false;
      var onScroll = function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(function () {
          nav.classList.toggle('scrolled', window.scrollY > 8);
          ticking = false;
        });
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }

    /* ── 4. Cursor-follow glow on cards ───────────────────────────────────── */
    // Pointer-only: a finger has no hover, and tracking touch here would just
    // fight the scroll.
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      document.addEventListener('pointermove', function (e) {
        var card = e.target.closest && e.target.closest('.card');
        if (!card) return;
        var b = card.getBoundingClientRect();
        card.style.setProperty('--mx', ((e.clientX - b.left) / b.width * 100) + '%');
        card.style.setProperty('--my', ((e.clientY - b.top) / b.height * 100) + '%');
      }, { passive: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }

  // Last-resort safety net: if anything above threw, never leave content hidden.
  window.addEventListener('error', showAll);
})();
