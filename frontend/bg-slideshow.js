// Background slideshow controller
(function (){
    const defaultImages = [
        'https://images.unsplash.com/photo-1503264116251-35a269479413?auto=format&fit=crop&w=1600&q=60',
        'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1600&q=60',
        'https://images.unsplash.com/photo-1496307042754-b4aa456c4a2d?auto=format&fit=crop&w=1600&q=60',
        'https://images.unsplash.com/photo-1502082553048-f009c37129b9?auto=format&fit=crop&w=1600&q=60',
        'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=1600&q=60'
    ];

    const containerId = 'bg-slideshow';
    const duration = 5000; // 5s per slide

    function ensureContainer() {
        let c = document.getElementById(containerId);
        if (!c) {
            c = document.createElement('div');
            c.id = containerId;
            document.body.insertBefore(c, document.body.firstChild);
        }
        return c;
    }

    function preload(url) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(url);
            img.onerror = () => resolve(url);
            img.src = url;
        });
    }

    function start(images) {
        const imgs = (Array.isArray(images) && images.length) ? images.slice() : defaultImages.slice();
        const container = ensureContainer();
        container.innerHTML = '';

        // create slide elements
        imgs.forEach((u, i) => {
            const s = document.createElement('div');
            s.className = 'slide';
            s.style.backgroundImage = `url('${u}')`;
            if (i === 0) s.classList.add('active');
            container.appendChild(s);
        });

        // preload images then cycle
        Promise.all(imgs.map(preload)).then(() => {
            let idx = 0;
            const slides = Array.from(container.children);
            setInterval(() => {
                const prev = slides[idx];
                prev.classList.remove('active');
                idx = (idx + 1) % slides.length;
                const next = slides[idx];
                next.classList.add('active');
            }, duration);
        }).catch(() => {
            // still start cycling even if preload had issues
            let idx = 0;
            const slides = Array.from(container.children);
            setInterval(() => {
                slides[idx].classList.remove('active');
                idx = (idx + 1) % slides.length;
                slides[idx].classList.add('active');
            }, duration);
        });
    }

    // allow external override
    window.startBackgroundSlideshow = start;

    // automatically start with images from window.SLIDESHOW_IMAGES if provided
    document.addEventListener('DOMContentLoaded', () => {
        start(window.SLIDESHOW_IMAGES || defaultImages);
    });
})();
