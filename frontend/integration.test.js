import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const readIndex = () => readFileSync(path.join(here, 'index.html'), 'utf8');

// The slideshow was originally blank because index.html hardcoded image paths
// that did not exist in frontend/asset. Keep those two lists from drifting.
describe('index.html slideshow wiring', () => {
    function configuredImages() {
        const block = readIndex().match(/window\.SLIDESHOW_IMAGES\s*=\s*\[([\s\S]*?)\]/);
        expect(block, 'index.html must define window.SLIDESHOW_IMAGES').not.toBeNull();
        return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    }

    it('lists at least one image', () => {
        expect(configuredImages().length).toBeGreaterThan(0);
    });

    it('points at files that actually exist in frontend/asset', () => {
        const missing = configuredImages().filter((p) => !existsSync(path.join(here, p)));
        expect(missing, `missing image files: ${missing.join(', ')}`).toEqual([]);
    });

    it('points at non-empty files', () => {
        const empty = configuredImages().filter((p) => statSync(path.join(here, p)).size === 0);
        expect(empty, `zero-byte image files: ${empty.join(', ')}`).toEqual([]);
    });

    it('renders the container div and loads the script', () => {
        const html = readIndex();
        expect(html).toMatch(/<div id="bg-slideshow"/);
        expect(html).toMatch(/<script src="bg-slideshow\.js" defer><\/script>/);
        // The image list must be assigned before the deferred script reads it.
        expect(html.indexOf('window.SLIDESHOW_IMAGES'))
            .toBeLessThan(html.indexOf('<script src="bg-slideshow.js" defer>'));
    });
});

// Simulates the real index.html load order: container in markup, then a
// deferred bg-slideshow.js, with auto-start ENABLED and no injected loader.
describe('integration: real page load order', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        document.body.innerHTML = '<div id="bg-slideshow" aria-hidden="true"></div>';
    });

    afterEach(() => vi.useRealTimers());

    it('auto-starts on load and exposes the shared instance', async () => {
        window.SLIDESHOW_IMAGES = ['asset/photo_1.jpg', 'asset/photo_2.jpg', 'asset/photo_3.jpg'];
        await import('./bg-slideshow.js');

        const instance = window.getBackgroundSlideshow();
        expect(instance).toBeDefined();
        expect(instance.running).toBe(true);
        expect(instance.count).toBe(3);
        expect(instance.duration).toBe(5000);

        await vi.advanceTimersByTimeAsync(5000);
        const active = [...document.querySelectorAll('#bg-slideshow .slide')]
            .findIndex((s) => s.classList.contains('active'));
        expect(active).toBe(1);

        // Deferred scripts run at readyState "interactive", so the DOMContentLoaded
        // branch must also work. jsdom is already "complete", so exercise it directly.
        document.dispatchEvent(new Event('DOMContentLoaded'));
        expect(window.getBackgroundSlideshow()).toBe(instance);
        expect(instance.running).toBe(true);
    });
});
