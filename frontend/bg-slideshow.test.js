import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const allOk = () => Promise.resolve(true);
const allBad = () => Promise.resolve(false);

// bg-slideshow.js is a classic script (loaded via <script src>), so it has no
// ESM exports. Re-importing it re-runs the IIFE and re-publishes on window.
async function loadModule() {
    vi.resetModules();
    await import('./bg-slideshow.js');
    return {
        createBackgroundSlideshow: window.createBackgroundSlideshow,
        startBackgroundSlideshow: window.startBackgroundSlideshow,
        getBackgroundSlideshow: window.getBackgroundSlideshow,
    };
}

function activeIndexes() {
    return [...document.querySelectorAll('#bg-slideshow .slide')]
        .map((s, i) => (s.classList.contains('active') ? i : -1))
        .filter((i) => i !== -1);
}

function slides() {
    return [...document.querySelectorAll('#bg-slideshow .slide')];
}

describe('bg-slideshow', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '<div id="bg-slideshow" aria-hidden="true"></div>';
        window.__BG_SLIDESHOW_DISABLE_AUTOSTART__ = true;
        window.SLIDESHOW_IMAGES = ['a.jpg', 'b.jpg', 'c.jpg'];
    });

    afterEach(() => {
        vi.useRealTimers();
        delete window.__BG_SLIDESHOW_DISABLE_AUTOSTART__;
        delete window.SLIDESHOW_IMAGES;
        delete window.startBackgroundSlideshow;
        delete window.createBackgroundSlideshow;
        delete window.getBackgroundSlideshow;
    });

    describe('rendering', () => {
        it('renders one slide per image and activates the first', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg', 'c.jpg'], loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            expect(slides()).toHaveLength(3);
            expect(activeIndexes()).toEqual([0]);
        });

        it('sets the background image on each slide', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg'], loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            expect(slides().map((s) => s.style.backgroundImage))
                .toEqual(['url("a.jpg")', 'url("b.jpg")']);
        });

        it('creates the container with aria-hidden when it is missing from the DOM', async () => {
            document.body.innerHTML = '';
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({ images: ['a.jpg'], loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            const container = document.getElementById('bg-slideshow');
            expect(container).not.toBeNull();
            expect(container.getAttribute('aria-hidden')).toBe('true');
        });

        it('does not reuse a stale timer when start() is called repeatedly', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            const show = createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg', 'c.jpg'], loadImage: allOk });
            show.start();
            show.start();
            show.start();
            await vi.advanceTimersByTimeAsync(0);

            // Exactly one interval means one advance, not three.
            await vi.advanceTimersByTimeAsync(5000);
            expect(activeIndexes()).toEqual([1]);
        });
    });

    describe('cycling', () => {
        it('advances once per duration', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg', 'c.jpg'], loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            await vi.advanceTimersByTimeAsync(5000);
            expect(activeIndexes()).toEqual([1]);
            await vi.advanceTimersByTimeAsync(5000);
            expect(activeIndexes()).toEqual([2]);
        });

        it('honours a custom duration', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg'], duration: 1200, loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            await vi.advanceTimersByTimeAsync(600);
            expect(activeIndexes()).toEqual([0]);
            await vi.advanceTimersByTimeAsync(600);
            expect(activeIndexes()).toEqual([1]);
        });

        it('wraps from the last slide back to the first', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg', 'c.jpg'], loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            await vi.advanceTimersByTimeAsync(15000);
            expect(activeIndexes()).toEqual([0]);
        });

        it('keeps exactly one slide active at all times', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg', 'c.jpg'], loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            for (let i = 0; i < 5; i += 1) {
                await vi.advanceTimersByTimeAsync(5000);
                expect(activeIndexes()).toHaveLength(1);
            }
        });

        it('does not flash when only one image is usable', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            const show = createBackgroundSlideshow({ images: ['a.jpg'], loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            await vi.advanceTimersByTimeAsync(20000);
            expect(activeIndexes()).toEqual([0]);
        });

        it('starts cycling immediately rather than waiting on preloads', async () => {
            // A loader that never settles models a stalled network request.
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg', 'c.jpg'], loadImage: () => new Promise(() => {}) }).start();

            await vi.advanceTimersByTimeAsync(5000);
            expect(activeIndexes()).toEqual([1]);
            await vi.advanceTimersByTimeAsync(5000);
            expect(activeIndexes()).toEqual([2]);
        });
    });

    describe('manual navigation', () => {
        it('next and prev move one slide and wrap', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            const show = createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg', 'c.jpg'], loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            show.next();
            expect(show.index).toBe(1);
            show.next();
            expect(show.index).toBe(2);
            show.next();
            expect(show.index).toBe(0);
            show.prev();
            expect(show.index).toBe(2);
        });

        it('show() normalises out-of-range indexes', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            const show = createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg', 'c.jpg'], loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            expect(show.show(7)).toBe(1);
            expect(show.show(-1)).toBe(2);
        });
    });

    describe('image validation', () => {
        it('drops images that fail to load and keeps the working ones', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({
                images: ['ok1.jpg', 'broken.jpg', 'ok2.jpg'],
                loadImage: (url) => Promise.resolve(!url.includes('broken')),
            }).start();
            await vi.advanceTimersByTimeAsync(0);

            expect(slides().map((s) => s.style.backgroundImage))
                .toEqual(['url("ok1.jpg")', 'url("ok2.jpg")']);
        });

        it('hides the container when every image is broken', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({ images: ['x.jpg', 'y.jpg'], loadImage: allBad }).start();
            await vi.advanceTimersByTimeAsync(0);

            const container = document.getElementById('bg-slideshow');
            expect(slides()).toHaveLength(0);
            expect(container.hidden).toBe(true);
        });

        it('keeps cycling after pruning broken images', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({
                images: ['a.jpg', 'broken.jpg', 'c.jpg'],
                loadImage: (url) => Promise.resolve(!url.includes('broken')),
            }).start();
            await vi.advanceTimersByTimeAsync(0);

            await vi.advanceTimersByTimeAsync(5000);
            expect(activeIndexes()).toEqual([1]);
        });

        it('ignores a stale validation that resolves after a newer start()', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            let releaseSlow = null;
            const slow = new Promise((resolve) => { releaseSlow = resolve; });

            const show = createBackgroundSlideshow({
                images: ['stale-a.jpg', 'stale-b.jpg'],
                loadImage: (url) => (url.startsWith('stale') ? slow : allOk(url)),
            });
            show.start();

            // Swap to a fresh, fully-working list before the first check finishes.
            show.start(['fresh-1.jpg', 'fresh-2.jpg']);
            releaseSlow([true, true]);
            await vi.advanceTimersByTimeAsync(0);

            // The stale run must not prune the new list.
            expect(slides().map((s) => s.style.backgroundImage))
                .toEqual(['url("fresh-1.jpg")', 'url("fresh-2.jpg")']);
            await vi.advanceTimersByTimeAsync(5000);
            expect(activeIndexes()).toEqual([1]);
        });

        it('falls back to the bundled defaults when given no images', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            const show = createBackgroundSlideshow({ loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            expect(show.count).toBe(5);
            expect(slides()[0].style.backgroundImage).toMatch(/^url\("https:\/\/images\.unsplash\.com\//);
        });

        it('de-duplicates and rejects unsafe or non-string entries', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            const show = createBackgroundSlideshow({
                images: ['a.jpg', 'a.jpg', '  a.jpg  ', null, 42, '', 'javascript:alert(1)'],
                loadImage: allOk,
            }).start();
            await vi.advanceTimersByTimeAsync(0);

            expect(slides().map((s) => s.style.backgroundImage)).toEqual(['url("a.jpg")']);
            expect(show.count).toBe(1);
        });
    });

    describe('lifecycle', () => {
        it('stop() halts cycling', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            const show = createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg'], loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            show.stop();
            await vi.advanceTimersByTimeAsync(20000);
            expect(activeIndexes()).toEqual([0]);
            expect(show.running).toBe(false);
        });

        it('destroy() removes the slides and blocks further use', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            const show = createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg'], loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            show.destroy();
            expect(slides()).toHaveLength(0);
            expect(show.disposed).toBe(true);

            show.start();
            await vi.advanceTimersByTimeAsync(0);
            expect(slides()).toHaveLength(0);
        });

        it('restart() swaps the image set', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            const show = createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg'], loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            show.start(['x.jpg', 'y.jpg', 'z.jpg']);
            await vi.advanceTimersByTimeAsync(0);
            expect(show.count).toBe(3);
            expect(activeIndexes()).toEqual([0]);
        });

        it('pauses while the tab is hidden and resumes when visible', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg', 'c.jpg'], loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            Object.defineProperty(document, 'hidden', { value: true, configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(30000);
            expect(activeIndexes()).toEqual([0]);

            Object.defineProperty(document, 'hidden', { value: false, configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(5000);
            expect(activeIndexes()).toEqual([1]);
        });

        it('autoPlay:false renders the first slide without cycling', async () => {
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({ images: ['a.jpg', 'b.jpg', 'c.jpg'], autoPlay: false, loadImage: allOk }).start();
            await vi.advanceTimersByTimeAsync(0);

            await vi.advanceTimersByTimeAsync(30000);
            expect(activeIndexes()).toEqual([0]);
        });
    });

    describe('global entry points', () => {
        it('auto-starts from window.SLIDESHOW_IMAGES', async () => {
            await loadModule();
            window.getBackgroundSlideshow().start();
            await vi.advanceTimersByTimeAsync(0);
            expect(slides().map((s) => s.style.backgroundImage))
                .toEqual(['url("a.jpg")', 'url("b.jpg")', 'url("c.jpg")']);
        });

        it('startBackgroundSlideshow(urls) restarts the shared instance', async () => {
            await loadModule();
            window.startBackgroundSlideshow(['x.jpg', 'y.jpg']);
            await vi.advanceTimersByTimeAsync(0);
            expect(slides()).toHaveLength(2);

            // The shared instance is reused, not duplicated.
            const first = window.getBackgroundSlideshow();
            window.startBackgroundSlideshow(['x.jpg', 'y.jpg']);
            expect(window.getBackgroundSlideshow()).toBe(first);
        });

        it('keeps working when every configured asset is missing', async () => {
            // Mirrors index.html pointing at asset/ files that do not exist.
            window.SLIDESHOW_IMAGES = [
                'asset/dtu-hero (1).jpg',
                'asset/dtu-hero (2).jpg',
                'asset/dtu-hero (3).jpg',
            ];
            const { createBackgroundSlideshow } = await loadModule();
            createBackgroundSlideshow({
                images: () => window.SLIDESHOW_IMAGES,
                loadImage: allBad,
            }).start();
            await vi.advanceTimersByTimeAsync(0);

            const container = document.getElementById('bg-slideshow');
            expect(slides()).toHaveLength(0);
            expect(container.hidden).toBe(true);
        });
    });
});
