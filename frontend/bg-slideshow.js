// Background slideshow controller
//
// Renders a crossfading set of full-screen background images behind the page
// content. Loaded as a classic deferred script from index.html, so it exposes
// itself on `window` rather than as an ES module.
//
//   window.startBackgroundSlideshow([...urls])  -> start/restart with new images
//   window.createBackgroundSlideshow(options)   -> isolated instance
//   window.getBackgroundSlideshow()             -> the auto-started instance
//
// Instances expose: start, stop, destroy, next, prev, show, restart, and the
// read-only index / count / running / duration properties.
(function (global) {
    'use strict';

    const CONTAINER_ID = 'bg-slideshow';
    const SLIDE_CLASS = 'slide';
    const ACTIVE_CLASS = 'active';
    const DEFAULT_DURATION = 5000;
    const MIN_DURATION = 500;
    const IMAGE_TIMEOUT = 10000;
    const UNSAFE_URL = /^\s*(javascript|vbscript|data:text\/html)/i;

    // Used only when the caller supplies no images, or none of them load.
    const FALLBACK_IMAGES = [
        'https://images.unsplash.com/photo-1503264116251-35a269479413?auto=format&fit=crop&w=1600&q=60',
        'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1600&q=60',
        'https://images.unsplash.com/photo-1496307042754-b4aa456c4a2d?auto=format&fit=crop&w=1600&q=60',
        'https://images.unsplash.com/photo-1502082553048-f009c37129b9?auto=format&fit=crop&w=1600&q=60',
        'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=1600&q=60'
    ];

    function sanitize(images) {
        const seen = new Set();
        const out = [];
        if (!Array.isArray(images)) return out;
        images.forEach(function (entry) {
            if (typeof entry !== 'string') return;
            const url = entry.trim();
            if (!url || seen.has(url) || UNSAFE_URL.test(url)) return;
            seen.add(url);
            out.push(url);
        });
        return out;
    }

    function resolveDuration(value) {
        const n = Number(value);
        return Number.isFinite(n) && n >= MIN_DURATION ? n : DEFAULT_DURATION;
    }

    function toCssUrl(url) {
        const escaped = url
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/[\r\n]/g, '');
        return 'url("' + escaped + '")';
    }

    // Resolves true/false. Never rejects, and always settles within
    // IMAGE_TIMEOUT so one stalled request cannot wedge the slideshow.
    function loadImage(url) {
        return new Promise(function (resolve) {
            const img = new Image();
            let timer = null;
            let settled = false;

            function settle(ok) {
                if (settled) return;
                settled = true;
                if (timer !== null) clearTimeout(timer);
                img.onload = null;
                img.onerror = null;
                resolve(ok);
            }

            timer = setTimeout(function () { settle(false); }, IMAGE_TIMEOUT);
            img.onload = function () { settle(true); };
            img.onerror = function () { settle(false); };
            img.src = url;
        });
    }

    function prefersReducedMotion() {
        try {
            return !!global.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (err) {
            return false;
        }
    }

    function createBackgroundSlideshow(options) {
        const opts = options || {};
        const containerId = opts.containerId || CONTAINER_ID;
        const duration = resolveDuration(opts.duration);
        const loader = typeof opts.loadImage === 'function' ? opts.loadImage : loadImage;
        const autoPlay = opts.autoPlay !== false && !prefersReducedMotion();

        let sources = [];
        let slides = [];
        let index = 0;
        let timer = null;
        let running = false;
        let disposed = false;
        let validating = null;
        let validatedGeneration = 0;

        function resolveSources() {
            const provided = typeof opts.images === 'function' ? opts.images() : opts.images;
            const cleaned = sanitize(provided);
            return cleaned.length ? cleaned : FALLBACK_IMAGES.slice();
        }

        function ensureContainer() {
            let container = document.getElementById(containerId);
            if (!container) {
                container = document.createElement('div');
                container.id = containerId;
                document.body.insertBefore(container, document.body.firstChild);
            }
            // Decorative only: keep it out of the accessibility tree.
            container.setAttribute('aria-hidden', 'true');
            return container;
        }

        function clearSlides() {
            const container = document.getElementById(containerId);
            if (!container) return;
            Array.prototype.slice.call(container.children).forEach(function (child) {
                if (child.classList.contains(SLIDE_CLASS)) child.remove();
            });
        }

        function render() {
            const container = ensureContainer();
            slides = sources.map(function (url, i) {
                const slide = document.createElement('div');
                slide.className = SLIDE_CLASS;
                slide.style.backgroundImage = toCssUrl(url);
                if (i === index) slide.classList.add(ACTIVE_CLASS);
                container.appendChild(slide);
                return slide;
            });
            // Hide entirely when nothing is usable so the body gradient shows.
            container.hidden = slides.length === 0;
            return container;
        }

        function show(target) {
            if (slides.length === 0) return index;
            const next = ((target % slides.length) + slides.length) % slides.length;
            if (next === index) return index;
            slides[index].classList.remove(ACTIVE_CLASS);
            index = next;
            slides[index].classList.add(ACTIVE_CLASS);
            return index;
        }

        function next() {
            return slides.length < 2 ? index : show(index + 1);
        }

        function prev() {
            return slides.length < 2 ? index : show(index - 1);
        }

        function clearTimer() {
            if (timer === null) return;
            clearInterval(timer);
            timer = null;
        }

        function startTimer() {
            clearTimer();
            if (disposed || !running || !autoPlay) return;
            if (slides.length < 2) return;
            timer = setInterval(next, duration);
        }

        function handleVisibility() {
            if (document.hidden) clearTimer();
            else startTimer();
        }

        // Drop images that fail to load, then re-render what actually works.
        // Resolves regardless; never rejects.
        function validate() {
            if (validating) return validating;
            const candidates = sources;
            // Bump-proof against a newer start() superseding this run.
            const generation = ++validatedGeneration;
            validating = Promise.all(candidates.map(loader))
                .then(function (results) {
                    if (generation !== validatedGeneration) return;
                    const kept = candidates.filter(function (_, i) { return results[i]; });
                    const current = sources[index];
                    if (kept.length === 0) {
                        clearSlides();
                        slides = [];
                        clearTimer();
                        ensureContainer().hidden = true;
                        return;
                    }
                    sources = kept;
                    index = Math.max(0, kept.indexOf(current));
                    clearSlides();
                    render();
                    startTimer();
                })
                .catch(function () { /* keep the slides we already rendered */ });
            return validating;
        }

        function start(images) {
            if (disposed) return api;
            const cleaned = sanitize(images);
            sources = cleaned.length ? cleaned : resolveSources();
            index = 0;
            validating = null;

            running = true;
            clearTimer();
            clearSlides();
            render();

            document.removeEventListener('visibilitychange', handleVisibility);
            document.addEventListener('visibilitychange', handleVisibility);
            startTimer();
            validate();
            return api;
        }

        function stop() {
            running = false;
            clearTimer();
            document.removeEventListener('visibilitychange', handleVisibility);
            return api;
        }

        function destroy() {
            stop();
            disposed = true;
            clearSlides();
            slides = [];
            return api;
        }

        const api = {
            start: start,
            restart: start,
            stop: stop,
            destroy: destroy,
            next: next,
            prev: prev,
            show: show,
            get index() { return index; },
            get count() { return slides.length; },
            get running() { return running; },
            get disposed() { return disposed; },
            get duration() { return duration; }
        };

        return api;
    }

    let instance = null;

    function getInstance() {
        if (!instance) {
            instance = createBackgroundSlideshow({
                images: function () { return global.SLIDESHOW_IMAGES; }
            });
        }
        return instance;
    }

    // Backwards-compatible entry point: startBackgroundSlideshow([...urls]).
    global.startBackgroundSlideshow = function (images) {
        return getInstance().start(images);
    };

    global.createBackgroundSlideshow = createBackgroundSlideshow;
    global.getBackgroundSlideshow = getInstance;

    if (global.__BG_SLIDESHOW_DISABLE_AUTOSTART__) return;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { getInstance().start(); });
    } else {
        // Deferred scripts run after parsing, so the DOM is already usable.
        getInstance().start();
    }
})(typeof window !== 'undefined' ? window : globalThis);
