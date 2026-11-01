(() => {
  'use strict';
  const arrivals = new Map();
  const findCard = id => Array.from(document.querySelectorAll('.task-card')).find(card => card.dataset.id === id);

  function flyIn(id, list, source) {
    const card = findCard(id);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!card || !source || document.hidden || reduced?.matches || typeof card.animate !== 'function') return;

    const destination = card.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    // Very tall cards stay within their scrolling list instead of flying outside it.
    if (destination.width <= 0 || destination.height <= 0 || destination.top < viewport.top - 1 || destination.bottom > viewport.bottom + 1) return;

    const flight = document.createElement('div');
    const face = card.cloneNode(true);
    flight.className = 'task-flight';
    flight.setAttribute('aria-hidden', 'true');
    flight.inert = true;
    face.className = `task-flight-card ${card.closest('[data-quadrant]').dataset.quadrant}`;
    face.removeAttribute('data-id');
    face.removeAttribute('draggable');
    Object.assign(flight.style, {
      left: `${destination.left}px`, top: `${destination.top}px`,
      width: `${destination.width}px`, height: `${destination.height}px`
    });
    flight.append(face);

    const dx = source.left + Math.min(source.width / 2, 180) - (destination.left + destination.width / 2);
    const dy = source.top + source.height / 2 - (destination.top + destination.height / 2);
    const duration = Math.min(680, Math.max(420, 380 + Math.hypot(dx, dy) * .22));
    const scrollTop = list.scrollTop;
    let horizontal, vertical, timeout, cleaned = false;
    const cleanup = (land = false) => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timeout);
      horizontal?.cancel(); vertical?.cancel();
      flight.remove(); arrivals.delete(id);
      list.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onInterrupt);
      document.removeEventListener('visibilitychange', onVisibility);
      reduced?.removeEventListener?.('change', onInterrupt);
      const current = findCard(id);
      for (const node of new Set([card, current])) {
        if (node) { node.classList.remove('is-arriving'); node.inert = false; }
      }
      if (land && current?.isConnected && !reduced?.matches) {
        current.animate([
          { transform: 'scale(.992, 1.012)' },
          { transform: 'scale(1)' }
        ], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished.catch(() => {});
      }
    };
    const onInterrupt = () => cleanup();
    const onVisibility = () => { if (document.hidden) cleanup(); };
    const onScroll = () => { if (Math.abs(list.scrollTop - scrollTop) > 1) cleanup(); };

    try {
      arrivals.get(id)?.cancel();
      arrivals.set(id, { card, cancel: onInterrupt });
      card.classList.add('is-arriving'); card.inert = true;
      document.body.append(flight);
      // Independent continuous easing on each axis gives the path a gentle curve.
      horizontal = flight.animate([
        { transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }
      ], { duration, easing: 'cubic-bezier(.22,.75,.22,1)', fill: 'both' });
      horizontal.finished.catch(() => {});
      vertical = face.animate([
        { transform: `translateY(${dy}px) scale(.82,.86)`, opacity: .6 },
        { transform: 'translateY(0) scale(1)', opacity: 1 }
      ], { duration, easing: 'cubic-bezier(.18,.6,.2,1)', fill: 'both' });
      vertical.finished.catch(() => {});
      list.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onInterrupt);
      document.addEventListener('visibilitychange', onVisibility);
      reduced?.addEventListener?.('change', onInterrupt);
      timeout = setTimeout(() => cleanup(), duration + 250);
      Promise.all([horizontal.finished, vertical.finished]).then(() => cleanup(true), () => cleanup());
    } catch {
      cleanup();
    }
  }

  window.workboardMotion = Object.freeze({
    flyIn,
    isArriving: id => arrivals.has(id),
    synchronize() {
      for (const arrival of arrivals.values()) if (!arrival.card.isConnected) arrival.cancel();
    }
  });
})();
