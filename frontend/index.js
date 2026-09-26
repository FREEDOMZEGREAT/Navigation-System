
// DTU Campus Navigation System - Frontend JavaScript
class DTUCampusNavigation {
    constructor() {
        this.currentLanguage = localStorage.getItem('preferredLanguage') || 'en';
        this.currentUser = null;
        this.notifications = [];
        this.unreadCount = 0;
        this.trackingMarker = null;
        this.isTracking = false;
        // API base - change to your backend address if different
        // Default backend port set to 5001 (dev server started on 5001 to avoid conflicts).
        this.apiBase = window.API_BASE || 'http://localhost:5000/api';
        this.map = null;
        this.pois = [];
        this.markers = [];
        this.currentRoute = null;
        this.routeLayer = null;
        
        // DTU Campus coordinates (center of the cropped area)
        // Updated to match requested cropped bounds
        this.dtuCoordinates = [11.854665998208764, 38.0421816575306];
        // AR visual tuning defaults
        this.arVisual = {
            horizFov: 60,
            maxDist: 200,
            pathWidth: 6,
            pathColor: getComputedStyle(document.documentElement).getPropertyValue('--ar-path-color') || 'rgba(41,128,185,0.95)',
            pathGlow: getComputedStyle(document.documentElement).getPropertyValue('--ar-path-glow') || 'rgba(41,128,185,0.18)',
            arrowColorFrom: getComputedStyle(document.documentElement).getPropertyValue('--ar-arrow-color-from') || '#fff',
            arrowColorTo: getComputedStyle(document.documentElement).getPropertyValue('--ar-arrow-color-to') || '#ffd54d',
            footprintColor: getComputedStyle(document.documentElement).getPropertyValue('--ar-footprint-color') || 'rgba(255,255,255,0.18)'
        };
        
        // Initialize POI data for Debre Tabor University
        this.initializePOIData();
        
        // Initialize notification system
        this.notificationSystem = new NotificationSystem(this);
        
        this.init();
    }

    // Close/hide the category POI overlay and remove listeners
    closeCategoryOverlay() {
        try {
            const listEl = document.getElementById('category-poi-list');
            if (!listEl) return;
                // remove delegated handler if present
                if (listEl._delegatedCloseHandler) {
                    try { listEl.removeEventListener('click', listEl._delegatedCloseHandler); } catch (e) {}
                    listEl._delegatedCloseHandler = null;
                }

                listEl.innerHTML = '';
            listEl.classList.remove('category-overlay');
            document.querySelectorAll('.category-item').forEach(item => item.classList.remove('active'));

            if (this._categoryOverlayListener) {
                document.removeEventListener('click', this._categoryOverlayListener);
                this._categoryOverlayListener = null;
            }
            if (this._categoryOverlayKeyListener) {
                document.removeEventListener('keydown', this._categoryOverlayKeyListener);
                this._categoryOverlayKeyListener = null;
            }
        } catch (e) { console.warn('closeCategoryOverlay failed', e); }
    }

    // --- Augmented Reality (AR) guidance helpers ---
    async startARGuidance() {
        if (this.isARGuiding) return;
        this.isARGuiding = true;

        // Create overlay UI
        this._createAROverlay();

        // On Android, proactively request permissions to ensure UX is smooth
        try {
            if (this._isAndroid()) {
                try {
                    await this.requestAndroidPermissions();
                } catch (permErr) {
                    console.warn('Android permission request failed', permErr);
                    // Don't throw - continue anyway, user may have already granted permissions
                }
            }
        } catch (e) {
            console.warn('Permission request error', e);
            // Continue anyway
        }

        // Start camera feed overlay when available
        try {
            // prefer camera AR when available
            await this._startCameraFeed();
            // create AR canvas for drawing route projection (if route available)
            try { this._createARCanvas(); this._startARRenderLoop(); } catch (e) { console.warn('AR canvas init failed', e); }
        } catch (e) {
            console.warn('Camera feed unavailable', e);
        }

        // Prepare route path and next waypoint index (if route available)
        if (this.currentRoute && this.currentRoute.route && this.currentRoute.route.path_data) {
            this._arPath = Array.isArray(this.currentRoute.route.path_data.coordinates) ? this.currentRoute.route.path_data.coordinates.slice() : [];
            this._arNextIndex = 0;
        } else {
            this._arPath = null;
            this._arNextIndex = 0;
        }

        // Start watching position
        try {
            if (navigator.geolocation) {
                this._arWatchId = navigator.geolocation.watchPosition((pos) => this._handleARPosition(pos), (err) => console.warn('AR geolocation error', err), { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
            }
        } catch (e) { console.warn('Failed to start geolocation watch', e); }

        // Device orientation for heading if available
        try {
            this._arDeviceHandler = (ev) => this._handleDeviceOrientation(ev);
            if (window.DeviceOrientationEvent) window.addEventListener('deviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation', this._arDeviceHandler);
        } catch (e) { console.warn('Device orientation not available', e); }

        // Update overlay status
        this._updateAROverlayStatus('started');
    }

    stopARGuidance() {
        if (!this.isARGuiding) return;
        this.isARGuiding = false;
        try {
            if (this._arWatchId && navigator.geolocation) navigator.geolocation.clearWatch(this._arWatchId);
        } catch (e) {}
        try {
            if (this._arDeviceHandler) window.removeEventListener('deviceorientation', this._arDeviceHandler);
        } catch (e) {}
        this._removeAROverlay();
        // stop camera feed
        try { this._stopCameraFeed(); } catch (e) {}
        this._arPath = null;
        this._arNextIndex = null;
        this._arWatchId = null;
        this._arDeviceHandler = null;
        this._arHeading = null;
        // stop and remove AR canvas/render loop
        try { this._stopARRenderLoop(); this._removeARCanvas(); } catch (e) {}
    }

    // Handle geolocation updates for AR guidance
    _handleARPosition(position) {
        try {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            this._arPosition = { latitude: lat, longitude: lng };
            this._updateARNextWaypoint();
        } catch (e) { console.warn('AR position handler error', e); }
    }

    // Handle device orientation events (heading)
    _handleDeviceOrientation(ev) {
        try {
            // modern browsers provide absolute heading in `alpha` or `webkitCompassHeading`
            let heading = null;
            if (typeof ev.webkitCompassHeading === 'number') heading = ev.webkitCompassHeading; // iOS
            else if (typeof ev.alpha === 'number') {
                // alpha is rotation around z axis; convert to compass heading (approx)
                heading = 360 - ev.alpha; // approximate
            }
            if (heading !== null) this._arHeading = heading;
            this._updateARNextWaypoint();
        } catch (e) { /* non-fatal */ }
    }

    // Update AR overlay with next waypoint, distance and turn hints
    _updateARNextWaypoint() {
        try {
            const posLat = this._arPosition ? this._arPosition.latitude : null;
            const posLng = this._arPosition ? this._arPosition.longitude : null;
            let targetLat = null, targetLng = null, distanceToTarget = null, bearingToTarget = null;

            // If we have a route, use the next waypoint on the route
            if (this._arPath && this._arPath.length > 0) {
                if (!posLat || !posLng) return; // wait for position data

                // find nearest upcoming coordinate on the path starting from _arNextIndex
                let nextIdx = this._arNextIndex || 0;

                // Advance nextIdx if we are within 8 meters of the waypoint
                while (nextIdx < this._arPath.length - 1) {
                    const [lng, lat] = this._arPath[nextIdx];
                    const d = this.calculateDistance(posLat, posLng, lat, lng);
                    if (d < 8) nextIdx++; else break;
                }
                this._arNextIndex = nextIdx;

                // Target coordinate
                const target = this._arPath[Math.min(nextIdx, this._arPath.length - 1)];
                targetLng = target[0];
                targetLat = target[1];
                bearingToTarget = this.calculateBearing(posLat, posLng, targetLat, targetLng);
                distanceToTarget = Math.round(this.calculateDistance(posLat, posLng, targetLat, targetLng));
            } else if (this._arDestination) {
                // If no route but destination is set, guide to destination
                if (!posLat || !posLng) return;
                targetLat = this._arDestination.latitude;
                targetLng = this._arDestination.longitude;
                bearingToTarget = this.calculateBearing(posLat, posLng, targetLat, targetLng);
                distanceToTarget = Math.round(this.calculateDistance(posLat, posLng, targetLat, targetLng));
            } else {
                // No route and no destination - just show compass heading
                if (!this._arHeading) return;
            }

            // compute heading (prefer device heading, otherwise estimate from small movement)
            let heading = this._arHeading || null;
            if (!heading && this._lastARPos && posLat && posLng) {
                heading = this.calculateBearing(this._lastARPos.latitude, this._lastARPos.longitude, posLat, posLng);
            }
            if (posLat !== null && posLng !== null) this._lastARPos = { latitude: posLat, longitude: posLng };

            // compute angle difference
            let angleDiff = null;
            if (bearingToTarget !== null && heading !== null) {
                angleDiff = ((bearingToTarget - heading + 540) % 360) - 180; // [-180,180]
            } else if (heading !== null) {
                // No target, just show heading
                angleDiff = 0;
            }

            // Update overlay elements
            const overlay = document.getElementById('ar-overlay');
            if (!overlay) return;
            const instrEl = overlay.querySelector('.ar-instruction');
            const distEl = overlay.querySelector('.ar-distance');
            const arrowEl = overlay.querySelector('.ar-arrow');

            let instr = 'Compass Active';
            if (angleDiff !== null && targetLat !== null) {
                if (Math.abs(angleDiff) < 20) instr = 'Go straight';
                else if (angleDiff > 0) instr = 'Turn right';
                else instr = 'Turn left';
            }
            if (instrEl) instrEl.textContent = instr;
            if (distEl) distEl.textContent = distanceToTarget !== null ? `${distanceToTarget} m` : (heading !== null ? `Heading: ${Math.round(heading)}°` : '');
            if (arrowEl) {
                // rotate arrow according to angleDiff (if available) otherwise default up
                if (angleDiff !== null) arrowEl.style.transform = `rotate(${angleDiff}deg)`;
                else if (heading !== null) arrowEl.style.transform = `rotate(0deg)`;
                else arrowEl.style.transform = 'rotate(0deg)';
            }

            // audio/haptic prompts for turn changes
            try {
                const last = this._lastARInstruction || '';
                if (instr !== last && targetLat !== null) {
                    this._playTurnPrompt(instr + (distanceToTarget ? ` in ${distanceToTarget} meters` : ''));
                    this._lastARInstruction = instr;
                }
            } catch (e) { console.warn('AR prompt failed', e); }

            // update upcoming turns list
            try { this._renderUpcomingTurns(); } catch (e) {}
        } catch (e) { console.warn('AR update failed', e); }
    }

    // Calculate forward azimuth/bearing from (lat1,lon1) to (lat2,lon2) in degrees
    calculateBearing(lat1, lon1, lat2, lon2) {
        const toRad = (v) => v * Math.PI / 180;
        const toDeg = (v) => v * 180 / Math.PI;
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLon) * Math.cos(toRad(lat2));
        const b = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
        const brng = Math.atan2(a, b);
        return (toDeg(brng) + 360) % 360;
    }

    // Create a simple AR overlay DOM
    _createAROverlay() {
        this._removeAROverlay();
        const overlay = document.createElement('div');
        overlay.id = 'ar-overlay';
        overlay.style.position = 'fixed';
        overlay.style.right = '16px';
        overlay.style.bottom = '16px';
        overlay.style.width = '220px';
        overlay.style.zIndex = '99999';
        overlay.style.background = 'rgba(10,10,10,0.75)';
        overlay.style.color = '#fff';
        overlay.style.padding = '12px';
        overlay.style.borderRadius = '10px';
        overlay.style.boxShadow = '0 6px 18px rgba(0,0,0,0.4)';
        overlay.style.fontFamily = 'Arial, sans-serif';
        overlay.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
                <div style="width:48px; height:48px; display:flex; align-items:center; justify-content:center; background:rgba(255,255,255,0.06); border-radius:8px;">
                    <div class="ar-arrow" style="width:18px; height:36px; border-left:6px solid transparent; border-right:6px solid transparent; border-bottom:18px solid #1a5f7a; transform:rotate(0deg);"></div>
                </div>
                <div style="flex:1;">
                    <div class="ar-instruction" style="font-weight:700; font-size:1rem;">Preparing...</div>
                    <div class="ar-distance" style="font-size:0.85rem; color:#ddd; margin-top:4px;"></div>
                </div>
            </div>
            <div style="margin-top:8px; font-size:0.8rem; color:#ccc;">AR Guidance active — follow the arrow and instructions</div>
        `;
        document.body.appendChild(overlay);
        // upcoming turns list placeholder
        const turnsList = document.createElement('div');
        turnsList.id = 'ar-upcoming-turns';
        turnsList.style.marginTop = '8px';
        turnsList.style.maxHeight = '160px';
        turnsList.style.overflow = 'auto';
        turnsList.style.fontSize = '0.85rem';
        turnsList.style.color = '#ddd';
        overlay.appendChild(turnsList);
    }

    _removeAROverlay() {
        try { const ex = document.getElementById('ar-overlay'); if (ex) ex.remove(); } catch (e) {}
    }

    // Start camera feed overlay (simple getUserMedia video background)
    async _startCameraFeed() {
        if (this._cameraStream) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('getUserMedia not supported');
        try {
            // Try with environment camera first (rear camera on mobile)
            let stream = null;
            try {
                stream = await navigator.mediaDevices.getUserMedia({ 
                    video: { facingMode: 'environment' }, 
                    audio: false 
                });
            } catch (e) {
                // Fallback: try without facingMode constraint (some Android devices don't support it)
                console.warn('Environment camera failed, trying generic video', e);
                stream = await navigator.mediaDevices.getUserMedia({ 
                    video: true, 
                    audio: false 
                });
            }
            
            this._cameraStream = stream;
            let video = document.getElementById('ar-camera-video');
            if (!video) {
                video = document.createElement('video');
                video.id = 'ar-camera-video';
                video.style.position = 'fixed';
                video.style.left = '0';
                video.style.top = '0';
                video.style.width = '100%';
                video.style.height = '100%';
                video.style.objectFit = 'cover';
                video.style.zIndex = '99990';
                video.style.opacity = '0.65';
                video.setAttribute('playsinline', 'true'); // Important for iOS/Android
                video.setAttribute('autoplay', 'true');
                video.setAttribute('muted', 'true');
                document.body.appendChild(video);
            }
            video.srcObject = stream;
            // Ensure video plays
            const playPromise = video.play();
            if (playPromise !== undefined) {
                playPromise.catch(err => console.warn('Video play failed', err));
            }
        } catch (e) {
            this._cameraStream = null;
            throw e;
        }
    }

    _stopCameraFeed() {
        try {
            if (this._cameraStream) {
                this._cameraStream.getTracks().forEach(t => t.stop());
                this._cameraStream = null;
            }
            const v = document.getElementById('ar-camera-video'); if (v) v.remove();
        } catch (e) { console.warn('Failed to stop camera feed', e); }
    }

    // Create full-screen canvas for AR drawing
    _createARCanvas() {
        this._removeARCanvas();
        const c = document.createElement('canvas');
        c.id = 'ar-canvas';
        c.style.position = 'fixed';
        c.style.left = '0';
        c.style.top = '0';
        c.width = window.innerWidth;
        c.height = window.innerHeight;
        document.body.appendChild(c);
        this._arCanvas = c;
        this._arCtx = c.getContext('2d');
        // handle resize
        this._arCanvasResizeHandler = () => {
            if (!this._arCanvas) return;
            this._arCanvas.width = window.innerWidth;
            this._arCanvas.height = window.innerHeight;
        };
        window.addEventListener('resize', this._arCanvasResizeHandler);
    }

    _removeARCanvas() {
        try {
            if (this._arCanvas) {
                try { window.removeEventListener('resize', this._arCanvasResizeHandler); } catch (e) {}
                this._arCanvas.remove();
            }
        } catch (e) {}
        this._arCanvas = null;
        this._arCtx = null;
        this._arCanvasResizeHandler = null;
    }

    _startARRenderLoop() {
        try {
            if (!this._arCanvas || !this._arCtx) return;
            const loop = () => {
                try { this._renderARCanvas(); } catch (e) { console.warn('AR render error', e); }
                this._arRenderLoopId = requestAnimationFrame(loop);
            };
            if (!this._arRenderLoopId) this._arRenderLoopId = requestAnimationFrame(loop);
        } catch (e) { console.warn('startARRenderLoop failed', e); }
    }

    _stopARRenderLoop() {
        try {
            if (this._arRenderLoopId) cancelAnimationFrame(this._arRenderLoopId);
        } catch (e) {}
        this._arRenderLoopId = null;
    }

    _renderARCanvas() {
        try {
            const canvas = this._arCanvas; const ctx = this._arCtx;
            if (!canvas || !ctx) return;
            // clear
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (!this.currentRoute || !this.currentRoute.route || !this._arPosition) return;

            const coords = (this.currentRoute.route.path_data && this.currentRoute.route.path_data.coordinates) ? this.currentRoute.route.path_data.coordinates : [];
            if (!coords.length) return;

            const userLat = this._arPosition.latitude; const userLng = this._arPosition.longitude;
            const heading = (typeof this._arHeading === 'number') ? this._arHeading : 0;

            // projection parameters
            const horizFov = 60; // degrees visible horizontally
            const maxDist = 200; // meters to render

            const projected = [];
            for (let i = 0; i < coords.length; i++) {
                const [lng, lat] = coords[i];
                const bearing = this.calculateBearing(userLat, userLng, lat, lng);
                let angle = (((bearing - heading + 540) % 360) - 180); // [-180,180]
                // map angle to x
                const x = (canvas.width / 2) + (angle / (horizFov / 2)) * (canvas.width / 2);
                // distance
                const d = this.calculateDistance(userLat, userLng, lat, lng);
                if (d > maxDist) continue; // skip distant
                // map distance to y (closer -> lower on screen)
                const y = canvas.height * (0.6 + Math.min(1, d / maxDist) * 0.35);
                projected.push({ x, y, d, angle, idx: i });
            }

            // Smooth projected points using Catmull-Rom spline (produce more natural curved path)
            const smoothPoints = (pts, segments = 8) => {
                if (pts.length < 2) return pts.slice();
                const res = [];
                const p = pts;
                // helper to get point with clamping
                const get = (i) => p[Math.max(0, Math.min(p.length-1, i))];
                for (let i = 0; i < p.length - 1; i++) {
                    const p0 = get(i-1), p1 = get(i), p2 = get(i+1), p3 = get(i+2);
                    for (let t = 0; t < segments; t++) {
                        const tt = t / segments;
                        const tt2 = tt * tt, tt3 = tt2 * tt;
                        // Catmull-Rom spline formula
                        const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * tt + (2*p0.x - 5*p1.x + 4*p2.x - p3.x) * tt2 + (-p0.x + 3*p1.x - 3*p2.x + p3.x) * tt3);
                        const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * tt + (2*p0.y - 5*p1.y + 4*p2.y - p3.y) * tt2 + (-p0.y + 3*p1.y - 3*p2.y + p3.y) * tt3);
                        const d = Math.max(0, Math.min(maxDist, 0.5 * ((p1.d||0)+(p2.d||0))));
                        res.push({ x, y, d });
                    }
                }
                // push final point
                const last = pts[pts.length-1]; res.push({ x: last.x, y: last.y, d: last.d });
                return res;
            };
            const smoothProjected = smoothPoints(projected, 6);

            if (projected.length === 0) return;

            // draw path (use smoothed points when available)
            const drawPoints = (smoothProjected && smoothProjected.length) ? smoothProjected : projected;
            ctx.lineWidth = this.arVisual.pathWidth || 6;
            ctx.strokeStyle = this.arVisual.pathColor || 'rgba(41,128,185,0.95)';
            // glow
            if (this.arVisual.pathGlow) {
                ctx.save();
                ctx.lineWidth = (this.arVisual.pathWidth || 6) + 6;
                ctx.strokeStyle = this.arVisual.pathGlow;
                ctx.beginPath();
                for (let i = 0; i < drawPoints.length; i++) {
                    const p = drawPoints[i]; if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
                }
                ctx.stroke();
                ctx.restore();
            }
            ctx.lineWidth = this.arVisual.pathWidth || 6;
            ctx.strokeStyle = this.arVisual.pathColor || 'rgba(41,128,185,0.95)';
            ctx.beginPath();
            for (let i = 0; i < drawPoints.length; i++) {
                const p = drawPoints[i]; if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();

            // draw markers and arrows for next waypoint
            const nextIdx = this._arNextIndex || 0;
            // find first drawPoint that corresponds to or is after nextIdx in the original projected set
            let nextProj = null;
            for (let i = 0; i < drawPoints.length; i++) {
                // approximate mapping: use nearest original index if available
                if (drawPoints[i].idx !== undefined && drawPoints[i].idx >= nextIdx) { nextProj = drawPoints[i]; break; }
            }
            if (!nextProj) nextProj = drawPoints[0];
            if (nextProj) {
                const arrowSize = Math.max(12, Math.min(36, (this.arVisual.pathWidth || 6) * 2));
                // triangular arrow with gradient
                const arrowColorFrom = this.arVisual.arrowColorFrom || '#fff';
                const arrowColorTo = this.arVisual.arrowColorTo || '#ffd54d';
                const grad = ctx.createLinearGradient(nextProj.x, nextProj.y - arrowSize, nextProj.x, nextProj.y + arrowSize);
                grad.addColorStop(0, arrowColorFrom);
                grad.addColorStop(1, arrowColorTo);
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.moveTo(nextProj.x, nextProj.y - arrowSize);
                ctx.lineTo(nextProj.x - arrowSize/2, nextProj.y + arrowSize/2);
                ctx.lineTo(nextProj.x + arrowSize/2, nextProj.y + arrowSize/2);
                ctx.closePath();
                ctx.fill();

                // distance label with shadow
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 14px sans-serif';
                ctx.shadowColor = 'rgba(0,0,0,0.6)';
                ctx.shadowBlur = 4;
                const distText = this.formatDistance(nextProj.d);
                ctx.fillText(distText, nextProj.x + arrowSize/1.6, nextProj.y - 6);
                ctx.shadowBlur = 0;
            }

            // center indicator (ahead)
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.beginPath(); ctx.arc(canvas.width/2, canvas.height*0.85, 6, 0, Math.PI*2); ctx.fill();
        } catch (e) { console.warn('renderARCanvas failed', e); }
    }

    // Play audio and haptic prompt
    _playTurnPrompt(text) {
        try {
            // Speech synthesis
            if ('speechSynthesis' in window) {
                const msg = new SpeechSynthesisUtterance(text);
                msg.rate = 1.0;
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(msg);
            }
            // Vibration (short pulse)
            if (navigator.vibrate) navigator.vibrate([200]);
        } catch (e) { console.warn('Turn prompt failed', e); }
    }

    // Render upcoming turns from the current route into the overlay list
    _renderUpcomingTurns() {
        try {
            const listEl = document.getElementById('ar-upcoming-turns');
            if (!listEl) return;
            listEl.innerHTML = '';
            const instructions = (this.currentRoute && this.currentRoute.route && this.currentRoute.route.indoor_instructions) ? this.currentRoute.route.indoor_instructions : [];
            instructions.slice(0, 10).forEach(instr => {
                const d = document.createElement('div');
                d.style.padding = '6px 0';
                d.style.borderBottom = '1px dashed rgba(255,255,255,0.06)';
                d.innerHTML = `<strong style="color:#fff;">${instr.step}.</strong> <span style="color:#ddd;">${instr.instruction}</span> ${instr.distance>0?`<em style="color:#aaf;">${instr.distance}m</em>`:''}`;
                listEl.appendChild(d);
            });
        } catch (e) { console.warn('Render upcoming turns failed', e); }
    }

    _updateAROverlayStatus(status) {
        const btn = document.getElementById('ar-toggle');
        if (!btn) return;
        if (status === 'started') { btn.classList.add('active'); btn.style.background = '#1a5f7a'; btn.style.color = '#fff'; }
        else { btn.classList.remove('active'); btn.style.background = ''; btn.style.color = ''; }
    }

    // Helper to get translation string by dotted key path, e.g. 'feedback.submit'
    t(keyPath, fallback) {
        try {
            const parts = keyPath.split('.');
            let v = this.translations[this.currentLanguage] || this.translations.en;
            for (const p of parts) { if (!v) return fallback || ''; v = v[p]; }
            return v || fallback || '';
        } catch (e) { return fallback || ''; }
    }

    // Detect Android UA
    _isAndroid() {
        try { return /Android/i.test(navigator.userAgent || ''); } catch (e) { return false; }
    }

    // Request permissions on Android: attempts to trigger camera and location prompts
    async requestAndroidPermissions() {
        // avoid repeated prompts
        if (this._androidPermissionsRequested) return;
        this._androidPermissionsRequested = true;

        // Use Permissions API where available to pre-check
        try {
            if (navigator.permissions && navigator.permissions.query) {
                try {
                    const geoPerm = await navigator.permissions.query({ name: 'geolocation' }).catch(() => null);
                    if (geoPerm && geoPerm.state === 'denied') throw new Error('Location permission denied');
                } catch (e) {}
                try {
                    const camPerm = await navigator.permissions.query({ name: 'camera' }).catch(() => null);
                    if (camPerm && camPerm.state === 'denied') throw new Error('Camera permission denied');
                } catch (e) {}
            }
        } catch (e) { /* non-fatal */ }

        // Trigger actual permission prompts by calling getUserMedia and getCurrentPosition
        return new Promise((resolve, reject) => {
            let done = { cam: false, geo: false };
            let hasError = false;
            const checkDone = () => { if (done.cam && done.geo) { if (!hasError) resolve(); } };

            // Request geolocation (one-shot) to trigger permission prompt
            try {
                if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(
                        (p) => { done.geo = true; checkDone(); },
                        (err) => { done.geo = true; hasError = true; checkDone(); },
                        { enableHighAccuracy: true, timeout: 10000 }
                    );
                } else {
                    done.geo = true; checkDone();
                }
            } catch (e) { done.geo = true; checkDone(); }

            // Request camera access to trigger permission prompt (stop immediately)
            try {
                if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
                        .then(stream => {
                            try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
                            done.cam = true; checkDone();
                        })
                        .catch(err => { done.cam = true; hasError = true; checkDone(); });
                } else {
                    done.cam = true; checkDone();
                }
            } catch (e) { done.cam = true; checkDone(); }

            // Timeout after 15 seconds to avoid hanging
            setTimeout(() => {
                if (!done.cam || !done.geo) {
                    done.cam = true;
                    done.geo = true;
                    checkDone();
                }
            }, 15000);
        });
    }

    // escape HTML to prevent injection when rendering user-supplied text
    escapeHtml(str) {
        if (str == null) return '';
        return String(str).replace(/[&<>"]+/g, function(s) {
            switch (s) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                default: return s;
            }
        });
    }

    init() {
        console.log('🚀 Initializing DTU Campus Navigation System...');
        // translations, socket, and UI setup
        this.initTranslations();
        this.applyTranslations();
        this.setupSocket();
        this.setupEventListeners();
        
        // Delay map initialization slightly to ensure DOM is fully rendered
        setTimeout(() => {
            // Load server-provided campus bounds, then initialize map
            this.loadCampusBounds().then(() => {
                this.initializeMap();
                // draw bounding box on map
                try { this.drawCampusBoundingBox(); } catch (e) {}
            }).catch((e) => {
                console.warn('Failed loading campus bounds, initializing map with defaults', e);
                this.initializeMap();
                try { this.drawCampusBoundingBox(); } catch (e) {}
            });
        }, 100);
        
        // Load Points of Interest
        this.loadPOIs();
        try { this.populateDatalists(); } catch (e) { console.warn('populateDatalists init failed', e); }
        this.checkAuthentication();
        try { this.refreshUnreadCount(); } catch (e) {}
        // Track page view for analytics
        try { this.trackEvent('page_view', '/home', { source: 'init' }); } catch (e) {}
    }

    // Load campus bounds from backend settings
    async loadCampusBounds() {
        try {
            const res = await fetch(`${this.apiBase}/settings/campus-bounds`);
            if (!res.ok) return;
            const data = await res.json();
            if (data && data.bounds) {
                this.campusGeo = {
                    north: data.bounds.north,
                    south: data.bounds.south,
                    east: data.bounds.east,
                    west: data.bounds.west
                };
                // compute center
                this.dtuCoordinates = [ (data.bounds.north + data.bounds.south)/2, (data.bounds.east + data.bounds.west)/2 ];
            }
        } catch (e) { console.warn('loadCampusBounds failed', e); }
    }

    // Draw visible bounding box on the map with label
    drawCampusBoundingBox() {
        if (!this.map || !this.campusGeo) return;
        if (this.campusRect) try { this.map.removeLayer(this.campusRect); } catch (e) {}
        this.campusRect = L.rectangle(this.campusBounds, {
            color: '#e67e22',
            weight: 3,
            dashArray: '6 4',
            fillOpacity: 0
        }).addTo(this.map);

        const boundsCenter = this.campusBounds.getCenter();
        const label = `Bounds:\nN ${this.campusGeo.north}, S ${this.campusGeo.south}, E ${this.campusGeo.east}, W ${this.campusGeo.west}`;
        if (this.boundsLabelMarker) try { this.map.removeLayer(this.boundsLabelMarker); } catch (e) {}
        this.boundsLabelMarker = L.marker([boundsCenter.lat, boundsCenter.lng], { interactive: false, opacity: 0.85 }).addTo(this.map).bindPopup(`<pre style="font-size:0.85rem;">${label}</pre>`);
    }

    // --- Translations (simple key/value strings) ---
    initTranslations() {
        this.translations = {
            en: {
                admin: {
                    prompt_response: "Enter response message to the user (leave empty to cancel)",
                    prompt_status: "Set status for this feedback (e.g. 'in_progress', 'resolved')",
                    prompt_role: "Change role for user to 'admin' or 'user' (current: {role})",
                    prompt_notification_title: "Notification title",
                    prompt_notification_message: "Notification message",
                    demo_title: "Site Maintenance",
                    demo_message: "This is a demo notification from admin."
                },
                messages_extra: {
                    role_change_cancelled: "Role change cancelled or invalid role"
                },
                errors_extra: {
                    update_map_modal_not_found: "Update map modal not found"
                }
            },
            am: {
                admin: {
                    prompt_response: "ለተጠቃሚው መልእክት ያስገቡ (ባዶ ትችላለህ ለመሰረዝ)",
                    prompt_status: "ለዚህ አስተያየት ሁኔታ ያስቀምጡ (ለምሳሌ 'በሂደት ላይ', 'ተፈጸመ')",
                    prompt_role: "የተጠቃሚውን ሚና ወደ 'አስተዳደር' ወይም 'ተጠቃሚ' ይቀይሩ (አሁን: {role})",
                    prompt_notification_title: "የማስታወቂያ ርዕስ",
                    prompt_notification_message: "የማስታወቂያ መልእክት",
                    demo_title: "የሳይት ጥገና",
                    demo_message: "ይህ የአስተዳደር ማስታወቂያ ለማሳየት ነው።"
                },
                messages_extra: {
                    role_change_cancelled: "የሚና ለውጥ ተሰርዟል ወይም ልክ ያልሆነ ሚና"
                },
                errors_extra: {
                    update_map_modal_not_found: "የካርታ አዘምን ሞዳል አልተገኘም"
                }
            },
            ti: {
                admin: {
                    prompt_response: "መልእክቲ ምስ ተጠቃሚ ኣብ ዚ ኣብ ባዶ ትችል ምሰረዝ",
                    prompt_status: "ኣብዚ ኣስተያየት ሁነታ ምስ ምርጫ (ምሳሌ 'ኣብ ሂደት', 'ተፈጸመ')",
                    prompt_role: "ኣብ ተጠቃሚ ሚና ወደ 'ኣስተዳደር' ወይም 'ተጠቃሚ' ቀይሩ (ኣሁን: {role})",
                    prompt_notification_title: "ርእሲ ማስታወቂያ",
                    prompt_notification_message: "መልእክቲ ማስታወቂያ",
                    demo_title: "ሳይት ጥገና",
                    demo_message: "ይህ ማስታወቂያ ኣብ ኣስተዳደር ምሳይ እዩ"
                },
                messages_extra: {
                    role_change_cancelled: "ሚና ምርጫ ተሰርዓል ወይም ልክ ዘይኮነ ሚና"
                },
                errors_extra: {
                    update_map_modal_not_found: "ካርታ ኣዘምን ሞዳል ኣይተረኽበን"
                }
            },
            om: {
                admin: {
                    prompt_response: "Ergaa gara fayyadamaa galchi (duwwaa taʼee dhiisi)",
                    prompt_status: "Haala yaada kanaa kaaʼi (fakkeenyaaf 'hojii irra jira', 'xumurame')",
                    prompt_role: "Gosa fayyadamaa gara 'admin' yookaan 'user' jijjiiri (amma: {role})",
                    prompt_notification_title: "Mata-duree Beeksisa",
                    prompt_notification_message: "Ergaa Beeksisa",
                    demo_title: "Tajaajila Site",
                    demo_message: "Kun beeksisa demo admin irraa dhufe"
                },
                messages_extra: {
                    role_change_cancelled: "Gosa jijjiirraa haqame yookaan dogoggora"
                },
                errors_extra: {
                    update_map_modal_not_found: "Update map modal hin argamne"
                }
            },
            en: {
                nav: { home: 'Home', map: 'Campus Map', directions: 'Directions', feedback: 'Feedback', about: 'About' },
                hero: { title: 'Debre Tabor University — Campus Navigation', subtitle: 'Explore campus buildings, get real-time routing, and discover points of interest.', open_map: 'Open Campus Map', learn_more: 'Learn More' },
                search: { find_route: 'Find Your Route', start_placeholder: 'Select starting point...', end_placeholder: 'Select destination...', calculate_route: 'Calculate Route' },
                route: { title: 'Route Information', distance: 'Distance', estimated_time: 'Estimated Time', type: 'Route Type' },
                // route instruction templates
                route_instructions: {
                    start: 'Start from {name}',
                    walk_main: 'Walk straight on the main pathway',
                    continue: 'Continue following the campus walkway',
                    arrive: 'Arrive at {name}'
                },
                feedback: { title: 'Send Feedback', type_label: 'Type', title_label: 'Title', rating_label: 'Rating', related_label: 'Related Place (optional)', related_placeholder: 'Select related place (optional)', name_label: 'Your name (optional)', name_placeholder: 'Your name', email_label: 'Your email (optional)', email_placeholder: 'you@example.com', message_label: 'Message', message_placeholder: 'Describe your issue or suggestion', submit: 'Submit Feedback', cancel: 'Cancel' },
                admin: { dashboard_title: 'Admin Dashboard', broadcast: 'Broadcast', update_map: 'Update Map', feedback: 'Feedback' },
                errors: {
                    select_both: 'Please select both starting point and destination',
                    same_points: 'Starting point and destination cannot be the same',
                    geolocation_unsupported: 'Geolocation is not supported by your browser',
                    unable_get_location: 'Unable to get your location. Please select your starting point manually.'
                },
                messages: {
                    getting_location: 'Getting your current location...',
                    location_detected: 'Your current location has been detected',
                    switched_standard: 'Switched to standard map view',
                    switched_satellite: 'Switched to satellite view',
                    destination_set: 'Destination set successfully!',
                    recalculating_route: 'Recalculating route...',
                    arrived_destination: 'You have arrived at your destination',
                    live_routing_active: 'Live Routing Active',
                    remaining_distance: 'Remaining'
                },
                location_details: 'My Location',
                latitude: 'Latitude',
                longitude: 'Longitude',
                accuracy: 'Accuracy',
                nearby_pois: 'Nearby Points of Interest',
                all_categories: 'All Categories',
                no_nearby_pois: 'No nearby points of interest found',
                navigate: 'Navigate',
                poi: {
                    building: 'Building',
                    category: 'Category',
                    floors: 'Floors',
                    opening_hours: 'Opening Hours',
                    description: 'Description',
                    departments: 'Departments',
                    facilities: 'Facilities',
                    contact: 'Contact Information',
                    location: 'Location',
                    set_destination: 'Set as Destination'
                },
                selection: {
                    start_label: 'Starting Point',
                    end_label: 'Destination Point',
                    or_pick_from_list: 'Or pick from list:',
                    set_as_start: 'Set as Starting Point',
                    set_as_destination: 'Set as Destination',
                    clear_selection: 'Clear'
                },
                categories: {
                    title: 'Categories',
                    academic: 'Academic Blocks',
                    administrative: 'Administrative',
                    services: 'Services',
                    recreational: 'Recreational'
                },
                quick_links: {
                    title: 'Quick Links',
                    library: 'Main Library',
                    cafeteria: 'Cafeteria',
                    admin: 'Admin Building',
                    student_center: 'Student Center'
                },
                footer: {
                    title: 'DTU Navigation',
                    description: 'The official campus navigation system of Debre Tabor University, helping students, staff, and visitors find their way around campus efficiently.',
                    quick_links_title: 'Quick Links',
                    links: { home: 'Home', map: 'Campus Map', buildings: 'Building Directory', events: 'Events' },
                    resources_title: 'Resources',
                    resources: { feedback: 'Feedback', help: 'Help Center', mobile: 'Mobile App', accessibility: 'Accessibility' },
                    contact_title: 'Contact Us',
                    contact: { address: 'Debre Tabor, Ethiopia', phone: '+251-58-1410495', email: 'info@dtu.edu.et', hours: 'Mon-Fri: 8:00 AM - 5:00 PM' },
                    copyright: '© 2025 Debre Tabor University. All rights reserved. | Campus Navigation System v1.0'
                },
                messages_extra: {
                    admin_login_prompt: 'Please enter both username and password',
                    admin_login_success: 'Admin login successful!',
                    feedback_submitted: 'Feedback submitted. Thank you!',
                    logged_out: 'Logged out successfully',
                    route_saved: 'Route saved to your history!',
                    only_admin_save_routes: 'Only admin can save routes.',
                    only_admin_submit_feedback: 'Only admin can submit feedback.',
                    feedback_panel_open: 'Feedback panel would open here',
                    response_cancelled: 'Response cancelled',
                    status_change_cancelled: 'Status change cancelled',
                    notification_cancelled: 'Notification cancelled',
                    notification_sent: 'Notification sent',
                    poi_added_server: 'POI successfully added to server',
                    server_rejected_poi: 'Server rejected POI — adding locally as fallback',
                    poi_added_locally: 'Failed to reach server — POI added locally',
                    demo_cancelled: 'Demo cancelled',
                    broadcast_sent: 'Broadcast sent'
                },
                errors_extra: {
                    not_authenticated: 'Not authenticated',
                    broadcast_form_not_found: 'Broadcast form not found',
                    provide_title_message: 'Please provide both title and message',
                    invalid_poi_fields: 'Please provide valid id, name, latitude and longitude'
                }
            },
            am: {
                nav: { home: 'ዋና', map: 'የካምፓስ ካርታ', directions: 'አቅጣጫ', feedback: 'አስተያየት', about: 'ስለ እኛ' },
                hero: { title: 'ደብረ ታቦር ዩኒቨርሲቲ — የካምፓስ አቅጣጫ', subtitle: 'የካምፓስ ሕንጻዎችን ይፈልጉ፣ በእድሜ ጊዜ መመሪያ ይውሰዱ፣ እና ነገሮችን ያገኙ።', open_map: 'ካርታውን ክፈት', learn_more: 'ወደ ተጨማሪ ይሂዱ' },
                search: { find_route: 'መንገድ ፈልግ', start_placeholder: 'የጀማሪ ነገር ይውሰዱ...', end_placeholder: 'መድረሻ ይምረጡ...', calculate_route: 'መንገድ ሂሳብ' },
                route: { title: 'የመንገድ መረጃ', distance: 'ርቀት', estimated_time: 'የተገመደ ጊዜ', type: 'የመንገድ አይነት' },
                route_instructions: {
                    start: 'ከ {name} ይጀምሩ',
                    walk_main: 'ቀጥ ብለው በዋናው መንገድ ይጓዙ',
                    continue: 'እቲ መንገዲ ይቀጥሉ',
                    arrive: 'ደርሱ ወደ {name}'
                },
                feedback: { title: 'አስተያየት ላክ', type_label: 'አይነት', title_label: 'አርእስት', rating_label: 'ግምገማ', related_label: 'ተያያዥ ቦታ (ነገር)', related_placeholder: 'ተያያዥ ቦታ ይምረጡ', name_label: 'የእርስዎ ስም (አማራጭ)', name_placeholder: 'ስም', email_label: 'ኢሜይል (አማራጭ)', email_placeholder: 'example@you.com', message_label: 'መልእክት', message_placeholder: 'ጉዳዩን ያስረዱ', submit: 'አስገባ', cancel: 'ይቅር' },
                admin: { dashboard_title: 'የአስተዳደር መድረክ', broadcast: 'ማስታወቂያ', update_map: 'ካርታ አዘምን', feedback: 'አስተያየት' },
                errors: { select_both: 'እባክዎ የጀማሪና መድረሻ እንኳን ይምረጡ', same_points: 'የጀማሪ እና መድረሻ ተመሳሳይ አይሆኑ', geolocation_unsupported: 'የጂዮሎኬሽን ድጋፍ በአሳሳቢ አለመኖሩ', unable_get_location: 'ድሮ ቦታዎን ማግኘት አልቻልንም። እባክዎ እባክዎን እንደገና ይምረጡ' },
                messages: { getting_location: 'የእርስዎን አቅራቢ ቦታ እንደምንፈልጋለን...', location_detected: 'የእርስዎ አቅራቢ ቦታ ተገኝቷል', switched_standard: 'ወደ መደበኛ ካርታ ተለዋዋጭ', switched_satellite: 'ወደ ሳተላይት ይመለሳሉ', destination_set: 'መደረሻ ተቀባ', recalculating_route: 'መንገድ እንደገና ይሰላል...', arrived_destination: 'ወደ መድረሻዎ ደርሰዋል', live_routing_active: 'ライブ ルーティング ንቅናቄ', remaining_distance: 'ቀሪ' },
                location_details: 'ሞቅ ሞቅ',
                latitude: 'ኬክሮስ',
                longitude: 'ሎንጅቱድ',
                accuracy: 'ትክክለኛነት',
                nearby_pois: 'ቅርብ ነገሮች',
                all_categories: 'ሁሉም ምድቦች',
                no_nearby_pois: 'ቅርብ ነገሮች አልተገኙም',
                navigate: 'ይሂዱ',
                poi: { building: 'ሕንጻ', category: 'ምድብ', floors: 'ደረጃዎች', opening_hours: 'የክፍት ሰዓቶች', description: 'መግለጫ', departments: 'ክፍሎች', facilities: 'ተቋማት', contact: 'የንግድ መረጃ', location: 'አካባቢ', set_destination: 'እንደ መድረሻ ያስቀምጡ' },
                selection: {
                    start_label: 'የጀማሪ ነገር',
                    end_label: 'መድረሻ',
                    or_pick_from_list: 'ወይም ከዝርዝር ይምረጡ፦',
                    set_as_start: 'እንደ ጀማሪ አቀይር',
                    set_as_destination: 'እንደ መድረሻ ያስቀምጡ',
                    clear_selection: 'አስወግድ'
                },
                categories: {
                    title: 'ምድቦች',
                    academic: 'የአካዳሚክ ሕንጻዎች',
                    administrative: 'አስተዳደር',
                    services: 'አገልግሎቶች',
                    recreational: 'ዝግጅት'
                },
                quick_links: {
                    title: 'ፈጣን አገናኝ',
                    library: 'ዋናው ቤተ-መጻሕፍት',
                    cafeteria: 'ካፌቴሪያ',
                    admin: 'የአስተዳደር ሕንጻ',
                    student_center: 'የተማሪ ማዕከል'
                },
                footer: {
                    title: 'DTU Navigation',
                    description: 'የደብረ ታቦር ዩኒቨርሲቲ የካምፓስ አስተዳደር ስርዓት፣ ለተማሪዎች ፣ ለሠራተኞች እና ለጎብኚዎች እንዴት እንደሚገኙ ይረዳ።',
                    quick_links_title: 'ፈጣን አገናኝ',
                    links: { home: 'ዋና', map: 'የካርታ', buildings: 'የሕንጻ ዝርዝር', events: 'ክስተቶች' },
                    resources_title: 'ምንጮች',
                    resources: { feedback: 'አስተያየት', help: 'የእገዛ ማዕከል', mobile: 'ሞባይል አፕ', accessibility: 'የመዳረሻ እንቅስቃሴ' },
                    contact_title: 'ያግኙን',
                    contact: { address: 'ደብረ ታቦር, ኢትዮጵያ', phone: '+251-58-1410495', email: 'info@dtu.edu.et', hours: 'ሰኞ-አርብ: 8:00 እስከ 5:00' },
                    copyright: '© 2025 ደብረ ታቦር ዩኒቨርሲቲ. የሁሉም መብቶች ተያዙ.'
                }
            },
            ti: {
                nav: { home: 'ሓደሽ', map: 'ካምፓስ ካርታ', directions: 'መንገዲ', feedback: 'ኣስተያየት', about: 'ስለ ናይ' },
                hero: { title: 'ዴብሬ ታቦር ዩኒቨርሲቲ — መንገዲ ካምፓስ', subtitle: 'ሕንጻታት ተመልከት፣ ኣብ ሕጂ ጊዜ መንገዲ ምርጫ ኣለኻ', open_map: 'ካርታ ክፈት', learn_more: 'ዝተረዳዳይ ሓበሬታ' },
                search: { find_route: 'መንገዲ ይረዱ', start_placeholder: 'ጀምረካ ይምረጥ...', end_placeholder: 'መድረሻ ይምረጡ...', calculate_route: 'መንገዲ ኣሰርዩ' },
                route: { title: 'ዝርዝር መንገዲ', distance: 'ርቀት', estimated_time: 'ግዜ', type: 'ኣይነት መንገዲ' },
                route_instructions: {
                    start: 'ምእንቲ {name} ጀምር',
                    walk_main: 'ቀጥ ይሂዱ ብመንገዲ ዋና',
                    continue: 'ቀጥሊ መንገዲ ይከተሉ',
                    arrive: 'ን {name} ድሕር ይድርጉ'
                },
                feedback: { title: 'ኣስተያየት ላን', type_label: 'ኣይነት', title_label: 'ርእሲ', rating_label: 'ግምገማ', related_label: 'ቦታ ተዛማጅ', related_placeholder: 'ቦታ ይምረጥ', name_label: 'ስምካ (ብኣማራጭ)', name_placeholder: 'ስም', email_label: 'ኢሜይል', email_placeholder: 'you@example.com', message_label: 'መልእክቲ', message_placeholder: 'ጉዳይካ ይስተው', submit: 'ኣስቀምጥ', cancel: 'ኣቕረ' },
                admin: { dashboard_title: 'መኸዳዲ ገጽ', broadcast: 'ማስታወቂያ', update_map: 'ካርታ ኣዘምን', feedback: 'ኣስተያየት' },
                errors: { select_both: 'እባክኩም ጀምርን እና መድረሻን ምረጡ', same_points: 'ጀምርን እና መድረሻን ተመሳሳይ ኣይንስሩ', geolocation_unsupported: 'Geolocation ኣይኽእልን', unable_get_location: 'ኣቦነትካ ምግብግብ ኣልተቻለን። እባክኩም ንሓደ ነገር ኣርእይ' },
                messages: { getting_location: 'እዚ ቦታካ ክኸውን እንሞክር...', location_detected: 'ቦታካ ተረኽቦ', switched_standard: 'ወደ መደበኛ ካርታ ተመለሰ', switched_satellite: 'ወደ ሳተላይት ኣቀርቦ', destination_set: 'መድረሻ ተቀምጦ', recalculating_route: 'መንገድ እንደገና ይሰላል...', arrived_destination: 'ወደ መድረሻዎ ደርሰዋል', live_routing_active: 'ライブ ルーティング ንቅናቄ', remaining_distance: 'ቀሪ' },
                location_details: 'ቦታ ናተይ',
                latitude: 'ኬክሮስ',
                longitude: 'ሎንጅቱድ',
                accuracy: 'ትክክለኛነት',
                nearby_pois: 'ቅርብ ነገሮች',
                all_categories: 'ሁሉም ምድቦች',
                no_nearby_pois: 'ቅርብ ነገሮች አልተገኙም',
                navigate: 'ይሂዱ',
                poi: { building: 'ሕንጻ', category: 'ምድብ', floors: 'ክፍላት', opening_hours: 'ሰዓታት', description: 'መግለጫ', departments: 'ክፍሎች', facilities: 'ተቋማት', contact: 'መገናኛ', location: 'ኣባባ', set_destination: 'እንደ መድረሻ ያስቀምጡ' },
                selection: {
                    start_label: 'ጀምር',
                    end_label: 'መድረሻ',
                    or_pick_from_list: 'ወይ ካብ ዝርዝር ይምረጡ:',
                    set_as_start: 'እንደ ጀምር ይቀይሩ',
                    set_as_destination: 'እንደ መድረሻ ይቀይሩ',
                    clear_selection: 'ሰርዝ'
                },
                categories: {
                    title: 'ምድቦች',
                    academic: 'ሕንጻታት ትምህርቲ',
                    administrative: 'ምምሕዳር',
                    services: 'ስርዓታት',
                    recreational: 'ዝግጅት'
                },
                quick_links: {
                    title: 'መሳርሒ',
                    library: 'ዋናይ ቤተ-መጻሕፍቲ',
                    cafeteria: 'ካፌቴሪያ',
                    admin: 'ሕንጻ ምምሕዳር',
                    student_center: 'ማእከል ተመሃሮ'
                },
                footer: {
                    title: 'DTU Navigation',
                    description: 'ዝተቋቋሙ ዝኾነ ድብረ ታቦር ዩኒቨርሲቲ ካምፓስ ናይ መርዓ ስርዓት እዩ።',
                    quick_links_title: 'መሳርሒ',
                    links: { home: 'ቤት', map: 'ካርታ', buildings: 'ዝርዝር ሕንጻታት', events: 'ክስተቶች' },
                    resources_title: 'ምንጮች',
                    resources: { feedback: 'ኣስተያየት', help: 'መረዳእታ', mobile: 'ሞባይል ኣፕ', accessibility: 'ኣካላዊ ንዑስ እቃ' },
                    contact_title: 'ናብና ኣግኙ',
                    contact: { address: 'ደብረ ታቦር, ኢትዮጵያ', phone: '+251-58-1410495', email: 'info@dtu.edu.et', hours: 'ሰኑይ-ኣርብ: 8:00 ካብ 5:00' },
                    copyright: '© 2025 Debre Tabor University. All rights reserved.'
                }
            },
            om: {
                nav: { home: 'Mana', map: 'Kaartaa Yuunivarsiitii', directions: 'Daandii', feedback: 'Yaada', about: 'Waaʼee' },
                hero: { title: 'Debre Tabor University — Kaartaa Kaampasii', subtitle: 'Ijaarsota kaampasii qoradhu, karaa yeroo dhugaa argadhu, fi bakka barbaachisu argadhu.', open_map: 'Kaartaa Bani', learn_more: 'Waaʼee dabalataa' },
                search: { find_route: 'Karaa Keenya Barbaadi', start_placeholder: 'Iddoo jalqabaa filadhu...', end_placeholder: 'Iddoo dhuma filadhu...', calculate_route: 'Karaa Xinxalli' },
                route: { title: 'Odeeffannoo Karaa', distance: 'Fageenya', estimated_time: 'Yeroo tilmaamame', type: 'Gosa Karaa' },
                route_instructions: {
                    start: '{name} irraa jalqabi',
                    walk_main: 'Halluu kallattii irraan deemi',
                    continue: 'Karaa kaampasii hordofi',
                    arrive: '{name} gaʼi'
                },
                feedback: { title: 'Yaada ergi', type_label: 'Gosa', title_label: 'Mata-duree', rating_label: 'Safartuu', related_label: 'Bakki wal qabatu (filannoo)', related_placeholder: 'Bakki wal qabatu filadhu', name_label: 'Maqaa kee (filannoo)', name_placeholder: 'Maqaa', email_label: 'Imeeilii (filannoo)', email_placeholder: 'sii@example.com', message_label: 'Ergaa', message_placeholder: 'Rakkoo ykn yaada kee ibsi', submit: 'Ergi', cancel: 'Haqu' },
                admin: { dashboard_title: 'Daashibooardii Admin', broadcast: 'Beeksisa', update_map: 'Kaartaa Haaromsu', feedback: 'Yaada' },
                errors: { select_both: 'Ilaali: bakka jalqabaa fi xumuraa filadhu', same_points: 'Bakka jalqabaa fi xumuraa walfakkaatu miti', geolocation_unsupported: 'Geolocation sirra hin jiru', unable_get_location: 'Iddoo kee argachuu hin dandeenye. Mee iddoo filadhu' },
                messages: { getting_location: 'Iddoo kee argaa jirra...', location_detected: 'Iddoo kee argameera', switched_standard: 'Bara kaartaa gara sirrii jijjiire', switched_satellite: 'Gara kaartaa satellite jijjiire', destination_set: 'Iddoo xumuraa kaaʼeera', recalculating_route: 'Karaa irra deebi\'i shallagaa jirra...', arrived_destination: 'Iddoo xumuraa keetti gaʼe', live_routing_active: 'ライブ ルーティング Socho\'a', remaining_distance: 'Hafe' },
                location_details: 'Iddoo Koo',
                latitude: 'Latitude',
                longitude: 'Longitude',
                accuracy: 'Sirrii',
                nearby_pois: 'Bakka Dhihoo',
                all_categories: 'Gosa Hunda',
                no_nearby_pois: 'Bakka Dhihoo hin argamne',
                navigate: 'Deemi',
                poi: { building: 'Ijaarsa', category: 'Gosa', floors: 'Gadi fageenya', opening_hours: 'Saʼaatii', description: 'Ibsa', departments: 'Kutaa', facilities: 'Tajaajiloota', contact: 'Ittiin wal qunnamu', location: 'Iddoo', set_destination: 'Iddoo akka Xumuraa kaa' },
                selection: {
                    start_label: 'Iddoo Jalqabaa',
                    end_label: 'Iddoo Xumuraa',
                    or_pick_from_list: 'Yookiin tarree irraa filadhu:',
                    set_as_start: 'Iddoo Jalqabaa taasisu',
                    set_as_destination: 'Iddoo Xumuraa taasisu',
                    clear_selection: 'Haqu'
                },
                categories: {
                    title: 'Gosa',
                    academic: 'Ijaarsa Barnoota',
                    administrative: 'Tajaajila Bulchiinsa',
                    services: 'Tajaajilota',
                    recreational: 'Tajaajila Jireenyaa'
                },
                quick_links: {
                    title: 'Asxaa Fuula',
                    library: 'Mana Kitaaba Guddaa',
                    cafeteria: 'Kaafee',
                    admin: 'Ijaarsa Bulchiinsa',
                    student_center: 'Giddugaleessa Barattootaa'
                },
                footer: {
                    title: 'DTU Navigation',
                    description: 'Sirna daandii kaampasii Debre Tabor University, barattoota, hojjettoota fi daawwattoota gargaara.',
                    quick_links_title: 'Asxaa Fuula',
                    links: { home: 'Mana', map: 'Kaartaa', buildings: 'Tarree Ijaarsa', events: 'Taateewwan' },
                    resources_title: 'Qabeenya',
                    resources: { feedback: 'Yaada', help: 'Gargaarsa', mobile: 'Appii Mobile', accessibility: 'Dandeettii Gahumsaa' },
                    contact_title: 'Nuti quunnamu',
                    contact: { address: 'Debre Tabor, Ethiopia', phone: '+251-58-1410495', email: 'info@dtu.edu.et', hours: 'Dilbata-Guyyaa: 8:00 - 17:00' },
                    copyright: '© 2025 Debre Tabor University. Hunda mirgi eeyyamame.'
                }
            }
        };
    }

    applyTranslations() {
        try {
            const t = this.translations[this.currentLanguage] || this.translations.en;

            // Generic attribute-based translations (data-i18n, data-i18n-placeholder)
            document.querySelectorAll('[data-i18n]').forEach(el => {
                try {
                    const key = el.getAttribute('data-i18n');
                    const parts = key.split('.');
                    let v = t;
                    for (const p of parts) {
                        if (!v) break;
                        v = v[p];
                    }
                    if (v) {
                        // preserve HTML for headings that include icons — only replace text nodes when safe
                        if (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea') {
                            el.placeholder = v;
                        } else {
                            el.textContent = v;
                        }
                    }
                } catch (e) { /* non-fatal per-element */ }
            });

            document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
                try {
                    const key = el.getAttribute('data-i18n-placeholder');
                    const parts = key.split('.');
                    let v = t;
                    for (const p of parts) {
                        if (!v) break;
                        v = v[p];
                    }
                    if (v) el.placeholder = v;
                } catch (e) {}
            });

            // Special: the hero heading may include icons; update innerText while preserving markup where appropriate
            const heroTitle = document.querySelector('[data-i18n="hero.title"]');
            if (heroTitle) heroTitle.textContent = (t.hero && t.hero.title) || heroTitle.textContent;
            const heroSubtitle = document.querySelector('[data-i18n="hero.subtitle"]');
            if (heroSubtitle) heroSubtitle.textContent = (t.hero && t.hero.subtitle) || heroSubtitle.textContent;

            // Update calculate button text
            const calcBtn = document.getElementById('calculate-route-text');
            if (calcBtn && t.search && t.search.calculate_route) calcBtn.textContent = t.search.calculate_route;

            // Update route labels if present
            if (t.route) {
                const rtTitle = document.querySelector('[data-i18n="route.title"]');
                if (rtTitle) rtTitle.textContent = t.route.title || rtTitle.textContent;
                const rDist = document.querySelector('[data-i18n="route.distance"]');
                if (rDist) rDist.textContent = t.route.distance || rDist.textContent;
                const rTime = document.querySelector('[data-i18n="route.estimated_time"]');
                if (rTime) rTime.textContent = t.route.estimated_time || rTime.textContent;
                const rType = document.querySelector('[data-i18n="route.type"]');
                if (rType) rType.textContent = t.route.type || rType.textContent;
            }

            // Update nav links using structured nav keys
            if (t.nav) {
                document.querySelectorAll('.nav-link').forEach(link => {
                    const key = link.getAttribute('data-i18n');
                    if (!key) return;
                    const parts = key.split('.');
                    let v = t;
                    for (const p of parts) { if (!v) break; v = v[p]; }
                    if (v) link.textContent = v;
                });
            }

        } catch (e) { console.warn('applyTranslations error', e); }
    }

    // --- Socket / Real-time ---
    setupSocket() {
        try {
            if (window.io && !this.socket) {
                this.socket = window.io();

                // Log connection status
                this.socket.on('connect', () => {
                    console.log('Socket.io connected:', this.socket.id);
                    // Join broadcast room for all users (authenticated and unauthenticated)
                    try {
                        this.socket.emit('join-broadcast');
                        console.log('[setupSocket] Joined broadcast room');
                    } catch (e) {
                        console.warn('[setupSocket] Failed to join broadcast room:', e);
                    }
                });

                this.socket.on('disconnect', () => {
                    console.log('Socket.io disconnected');
                });

                // general notifications
                    this.socket.on('notification', (payload) => { this.addNotification(payload); });
                    // server uses 'new-notification' for per-user notifications
                    this.socket.on('new-notification', (payload) => {
                        const notif = payload && payload.notification ? payload.notification : payload;
                        this.addNotification(notif);
                    });

                    // broadcast notifications (for all users)
                    this.socket.on('broadcast-notification', (payload) => {
                        console.log('Received broadcast-notification:', payload);
                        this.addNotification(payload);
                    });

                // route updates (server can push polyline updates)
                this.socket.on('route-update', (payload) => {
                    try {
                        if (payload && payload.path_data) {
                            // update existing route layer or draw new
                            if (this.routeLayer) this.map.removeLayer(this.routeLayer);
                            this.routeLayer = L.polyline(payload.path_data.coordinates.map(c => [c[1], c[0]]), { color: '#ff6f00', weight: 5 }).addTo(this.map);
                            // if tracking marker exists, reposition
                            if (this.trackingMarker && payload.path_data.coordinates.length) {
                                const pt = payload.path_data.coordinates[0];
                                this.trackingMarker.setLatLng([pt[1], pt[0]]);
                            }
                        }
                    } catch (e) { console.warn('route-update handling failed', e); }
                });

                // admin events
                this.socket.on('admin-notify', (payload) => {
                    this.addNotification(payload);
                });

                // settings-updated: update campus bounds live
                this.socket.on('settings-updated', (payload) => {
                    try {
                        if (payload && payload.campusGeo) {
                            this.campusGeo = payload.campusGeo;
                            this.dtuCoordinates = payload.center ? [payload.center.lat, payload.center.lng] : [ (payload.campusGeo.north + payload.campusGeo.south)/2, (payload.campusGeo.east + payload.campusGeo.west)/2 ];
                            // update bounds
                            this.campusBounds = L.latLngBounds([this.campusGeo.south, this.campusGeo.west], [this.campusGeo.north, this.campusGeo.east]);
                            // redraw box
                            try { this.drawCampusBoundingBox(); } catch (e) {}
                        }
                    } catch (e) { console.warn('settings-updated handling failed', e); }
                });
            }
        } catch (e) { console.warn('Socket setup failed', e); }
    }

    addNotification(payload) {
        try {
            const item = {
                id: payload && payload.id ? payload.id : String(Date.now()),
                title: payload.title || payload.message || 'Notification',
                message: payload.message || '',
                createdAt: payload.createdAt || new Date().toISOString()
            };
            console.log('[addNotification] adding:', item);
            this.notifications.unshift(item);
            console.log('[addNotification] notifications after add:', this.notifications);
            // increase unread count when a new notification arrives
            try {
                const token = localStorage.getItem('authToken');
                if (token) {
                    this.unreadCount = (this.unreadCount || 0) + 1;
                } else {
                    // for unauthenticated visitors, keep count equal to local list
                    this.unreadCount = this.notifications.length;
                }
            } catch (e) { this.unreadCount = this.notifications.length; }
            console.log('[addNotification] unreadCount:', this.unreadCount);
            this.renderNotificationsDropdown();
            // show a toast as well
            this.showToast(item.title, 'info');
        } catch (e) { console.warn('addNotification error', e); }
    }

    // triggerSampleNotification removed (broadcast/test notification UI removed)

    // --- Live tracking helpers ---
    startRouteTracking(route) {
        try {
            this.stopRouteTracking();
            if (!route || !route.path_data || !route.path_data.coordinates) return;
            const coords = route.path_data.coordinates.map(c => [c[1], c[0]]);
            if (!coords.length) return;

            // create/position tracking marker
            this.trackingMarker = L.circleMarker(coords[0], { radius: 7, color: '#ff4d4f', fillColor: '#ff4d4f' }).addTo(this.map);
            this.isTracking = true;

            // animate marker along coordinates
            let idx = 0;
            this._trackingInterval = setInterval(() => {
                if (!this.isTracking) return;
                idx++;
                if (idx >= coords.length) {
                    // stop when done
                    this.stopRouteTracking();
                    return;
                }
                this.trackingMarker.setLatLng(coords[idx]);
                // optionally emit position to server so other users/admins can see movement
                try { if (this.socket) this.socket.emit('route-follow', { lat: coords[idx][0], lng: coords[idx][1] }); } catch (e) {}
            }, 1200);
        } catch (e) { console.warn('startRouteTracking error', e); }
    }

    stopRouteTracking() {
        this.isTracking = false;
        if (this._trackingInterval) {
            clearInterval(this._trackingInterval);
            this._trackingInterval = null;
        }
        if (this.trackingMarker) {
            try { this.map.removeLayer(this.trackingMarker); } catch (e) {}
            this.trackingMarker = null;
        }
    }

    initializePOIData() {
        // If a full POI set is provided by the page (window.allPOIs), use it.
        try {
            if (typeof window !== 'undefined' && Array.isArray(window.allPOIs) && window.allPOIs.length) {
                this.pois = window.allPOIs;
                return;
            }
        } catch (e) {}

        // Try to fetch POIs from backend
        this.fetchPOIsFromBackend().catch(() => {
            // If backend fetch fails, use hardcoded POIs
            this.pois = [
            // canonical POIs copied from backend/data/all_pois.js — blocks 1..50 + services
           {
                id: 'Main Gate',
                name: 'Main Gate',
                description: 'The gate all visitors and university members enter from',
                building: 'Main Gate',
                category: 'Services',
                latitude: 11.85073446601364,
                longitude:38.039281122927264,
                opening_hours: '7:00 AM - 7:30 PM',
                tags: ['Services', 'entrance'],
               details: { type: 'Entrance Gate', contact: 'security@dtu.edu', phone: '+251-58-100-100' }
            },
                        {
                id: 'Gate 002',
                name: 'Gate 002',
                description: 'The gate all visitors and university members enter from',
                building: 'Gate Two',
                category: 'Services',
                latitude: 11.849633841526893,
                longitude: 38.04189831297064,
                opening_hours: '7:00 AM - 7:30 PM',
                tags: ['Services', 'entrance'],
               details: { type: 'Entrance Gate', contact: 'security@dtu.edu', phone: '+251-58-100-100' }
            },
            {
                id: 'block_001',
                name: 'Block 001',
                description: 'Student dormitory and residential services.',
                building: 'Block 001',
                category: 'Services',
                latitude: 11.850444604094225,
                longitude: 38.0456641561036,
                floor: '3 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: {
                    type: 'Dormitory Block'
                }
            },
            {
                id: 'block_003',
                name: 'Block 003',
                description: 'Student dormitory and residential services.',
                building: 'Block 003',
                category: 'Services',
                latitude: 11.850831168820156,
                longitude: 38.045143402317265,
                floor: '3 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: {
                    type: 'Dormitory Block'
                }
            },
            {
                id: 'block_004',
                name: 'Block 004',
                description: 'Student dormitory and residential services.',
                building: 'Block 004',
                category: 'Services',
                latitude:  11.8510978984387,
                longitude: 38.04555027499956,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
            {
                id: 'Toilet',
                name: 'Toilet',
                description: 'public facility for all campus users',
                building: 'Toilet',
                category: 'Services',
                latitude: 11.851381919009683,
                longitude: 38.04485071364811,
                floor: '1 Floors',
                opening_hours: '24/7',
                tags: ['toilet'],
                details: { type: 'public toilet'}
            },
            {
                id: 'block_005',
                name: 'Block 00',
                description: 'Student dormitory and residential services.',
                building: 'Block 00',
                category: 'Services',
                latitude:  11.851626040987025,
                longitude: 38.04531963332706,
                floor: '3 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: {
                    type: 'Dormitory Block'
                }
            },
            {
                id: 'block_007',
                name: 'Block 007',
                description: 'Student dormitory and residential services.',
                building: 'Block 007',
                category: 'Services',
                latitude:  11.852170266779547,
                longitude: 38.045143312846925,
                floor: '3 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
            {
                id: 'block_009',
                name: 'Block 009',
                description: 'Student dormitory and residential services.',
                building: 'Block 009',
                category: 'Services',
                latitude: 11.85238023827446,
                longitude: 38.044437487763275,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
            {
                id: 'block_010',
                name: 'Block 010',
                description: 'Student dormitory and residential services.',
                building: 'Block 010',
                category: 'Services',
                latitude: 11.852855340351656,
                longitude: 38.04442051266745,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
                        {
                id: 'Toilet',
                name: 'Toilet',
                description: 'public facility for all campus users',
                building: 'Toilet',
                category: 'Services',
                latitude: 11.852548387799493,
                longitude: 38.04400181103395,
                floor: '1 Floors',
                opening_hours: '24/7',
                tags: ['toilet'],
                details: { type: 'public toilet'}
            },
            {
            id: 'block_013',
            name: 'Block 013',
            description: 'Academic building.',
            building: 'Block 013',
            category: 'academic',
            latitude: 11.852969027704797,
            longitude: 38.04485597192887,
            floor: 'Lecturehall',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Agreeculture'],
            details: { type: 'Academic Block',
            departments: ['Agriculture Services'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },
                        {
                id: 'block_012',
                name: 'Block 012',
                description: 'Student dormitory and residential services.',
                building: 'Block 012',
                category: 'Services',
                latitude: 11.853244195288974,
                longitude: 38.04402698856162,
                floor: '3 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
             { id: 'block_015',
                name: 'Block 015',
                description: 'College of natural and computational science ',
                building: 'Block 015', 
                category: 'administrative', 
                latitude: 11.853208821312155,
                longitude: 38.04463174193922,  
                floor: '2 Floors', 
                opening_hours: '8:00 AM - 11:00 PM', 
                tags: ['Adminstration'], 
                details: { type: 'store block', 
                departments: ['more for social student'] }
             }, 

              { 
                id: 'block_043',
                name: 'Block 043',
                description: 'Department of Computer science ',
                building: 'Block 043', 
                category: 'administrative', 
                latitude: 11.85495472764422,
                longitude: 38.040990136813285,  
                floor: '2 Floors', 
                opening_hours: '8:00 AM - 11:00 PM', 
                tags: ['Adminstration'], 
                details: { type: 'head block', 
                departments: ['for technology student'] }
             }, 
             
            {
                id: 'Filamingo Lounge',
                name: 'Filamingo Lounge',
                description: 'Student cafeteria serving meals, snacks and beverages.',
                building: 'Student Center Cafeteria',
                category: 'services',
                latitude: 11.85370685678202,
                longitude: 38.04427643097586,
                floor: 'Ground Floor',
                opening_hours: "7:00 AM- 23:00 PM",
                tags: ['food', 'dining', 'cafe'],
                details: {
                    type: 'Dining',
                    departments: ['Food Services'],
                    facilities: ['seatings'],
                    contact: 'Cafeteria Manager: +251-58-200-002' }
            },
                         
            {
                id: 'Bus Station',
                name: 'Bus Station',
                description: 'parking service',
                building: 'Bus Station',
                category: 'services',
                latitude: 11.854342878985694,
                longitude:  38.040344686028675,
                floor: 'Ground Floor',
                opening_hours: "7:00 AM- 23:00 PM",
                tags: ['parking'],
                details: {
                    type: 'Station',
                    contact: ' Manager: +251-58-200-002' }
            },
                                     
            {
                id: 'HAll',
                name: 'Block 200',
                description: 'program and meeting center',
                building: 'Aleqa Tekle Hall',
                category: 'services',
                latitude: 11.853742451761688,
                longitude:  38.04264073392233,
                floor: 'Ground Floor',
                opening_hours: "7:00 AM- 23:00 PM",
                tags: ['hall'],
                details: {
                    type: 'hall',
                    contact: ' Manager: +251-58-200-002' }
            },
            {
            id: 'block_017',
            name: 'Block 017',
            description: 'Academic building.',
            building: 'Block 017',
            category: 'academic',
            latitude: 11.853815897475188,
            longitude: 38.04463766468222,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Agreeculture'],
            details: { type: 'Academic Block',
            departments: ['Agriculture Services'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },

         {
            id: 'block_044',
            name: 'Block 044',
            description: 'Academic building.',
            building: 'Block 044',
            category: 'academic',
            latitude: 11.855193474233642,
            longitude: 38.04086518060699,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Techno'],
            details: { type: 'Academic Block',
            departments: ['Acadamic Services'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },
         
         {
            id: 'block_046',
            name: 'Block 046',
            description: 'Academic building.',
            building: 'Block 046',
            category: 'academic',
            latitude: 11.855916504221828,
            longitude: 38.039909146310556,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Techno'],
            details: { type: 'Academic Block',
            departments: ['Acadamic Services'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },

             { 
                id: 'block_014',
                name: 'Block 014',
                description: 'college of agriculture and environmental science ',
                building: 'Block 014', 
                category: 'administrative', 
                latitude: 11.853333630804626,
                longitude: 38.04505005205512,  
                floor: '2 Floors', 
                opening_hours: '8:00 AM - 11:00 PM', 
                tags: ['Adminstration'], 
                details: { type: 'store block', 
                departments: ['more for Natural student'] }
             },
            {
            id: 'block_141',
            name: 'Block 141',
            description: 'Electrical and computer engineering laboratory',
            building: 'Block 141',
            category: 'academic',
            latitude: 11.85341623613661,
            longitude: 38.04558731302321,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Engineering'],
            details: { type: 'Academic Block',
            departments: ['Laboratory Services'],
            facilities: ['Laboratory Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },

         {
            id: 'block_147',
            name: 'Block 147',
            description: 'Computer Science and IT Lab Class',
            building: 'Block 147',
            category: 'academic',
            latitude: 11.855629464846446,
            longitude: 38.04026636036565,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Institution of Technology'],
            details: { type: 'Academic Block',
            departments: ['Lab Services'],
            facilities: ['Laboratory Rooms','Study Areas','computers'],
            contact: '+251-58-100-130' }
         },
           {
            id: 'block_019',
            name: 'Block 019',
            description: 'Mechanical engineering laboratory',
            building: 'Block 019',
            category: 'academic',
            latitude: 11.854160612197752,
            longitude: 38.045768742760906,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Engineering'],
            details: { type: 'Academic Block',
            departments: ['Laboratory Services'],
            facilities: ['Laboratory Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },
         {
            id: 'block_020',
            name: 'Block 020',
            description: 'Refrigeration &air conditioning laboratory',
            building: 'Block 020',
            category: 'academic',
            latitude: 11.854127097643087,
            longitude: 38.045343128577784,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Engineering'],
            details: { type: 'Academic Block',
            departments: ['Laboratory Services'],
            facilities: ['Laboratory Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },

        {
            id: 'block_073',
            name: 'Block 073',
            description: 'Academic building.',
            building: 'Block 073',
            category: 'academic',
            latitude: 11.854471733239674,
            longitude: 38.04439438190988,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Social Sceince'],
            details: { type: 'Academic Block',
            departments: ['Social science'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },
          { id: 'block_088',
            name: 'Block 088',
            description: 'college of social science and humanities ',
            building: 'Block 088', 
            category: 'administrative', 
            latitude: 11.854364695704247,
            longitude: 38.04484303130451,  
            floor: '2 Floors', 
            opening_hours: '8:00 AM - 11:00 PM', 
            tags: ['Adminstration'], 
            details: { type: 'Administrative Block', 
            departments: ['more for Social student'] }
             },

         {
            id: 'block_089',
            name: 'Block 089',
            description: 'Academic building.',
            building: 'Block 089',
            category: 'academic',
            latitude: 11.85468181092027,
            longitude: 38.0452106071535,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Social Sceince'],
            details: { type: 'Academic Block',
            departments: ['Social science'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },
         { id: 'block_091',
            name: 'Block 091',
            description: 'DTU guna tana integrated field research and development center ',
            building: 'Block 091', 
            category: 'administrative', 
            latitude: 11.854491287828843,
            longitude: 38.045687908280414,  
            floor: '2 Floors', 
            opening_hours: '8:00 AM - 11:00 PM', 
            tags: ['Adminstration'], 
            details: { type: 'Administrative Block', 
            departments: ['more for Social student'] }
             },

            { 
            id: 'block_143',
            name: 'Block 143',
            description: ' Institution of Technology Department of all engineering Dean office ',
            building: 'Block 143', 
            category: 'administrative', 
            latitude: 11.855932266721412,
            longitude:  38.040802682024975,  
            floor: '2 Floors', 
            opening_hours: '8:00 AM - 11:00 PM', 
            tags: ['Adminstration'], 
            details: { type: 'Administrative Block', 
            departments: ['more for Social student'] }
             },
             
            { 
            id: 'block_051',
            name: 'Block 051',
            description: ' Institution of Technology Department of CS and IT Dean office ',
            building: 'Block 051', 
            category: 'administrative', 
            latitude: 11.856251441013292,
            longitude: 38.04037700602661,  
            floor: '2 Floors', 
            opening_hours: '8:00 AM - 11:00 PM', 
            tags: ['Adminstration'], 
            details: { type: 'Administrative Block', 
            departments: ['more for Social student'] }
             },

              {
            id: 'block_094',
            name: 'Block 094',
            description: 'chemical engineering &hydraulics engineering Laboratory',
            building: 'Block 094',
            category: 'academic',
            latitude: 11.854257406505164,
            longitude: 38.046325426039246,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Engineering'],
            details: { type: 'Academic Block',
            departments: ['Laboratory Services'],
            facilities: ['Laboratory Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },

         
         {
            id: 'block_095',
            name: 'Block 095',
            description: 'Academic building.',
            building: 'Block 095',
            category: 'academic',
            latitude: 11.854243729324008,
            longitude: 38.04661906935241,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Social Sceince'],
            details: { type: 'Academic Block',
            departments: ['Social science'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },
         {
            id: 'block_140',
            name: 'Block 140',
            description: 'Academic building.',
            building: 'Block 140',
            category: 'academic',
            latitude: 11.854174163493465,
            longitude: 38.04707696411415,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Social Sceince'],
            details: { type: 'Academic Block',
            departments: ['Social science'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },

           {
            id: 'block_094',
            name: 'Block 094',
            description: 'DTU stem center',
            building: 'Block 094',
            category: 'academic',
            latitude: 11.853861370162216,
            longitude: 38.04753686246369,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Engineering'],
            details: { type: 'Academic Block',
            departments: ['Laboratory Services'],
            facilities: ['Laboratory Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },
        {   
              id: 'block_104',
                name: 'Block 104',
                description: 'Machine shope',
                building: 'Block 104',
                category: 'Services',
                latitude: 11.853495279500358,
                longitude: 38.048119721402,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['store room'],
                details: { type: 'store shoped material'}
            },
            { id: 'block_150',
            name: 'Block 150',
            description: 'Collage of sport science',
            building: 'Block 150', 
            category: 'administrative', 
            latitude: 11.853903824274182,
            longitude: 38.048633873733735,  
            floor: '2 Floors', 
            opening_hours: '8:00 AM - 11:00 PM', 
            tags: ['Adminstration'], 
            details: { type: 'Administrative Block', 
            departments: ['more for Social student'] }
             },
          {
            id: 'block_148',
            name: 'Block 148',
            description: 'Acadamic Building',
            building: 'Block 148',
            category: 'academic',
            latitude: 11.854355218689545,
            longitude: 38.04800962368293,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Health'],
            details: { type: 'Academic Block',
            departments: ['Medicine'],
            facilities: ['Laboratory Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },
          {
            id: 'block_101',
            name: 'Block 101',
            description: 'Academic building.',
            building: 'Block 101',
            category: 'academic',
            latitude: 11.854421105031808,
            longitude: 38.04784505796814,
            floor: 'Lecturehall',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Agreeculture'],
            details: { type: 'Academic Block',
            departments: ['Agriculture Services'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },
          {
            id: 'block_099',
            name: 'Block 099',
            description: 'Academic building.',
            building: 'Block 099',
            category: 'academic',
            latitude: 11.854705148799631,
            longitude: 38.0472137241067,
            floor: 'Lecturehall',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Agreeculture'],
            details: { type: 'Academic Block',
            departments: ['Agriculture Services'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },
          {
            id: 'block_058',
            name: 'Block 058',
            description: 'Academic building.',
            building: 'Block 058',
            category: 'academic',
            latitude: 11.854887991873738,
            longitude: 38.04646881356634,
            floor: 'Lecturehall',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Agreeculture'],
            details: { type: 'Academic Block',
            departments: ['Agriculture Services'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },

             { id: 'block_092',
            name: 'Block 092',
            description: 'Collage of Health Science',
            building: 'Block 091', 
            category: 'administrative', 
            latitude: 11.854938446228148,
            longitude: 38.045901019484155,  
            floor: '2 Floors', 
            opening_hours: '8:00 AM - 11:00 PM', 
            tags: ['Adminstration'], 
            details: { type: 'Administrative Block', 
            departments: ['more for Social student'] }
             },
             
             { id: 'block_076',
            name: 'Block 076',
            description: 'Collage of Business and Economics',
            building: 'Block 091', 
            category: 'administrative', 
            latitude: 11.854857593498805,
            longitude: 38.04480340243924,  
            floor: '2 Floors', 
            opening_hours: '8:00 AM - 11:00 PM', 
            tags: ['Adminstration'], 
            details: { type: 'Administrative Block', 
            departments: ['more for Social student'] }
             },
             {
                id: 'Central Lounge',
                name: 'Central Lounge',
                description: 'Student cafeteria serving meals, snacks and beverages.',
                building: 'Student Center Cafeteria',
                category: 'services',
                latitude: 11.854645032122008,
                longitude: 38.04422934619068,
                floor: 'Ground Floor',
                opening_hours: "7:00 AM- 23:00 PM",
                tags: ['food', 'dining', 'cafe'],
                details: {
                    type: 'Dining',
                    departments: ['Food Services'],
                    facilities: ['seatings'],
                    contact: 'Cafeteria Manager: +251-58-200-002' }
            },
              {
                id: 'block_078',
                name: 'Block 078',
                description: 'Student dormitory and residential services.',
                building: 'Block 078',
                category: 'Services',
                latitude:  11.855352392612945,
                longitude: 38.04432819379178,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },

           {
                id: 'block_079',
                name: 'Block 079',
                description: 'Student dormitory and residential services.',
                building: 'Block 079',
                category: 'Services',
                latitude:  11.85561161550549,
                longitude: 38.0442126964969,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
            
           {
                id: 'block_077',
                name: 'Block 077',
                description: 'Student dormitory and residential services.',
                building: 'Block 077',
                category: 'Services',
                latitude:  11.855216879172533,
                longitude: 38.044615934785135,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                        
           {
                id: 'block_080',
                name: 'Block 080',
                description: 'Student dormitory and residential services.',
                building: 'Block 080',
                category: 'Services',
                latitude:  11.855974509828012,
                longitude: 38.04454680194544,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                                    
           {
                id: 'block_081',
                name: 'Block 081',
                description: 'Student dormitory and residential services.',
                building: 'Block 081',
                category: 'Services',
                latitude:  11.855542230386893,
                longitude: 38.045049229778556,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                                                
           {
                id: 'block_082',
                name: 'Block 082',
                description: 'Student dormitory and residential services.',
                building: 'Block 082',
                category: 'Services',
                latitude:  11.855398675015058, 
                longitude: 38.045592049100996,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },

             {
                id: 'block_083',
                name: 'Block 083',
                description: 'Student dormitory and residential services.',
                building: 'Block 083',
                category: 'Services',
                latitude:  11.856099129623715,
                longitude: 38.045194190568985, 
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
            
             {
                id: 'block_084',
                name: 'Block 084',
                description: 'Student dormitory and residential services.',
                building: 'Block 084',
                category: 'Services',
                latitude:  11.855701589553394,
                longitude:  38.04593100087436, 
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                        
             {
                id: 'block_097',
                name: 'Block 097',
                description: 'Student dormitory and residential services.',
                building: 'Block 097',
                category: 'Services',
                latitude:  11.855339123254145,
                longitude:  38.046733994222386, 
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                                    
             {
                id: 'block_123',
                name: 'Block 123',
                description: 'Student dormitory and residential services.',
                building: 'Block 123',
                category: 'Services',
                latitude:  11.856098849804559,
                longitude:  38.046435183697156, 
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                                                
             {
                id: 'block_124',
                name: 'Block 124',
                description: 'Student dormitory and residential services.',
                building: 'Block 124',
                category: 'Services',
                latitude:  11.855688551011605,
                longitude:  38.04725443570609, 
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                                                            
             {
                id: 'block_098',
                name: 'Block 098',
                description: 'Student dormitory and residential services.',
                building: 'Block 098',
                category: 'Services',
                latitude:  11.855085014964994,
                longitude:  38.047522839661795, 
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                                                                        
             {
                id: 'block_125',
                name: 'Block 125',
                description: 'Student dormitory and residential services.',
                building: 'Block 125',
                category: 'Services',
                latitude:  11.855887307337838,
                longitude:  38.04742318529109, 
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                                                                                    
             {
                id: 'block_126',
                name: 'Block 126',
                description: 'Student dormitory and residential services.',
                building: 'Block 126',
                category: 'Services',
                latitude:  11.855354241417926,
                longitude:  38.048018334020256, 
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                                                                                                
             {
                id: 'block_100',
                name: 'Block 100',
                description: 'Student dormitory and residential services.',
                building: 'Block 100',
                category: 'Services',
                latitude:  11.854662544052122,
                longitude:  38.04827983029821, 
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                                                                                                            
             {
                id: 'block_128',
                name: 'Block 128',
                description: 'Student dormitory and residential services.',
                building: 'Block 128',
                category: 'Services',
                latitude:  11.855501315241902, 
                longitude:  38.048328061351135, 
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                                                                                                                        
             {
                id: 'block_131',
                name: 'Block 131',
                description: 'Student dormitory and residential services.',
                building: 'Block 131',
                category: 'Services',
                latitude:  11.855050345801871, 
                longitude:  38.048559456990205,  
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                                                                                                                                    
             {
                id: 'block_134',
                name: 'Block 134',
                description: 'Student dormitory and residential services.',
                building: 'Block 134',
                category: 'Services',
                latitude:  11.854367184471057,
                longitude:  38.04915017473499,   
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },
                                                                                                                                                
             {
                id: 'block_133',
                name: 'Block 133',
                description: 'Student dormitory and residential services.',
                building: 'Block 133',
                category: 'Services',
                latitude:  11.854669847018876,
                longitude:  38.04937868318984, 
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block' }
            },

            { id: 'block_012', 
                name: 'Block 012', 
                description: 'Student dormitory and residential services.', 
                building: 'Block 012', 
                category: 'Services', 
                latitude: 11.853244195288974, 
                longitude: 38.043977883335536, 
                floor: '2 Floors', 
                opening_hours: '24/7', 
                tags: ['dormitory', 'residential'], 
                details: { type: 'Dormitory Block'} },
        
            { id: 'Social library', 
                name: 'social library', 
                description: 'social students library with extensive collections, reading material for social students.', 
                building: 'Library building', 
                category: 'Services', 
                latitude: 11.852187528807791, 
                longitude: 38.04564554396622, 
                floor: '2 Floors', 
                opening_hours: '24/7', 
                tags: ['library','study'], 
                details: { type: 'Library', 
                departments: ['All but specialy social departement'], 
                facilities: ['Books','Study Areas','discusion class'], 
                contact: '+251-58-100-140' } },

            { 
                id: 'Supermarket', 
                name: 'Supermarket', 
                description: 'shoping place , fast food and gamezone', 
                building: 'Super market', 
                category: 'Services', 
                latitude: 11.853315805906176, 
                longitude: 38.045744757214635, 
                floor: 'conteners', 
                opening_hours: '7:00 AM - 22:00 PM', 
                tags: ['shoping material','fastfood'] , 
                details: { type: 'shoping center', 
                    contact: '+251-58-100-170' } },

            { 
                id: 'GameZone', 
                name: 'GameZone', 
                description: 'gamezone for reacretion', 
                building: 'Game Zone', 
                category: 'Recreational', 
                latitude: 11.853703651664624, 
                longitude:  38.04600224928718, 
                floor: 'Shelter', 
                opening_hours: '7:00 AM - 22:00 PM',
                 tags: ['tense, pool, jotene'], 
                details: { type: 'recreational center'}
             },
             
            { 
                id: 'Stadium', 
                name: 'Stadium', 
                description: 'Debre Tabor University Stadium', 
                building: 'Stadium', 
                category: 'Recreational', 
                latitude: 11.85116789933743, 
                longitude: 38.04904481251885,
                 floor: 'ground', 
                opening_hours: '7:00 AM - 22:00 PM', 
                tags: ['football'], 
                details: { type: 'recreational center'}
             },
            {
                id: 'library',
                name: 'Main Library',
                description: 'Central library with extensive collections, reading rooms and computer access.',
                building: 'Library Building',
                category: 'services',
                latitude: 11.853379669819923,
                longitude: 38.043594689353185,
                floor: '3 Floors',
                opening_hours: '24/7 for students with ID',
                tags: ['library', 'study', 'computers'],
                details: {
                    type: 'Library',
                    departments: ['Library Services', 'Digital Collections'],
                    facilities: ['Reading Areas', 'Computer Lab', ],
                    contact: 'Library Desk: +251-58-200-001\\nEmail: library@dtu.edu.et'
                }
            },
            {
                id: ' Social cafeteria',
                name: 'Social Cafeteria',
                description: 'Student cafeteria serving meals, snacks and beverages.',
                building: 'Student Center Cafeteria',
                category: 'services',
                latitude: 11.854143854877416,
                longitude: 38.043629627546146,
                floor: 'Ground Floor',
                opening_hours: "Breakfast: 7:00 AM - 8:00 AM; Lunch: 11:30 AM - 1:00 PM; Dinner: 6:00 PM - 8:00 PM",
                tags: ['food', 'dining', 'cafe'],
                details: {
                    type: 'Dining',
                    departments: ['Food Services'],
                    facilities: ['seatings'],
                    contact: 'Cafeteria Manager: +251-58-200-002'
                }
            },
                        {
                id: 'Main cafeteria',
                name: 'Main Cafeteria',
                description: 'Student cafeteria serving meals, snacks and beverages.',
                building: 'Student Center Cafeteria',
                category: 'services',
                latitude: 11.85483949915535,
                longitude: 38.04262877790159,
                floor: 'Ground Floor',
                opening_hours: "Breakfast: 7:00 AM - 8:00 AM; Lunch: 11:30 AM - 1:00 PM; Dinner: 6:00 PM - 8:00 PM",
                tags: ['food', 'dining', 'cafe'],
                details: {
                    type: 'Dining',
                    departments: ['Food Services'],
                    facilities: ['seatings'],
                    contact: 'Cafeteria Manager: +251-58-200-002'
                }
            },
            {
                id: 'clinic',
                name: 'Campus Clinic',
                description: 'Primary health clinic providing basic medical care and first aid.',
                building: 'Health Centre',
                category: 'services',
                latitude: 11.85390846339367,
                longitude: 38.041739006344606,
                floor: 'Ground Floor',
                opening_hours: '8:00 AM - 5:00 PM',
                tags: ['health', 'clinic', 'medical'],
                details: {
                    type: 'Health Clinic',
                    departments: ['General Practice', 'First Aid'],
                    facilities: ['Consulting Rooms', 'Pharmacy (limited)'],
                    contact: 'Clinic Reception: +251-58-200-003'
                }
            },

            { id: 'block_035', 
                name: 'Block 035', 
                description: 'Student dormitory and residential services.', 
                building: 'Block 035', 
                category: 'Services', 
                latitude: 11.853492309470353, 
                longitude:  38.04217006568559, 
                floor: '2 Floors', 
                opening_hours: '24/7', 
                tags: ['dormitory', 'residential'], 
                details: { type: 'Dormitory Block'} },
                
            { id: 'block_034', 
                name: 'Block 034', 
                description: 'Student dormitory and residential services.', 
                building: 'Block 034', 
                category: 'Services', 
                latitude: 11.853229011448974, 
                longitude:  38.04216194723837, 
                floor: '2 Floors', 
                opening_hours: '24/7', 
                tags: ['dormitory', 'residential'], 
                details: { type: 'Dormitory Block'}
             },

                                
            { id: 'block_033', 
                name: 'Block 033', 
                description: 'Student dormitory and residential services.', 
                building: 'Block 033', 
                category: 'Services', 
                latitude: 11.852904821752974, 
                longitude:  38.041759615884814, 
                floor: '2 Floors', 
                opening_hours: '24/7', 
                tags: ['dormitory', 'residential'], 
                details: { type: 'Dormitory Block'} },
                
                                               
            { id: 'block_029', 
                name: 'Block 029', 
                description: 'Student dormitory and residential services.', 
                building: 'Block 029', 
                category: 'Services', 
                latitude: 11.853011135010753, 
                longitude:  38.041389471053925, 
                floor: '2 Floors', 
                opening_hours: '24/7', 
                tags: ['dormitory', 'residential'], 
                details: { type: 'Dormitory Block'}
             },

                                                            
            { id: 'block_030', 
                name: 'Block 030', 
                description: 'Student dormitory and residential services.', 
                building: 'Block 030', 
                category: 'Services', 
                latitude: 11.852440192930901, 
                longitude:  38.04111454464278, 
                floor: '2 Floors', 
                opening_hours: '24/7', 
                tags: ['dormitory', 'residential'], 
                details: { type: 'Dormitory Block'}
             },

                         {
                id: 'Techno library',
                name: 'Techno Library',
                description: 'Technology library with extensive collections, reading rooms and computer access.',
                building: 'Library Building',
                category: 'services',
                latitude: 11.852807480223815,
                longitude:  38.04090266024896,
                floor: '3 Floors',
                opening_hours: '24/7 for students with ID',
                tags: ['library', 'study', 'computers'],
                details: {
                    type: 'Library',
                    departments: ['Library Services', 'Digital Collections'],
                    facilities: ['Reading Areas', 'Computer Lab', ],
                    contact: 'Library Desk: +251-58-200-001\\nEmail: library@dtu.edu.et'
                }
            },

             {
            id: 'block_027',
            name: 'Block 027',
            description: 'Academic building.',
            building: 'Block 027',
            category: 'academic',
            latitude: 11.853224589885519,
            longitude: 38.04122105215366,
            floor: 'Lecturehall',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Freshman'],
            details: { type: 'Academic Block',
            departments: ['Teaching Services'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },

                      
         { id: 'Finance Office',
            name: 'Block 026',
            description: 'administer all that are  related to finance',
            building: 'Finance Office', 
            category: 'administrative', 
            latitude: 11.853570983574075,
            longitude: 38.041501521398246,  
            floor: '2 Floors', 
            opening_hours: '8:00 AM - 11:00 PM', 
            tags: ['Adminstration'], 
            details: { type: 'Administrative Block', 
            departments: [' for all student'] }
             },

            {
                id: 'Registration Office',
                name: 'Block 047',
                description: 'University administrative offices including registrar and finance.',
                building: 'Registration Office',
                category: 'administrative',
                latitude: 11.855052983731385,
                longitude: 38.041899171223875,
                floor: '3 Floors',
                opening_hours: '8:30 AM - 5:30 PM',
                tags: ['administration', 'offices'],
                details: { type: 'Administrative', departments: ['Registrar','Finance','HR'], facilities: ['Student Services','Meeting Rooms'], contact: 'Main Office: +251-58-200-004' }
            },
            
            {
                id: 'Registration Office',
                name: 'Block 155',
                description: 'University administrative offices including registrar and finance.',
                building: 'New Registration Office',
                category: 'administrative',
                latitude: 11.855748207184215,
                longitude:  38.04310459409404,
                floor: '3 Floors',
                opening_hours: '8:30 AM - 5:30 PM',
                tags: ['administration', 'offices'],
                details: { type: 'Administrative', departments: ['Registrar','Finance','HR'], facilities: ['Student Services','Meeting Rooms'], contact: 'Main Office: +251-58-200-004' }
            },

                        {
                id: 'Data Center',
                name: 'Block 037',
                description: 'University Data center offices to secure and store all datas of our university.',
                building: 'Data Center',
                category: 'administrative',
                latitude: 11.853995888586963,
                longitude:  38.0414098237261,
                floor: '3 Floors',
                opening_hours: '8:30 AM - 5:30 PM',
                tags: ['administration', 'offices'],
                details: { type: 'Administrative', departments: ['Registrar','Finance','HR'], facilities: ['Student Services','Meeting Rooms'], contact: 'Main Office: +251-58-200-004' }
            },

             {
            id: 'block_038',
            name: 'Block 038',
            description: 'Acadamic Building',
            building: 'Block 038',
            category: 'academic',
            latitude: 11.854033605864098,
            longitude: 38.04098464382685,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Freshman'],
            details: { type: 'Academic Block',
            departments: ['Freshman'],
            facilities: ['chairs','white boards'],
            contact: '+251-58-100-130' }
         },
         
             {
            id: 'block_042',
            name: 'Block 042',
            description: 'Acadamic Building',
            building: 'Block 042',
            category: 'academic',
            latitude: 11.854683040047707,
            longitude:  38.041506462045085,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['CS'],
            details: { type: 'Academic Block',
            departments: ['CS'],
            facilities: ['chairs','white boards'],
            contact: '+251-58-100-130' }
         },
            
             {
            id: 'block_039',
            name: 'Block 039',
            description: 'Mechanical engineering equipment store room',
            building: 'Block 039',
            category: 'academic',
            latitude: 11.853737836265895,
            longitude: 38.04072879793365,
            floor: '2 floors',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Engineering'],
            details: { type: 'Academic Block',
            departments: ['Store Services'],
            facilities: ['Store  Rooms'],
            contact: '+251-58-100-130' }
         },
                     {
                id: 'Tewodiros Lounge',
                name: 'Block 116',
                description: 'Student cafeteria serving meals, snacks and beverages.',
                building: 'Tewodiros Lounge',
                category: 'services',
                latitude: 11.854665998208764,
                longitude: 38.0421816575306,
                floor: 'Ground Floor',
                opening_hours: "7:00 AM- 23:00 PM",
                tags: ['food', 'dining', 'cafe'],
                details: {
                    type: 'Dining',
                    departments: ['Food Services'],
                    facilities: ['seatings'],
                    contact: 'Cafeteria Manager: +251-58-200-002' }
            },

            
             {
            id: 'block_048',
            name: 'Block 048',
            description: 'Academic building.',
            building: 'Block 048',
            category: 'academic',
            latitude: 11.855185813246122,
            longitude: 38.04150380555332,
            floor: 'Lecturehall',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Computer Science'],
            details: { type: 'Academic Block',
            departments: ['Teaching Services'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },
                    
             {
            id: 'block_052',
            name: 'Block 052',
            description: 'Academic building.',
            building: 'Block 052',
            category: 'academic',
            latitude: 11.856567518901544,
            longitude: 38.03967214417896,
            floor: 'Lecturehall',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Computer Science'],
            details: { type: 'Academic Block',
            departments: ['Teaching Services'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },
                  
             {
            id: 'block_049',
            name: 'Block 049',
            description: 'Academic building.',
            building: 'Block 049',
            category: 'academic',
            latitude: 11.855448809359443,
            longitude: 38.04105961506695,
            floor: 'Lecturehall',
            opening_hours: '8:00 AM - 11:00 PM',
            tags: ['Computer Science'],
            details: { type: 'Academic Block',
            departments: ['Teaching Services'],
            facilities: ['Tutorial Rooms','Study Areas'],
            contact: '+251-58-100-130' }
         },

         {
                id: 'block_053',
                name: 'Block 053',
                description: 'Student dormitory and residential services.',
                building: 'Block 053',
                category: 'Services',
                latitude: 11.855166113079502,
                longitude: 38.04210698552335,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
            
         {
                id: 'block_055',
                name: 'Block 055',
                description: 'Student dormitory and residential services.',
                building: 'Block 055',
                category: 'Services',
                latitude: 11.855920533486165,
                longitude: 38.0425339925094,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
                        
         {
                id: 'block_054',
                name: 'Block 054',
                description: 'Student dormitory and residential services.',
                building: 'Block 054',
                category: 'Services',
                latitude: 11.855416296317756,
                longitude:  38.04181529928553,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
                                    
         {
                id: 'block_056',
                name: 'Block 056',
                description: 'Student dormitory and residential services.',
                building: 'Block 056',
                category: 'Services',
                latitude: 11.85610569865501,
                longitude:  38.042272555162484,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
                                                
         {
                id: 'block_057',
                name: 'Block 057',
                description: 'Student dormitory and residential services.',
                building: 'Block 057',
                category: 'Services',
                latitude: 11.855674983740226, 
                longitude:  38.041530413211575,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
                                                            
         {
                id: 'block_058',
                name: 'Block 058',
                description: 'Student dormitory and residential services.',
                building: 'Block 058',
                category: 'Services',
                latitude: 11.856327234670859,  
                longitude:  38.04198581158507,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
                                                                      
         {
                id: 'block_061',
                name: 'Block 061',
                description: 'Student dormitory and residential services.',
                building: 'Block 061',
                category: 'Services',
                latitude: 11.856022400342482, 
                longitude:  38.041045432612144,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
                                                                                  
         {
                id: 'block_063',
                name: 'Block 063',
                description: 'Student dormitory and residential services.',
                building: 'Block 063',
                category: 'Services',
                latitude: 11.856521857960818, 
                longitude:  38.04173621443577,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
                                                                                              
         {
                id: 'block_062',
                name: 'Block 062',
                description: 'Student dormitory and residential services.',
                building: 'Block 062',
                category: 'Services',
                latitude: 11.856392175977987, 
                longitude:  38.04070841284211,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
                                                                                                        
         {
                id: 'block_064',
                name: 'Block 064',
                description: 'Student dormitory and residential services.',
                building: 'Block 064',
                category: 'Services',
                latitude: 11.85692157663165, 
                longitude: 38.04110650320722,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
                                                                                                                    
         {
                id: 'block_067',
                name: 'Block 067',
                description: 'Student dormitory and residential services.',
                building: 'Block 067',
                category: 'Services',
                latitude: 11.856731327896703, 
                longitude: 38.040133566836964,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
                                                                                                                               
         {
                id: 'block_068',
                name: 'Block 068',
                description: 'Student dormitory and residential services.',
                building: 'Block 068',
                category: 'Services',
                latitude: 11.857225564941364, 
                longitude:  38.04080694644412,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
                                                                                                                                           
         {
                id: 'block_144',
                name: 'Block 144',
                description: 'Student dormitory and residential services.',
                building: 'Block 144',
                category: 'Services',
                latitude: 11.857272050912846,  
                longitude:  38.039834082721725,
                floor: '2 Floors',
                opening_hours: '24/7',
                tags: ['dormitory', 'residential'],
                details: { type: 'Dormitory Block'}
            },
            {
                id: 'Gymnasium',
                name: 'Block 154',
                description: 'Large auditorium for events, conferences and ceremonies.',
                building: 'Gymnasium',
                category: 'recreational',
                latitude: 11.851278097991214,
                longitude: 38.040755000103154,
                floor: 'Ground Floor',
                opening_hours: 'By schedule',
                tags: ['events','auditorium'],
                details: { type: 'Event Space', departments: ['Event Management'], facilities: ['Main Hall (500 capacity)','Stage','Audio-Visual Equipment'], contact: '+251-58-200-006' }
            },

            {
                id: 'auditorium',
                name: 'Main Auditorium',
                description: 'Large auditorium for events, conferences and ceremonies.',
                building: 'Auditorium Building',
                category: 'recreational',
                latitude: 11.853750138878254,
                longitude: 38.042640355264844,
                floor: 'Ground Floor',
                opening_hours: 'By schedule',
                tags: ['events','auditorium'],
                details: { type: 'Event Space', departments: ['Event Management'], facilities: ['Main Hall (500 capacity)','Stage','Audio-Visual Equipment'], contact: '+251-58-200-006' }
            }
        ];
        });
    }

    // Fetch POIs from backend API
    async fetchPOIsFromBackend() {
        try {
            const res = await fetch(`${this.apiBase}/pois?limit=1000`);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.pois) && data.pois.length > 0) {
                    this.pois = data.pois;
                    console.log(`Loaded ${data.pois.length} POIs from backend`);
                    return;
                }
            }
        } catch (err) {
            console.warn('Failed to fetch POIs from backend:', err);
        }
        throw new Error('Backend POI fetch failed');
    }

    // Return localized display name for a POI based on current language
    getLocalizedPOIName(poi) {
        try {
            if (!poi) return '';
            const lang = this.currentLanguage || 'en';
            if (poi.translations && poi.translations[lang] && poi.translations[lang].name) return poi.translations[lang].name;
            // fallback to building translation
            if (poi.translations && poi.translations[lang] && poi.translations[lang].building) return poi.translations[lang].building;
            // fallback to English translation or base name
            if (poi.translations && poi.translations['en'] && poi.translations['en'].name) return poi.translations['en'].name;
            return poi.name || poi.building || '';
        } catch (e) { return poi.name || '' }
    }

    // Check if an input string matches this POI in any language or id
    matchesPOIName(input, poi) {
        if (!input || !poi) return false;
        const v = String(input).trim().toLowerCase();
        if (!v) return false;
        if (poi.id && String(poi.id).toLowerCase() === v) return true;
        if (poi.name && poi.name.toLowerCase() === v) return true;
        if (poi.building && poi.building.toLowerCase() === v) return true;
        // translations object may contain localized names/building keys
        if (poi.translations) {
            for (const k of Object.keys(poi.translations)) {
                const t = poi.translations[k] || {};
                if (t.name && String(t.name).toLowerCase() === v) return true;
                if (t.building && String(t.building).toLowerCase() === v) return true;
            }
        }
        return false;
    }

    setupEventListeners() {
        // Menu toggle for mobile
        const menuToggle = document.getElementById('menu-toggle');
        const nav = document.querySelector('nav');
        if (menuToggle && nav) {
            menuToggle.addEventListener('click', () => {
                nav.classList.toggle('active');
                menuToggle.classList.toggle('active');
            });
            
            // Close menu when a nav link is clicked
            document.querySelectorAll('.nav-link').forEach(link => {
                link.addEventListener('click', () => {
                    nav.classList.remove('active');
                    menuToggle.classList.remove('active');
                });
            });
        }

        // Navigation
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.handleNavigation(e.target.dataset.page);
            });
        });

        // Language selector
        const langSel = document.getElementById('language-select');
        if (langSel) {
            // set current value
            langSel.value = this.currentLanguage;
            langSel.addEventListener('change', (e) => {
                this.currentLanguage = e.target.value;
                localStorage.setItem('preferredLanguage', this.currentLanguage);
                this.applyTranslations();
                // Repopulate datalists and POI markers in the selected language
                try { this.populateDatalists(); } catch (err) {}
                try { this.loadPOIs(); } catch (err) {}
                // If there's a currently displayed route, refresh the route panel translations
                try { if (this.currentRoute) this.updateRouteInfo(this.currentRoute.route, this.currentRoute.startPOI, this.currentRoute.endPOI); } catch (e) {}
            });
        }
        // Route calculation
        document.getElementById('calculate-route-btn').addEventListener('click', () => {
            this.calculateRoute();
        });

        // Live routing (start AR guidance from current location to chosen destination)
        const liveBtn = document.getElementById('live-route-btn');
        if (liveBtn) {
            liveBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                try {
                    // toggle: if live routing already active, stop it
                    if (this._liveRoutingActive) {
                        this.stopLiveRouting();
                        liveBtn.classList.remove('active');
                        liveBtn.textContent = 'Live Routing (AR)';
                        return;
                    }
                    liveBtn.classList.add('active');
                    liveBtn.textContent = 'Starting Live Routing...';
                    await this.startLiveRouting();
                    liveBtn.textContent = 'Stop Live Routing';
                } catch (err) {
                    console.warn('Live routing failed', err);
                    this.showMessage(err && err.message ? err.message : 'Live routing failed', 'error');
                    liveBtn.classList.remove('active');
                    liveBtn.textContent = 'Live Routing (AR)';
                }
            });
        }

        // AR toggle: start/stop AR guidance
        const arBtn = document.getElementById('ar-toggle');
        if (arBtn) {
            arBtn.addEventListener('click', (e) => {
                e.preventDefault();
                try {
                    if (!this.isARGuiding) {
                        this.startARGuidance();
                        arBtn.setAttribute('aria-pressed', 'true');
                    } else {
                        this.stopARGuidance();
                        arBtn.setAttribute('aria-pressed', 'false');
                    }
                } catch (err) { console.warn('AR toggle failed', err); }
            });
        }

        // Footer feedback button opens user feedback modal
        const footerFb = document.getElementById('footer-feedback');
        if (footerFb) footerFb.addEventListener('click', (e) => { e.preventDefault(); this.openUserFeedbackModal(); });
        
        // Footer Quick Links
        const footerHome = document.getElementById('footer-home');
        if (footerHome) footerHome.addEventListener('click', (e) => { e.preventDefault(); this.navigateToPage('home'); });
        
        const footerMap = document.getElementById('footer-map');
        if (footerMap) footerMap.addEventListener('click', (e) => { e.preventDefault(); this.navigateToPage('map'); });
        
        const footerBuildings = document.getElementById('footer-buildings');
        if (footerBuildings) footerBuildings.addEventListener('click', (e) => { e.preventDefault(); this.navigateToPage('map'); this.showMessage('Building Directory - Browse all campus buildings on the map', 'info'); });
        
        const footerEvents = document.getElementById('footer-events');
        if (footerEvents) footerEvents.addEventListener('click', (e) => { e.preventDefault(); this.showMessage('Events feature coming soon!', 'info'); });
        
        // Footer Resources
        const footerHelp = document.getElementById('footer-help');
        if (footerHelp) footerHelp.addEventListener('click', (e) => { e.preventDefault(); this.showHelpCenter(); });
        
        const footerMobile = document.getElementById('footer-mobile');
        if (footerMobile) footerMobile.addEventListener('click', (e) => { e.preventDefault(); this.showMobileAppInfo(); });
        
        const footerAccessibility = document.getElementById('footer-accessibility');
        if (footerAccessibility) footerAccessibility.addEventListener('click', (e) => { e.preventDefault(); this.showAccessibilityInfo(); });
        
        // Footer Contact
        const footerAddress = document.getElementById('footer-address');
        if (footerAddress) footerAddress.addEventListener('click', (e) => { e.preventDefault(); this.showAddressInfo(); });
        
        const footerHours = document.getElementById('footer-hours');
        if (footerHours) footerHours.addEventListener('click', (e) => { e.preventDefault(); this.showHoursInfo(); });
        
        // Wire modal buttons
        const closeFb = document.getElementById('close-user-feedback');
        if (closeFb) closeFb.addEventListener('click', () => this.closeUserFeedbackModal());
        const cancelFb = document.getElementById('cancel-feedback-btn');
        if (cancelFb) cancelFb.addEventListener('click', () => this.closeUserFeedbackModal());
        const submitFb = document.getElementById('submit-feedback-btn');
        if (submitFb) submitFb.addEventListener('click', () => this.handleSubmitFeedback());

        // Category filters
        document.querySelectorAll('.category-item').forEach(item => {
            item.addEventListener('click', (e) => {
                this.handleCategoryFilter(e.currentTarget.dataset.category);
            });
        });

        // Quick links
        document.querySelectorAll('.quick-link').forEach(link => {
            if (link.id !== 'my-feedback-btn' && link.id !== 'saved-routes-btn') {
                link.addEventListener('click', (e) => {
                    this.handleQuickLink(e.currentTarget.dataset.location);
                });
            }
        });

        // Map controls
        document.getElementById('zoom-in').addEventListener('click', () => {
            this.zoomInCampus();
        });

        document.getElementById('zoom-out').addEventListener('click', () => {
            this.zoomOutCampus();
        });

        document.getElementById('current-location').addEventListener('click', () => {
            this.getCurrentLocation();
        });

        document.getElementById('satellite-view').addEventListener('click', () => {
            this.toggleSatelliteView();
        });

        // Hero buttons
        const heroOpen = document.getElementById('hero-open-map');
        if (heroOpen) heroOpen.addEventListener('click', () => {
            const mapEl = document.getElementById('map');
            if (mapEl) mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        const heroLearn = document.getElementById('hero-learn-more');
        if (heroLearn) heroLearn.addEventListener('click', () => this.showAboutInfo());

        // Notifications dropdown click handler (delegate)
        const notifList = document.getElementById('notifications-dropdown');
        if (notifList) {
            notifList.addEventListener('click', async (e) => {
                const a = e.target.closest('a[data-id]');
                if (!a) return;
                e.preventDefault();
                const id = a.dataset.id;
                const itemIndex = this.notifications.findIndex(n => n.id === id);
                const item = itemIndex !== -1 ? this.notifications[itemIndex] : null;
                if (item) {
                    // show full notification content
                    this.showMessage(`<strong>${item.title}</strong><br/><small>${new Date(item.createdAt).toLocaleString()}</small><div style=\"margin-top:8px;\">${item.message}</div>`, 'info');

                    // Try to mark as read server-side when authenticated, but always update UI locally
                    try {
                        const token = localStorage.getItem('authToken');
                        if (token) {
                            try {
                                const res = await fetch(`${this.apiBase}/notifications/${encodeURIComponent(id)}/read`, {
                                    method: 'PATCH',
                                    headers: { 'Authorization': `Bearer ${token}` }
                                });
                                if (!res.ok) {
                                    const err = await res.json().catch(() => ({}));
                                    console.warn('Mark notification read failed', err);
                                }
                            } catch (err) {
                                console.warn('Failed to call mark-read API', err);
                            }
                        }
                    } catch (e) { console.warn('mark-read flow failed', e); }

                    // remove from local list and update badge/count
                    try {
                        this.notifications.splice(itemIndex, 1);
                        // decrement unread count (guard)
                        try { this.unreadCount = Math.max(0, (Number(this.unreadCount) || 0) - 1); } catch (e) { this.unreadCount = Math.max(0, this.notifications.length); }
                        this.renderNotificationsDropdown();
                    } catch (e) { console.warn('Failed to mark notification read locally', e); }
                }
            });
        }

        // User notification detail modal close buttons
        const closeUserNotifDetail = document.getElementById('close-user-notification-detail');
        if (closeUserNotifDetail) closeUserNotifDetail.addEventListener('click', () => this.closeUserNotificationDetail());
        const closeUserNotifDetailBtn = document.getElementById('close-user-notification-detail-btn');
        if (closeUserNotifDetailBtn) closeUserNotifDetailBtn.addEventListener('click', () => this.closeUserNotificationDetail());

        // When the notifications dropdown is opened, mark all as read (persist for authenticated users)
        const notifBell = document.getElementById('notification-bell');
        if (notifBell) {
            try {
                notifBell.addEventListener('show.bs.dropdown', async () => {
                    try {
                        const token = localStorage.getItem('authToken');
                        if (token) {
                            // ask server to mark all as read for this user
                            try {
                                const res = await fetch(`${this.apiBase}/notifications/mark-all-read`, {
                                    method: 'POST',
                                    headers: { 'Authorization': `Bearer ${token}` }
                                });
                                if (!res.ok) {
                                    const err = await res.json().catch(() => ({}));
                                    console.warn('mark-all-read API failed', err);
                                }
                            } catch (err) { console.warn('mark-all-read request failed', err); }
                        }
                    } catch (e) { console.warn('mark-all-read flow error', e); }

                    // Update badge to show 0 unread (but keep notifications visible in dropdown)
                    try { this.unreadCount = 0; this.renderNotificationsDropdown(); } catch (e) { console.warn('Failed to update badge', e); }
                });
            } catch (e) { console.warn('Failed to attach dropdown show handler', e); }
        }


        // Admin login button: open dashboard when already authenticated, otherwise show login
        const adminBtnEl = document.getElementById('admin-btn');
        if (adminBtnEl) {
            adminBtnEl.addEventListener('click', () => {
                const token = localStorage.getItem('authToken');
                if (token) {
                    const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
                    if (user && user.role === 'admin') {
                        this.currentUser = user;
                        this.updateUserInterface();
                        const adminPanel = document.getElementById('admin-panel');
                        if (adminPanel) {
                            adminPanel.style.display = 'block';
                            adminPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                        return;
                    }
                }
                this.showAdminLoginPanel();
            });
        }
        // Admin login submit
        document.getElementById('admin-login-submit-btn').addEventListener('click', () => {
            this.handleAdminLogin();
        });
        // Hide admin login modal on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.hideAdminLoginPanel();
            }
        });

        // Save route
        document.getElementById('save-route-btn').addEventListener('click', () => {
            this.saveCurrentRoute();
        });

        // Admin panel actions (logout/create user)
        const adminLogoutBtn = document.getElementById('admin-logout-btn');
        if (adminLogoutBtn) {
            adminLogoutBtn.addEventListener('click', () => {
                this.handleLogout();
            });
        }

        const adminFeedbackBtn = document.getElementById('admin-feedback-btn');
        if (adminFeedbackBtn) {
            adminFeedbackBtn.addEventListener('click', () => {
                const fbSection = document.getElementById('admin-feedback-section');
                if (fbSection) {
                    fbSection.style.display = fbSection.style.display === 'none' ? 'block' : 'none';
                    if (fbSection.style.display === 'block') this.loadAdminFeedback();
                }
            });
        }

        // event viewer controls
        const eventRefresh = document.getElementById('event-refresh');
        if (eventRefresh) eventRefresh.addEventListener('click', () => this.loadEventsPage(1));
        const eventPrev = document.getElementById('events-prev');
        const eventNext = document.getElementById('events-next');
        if (eventPrev) eventPrev.addEventListener('click', async () => {
            const cur = parseInt((document.getElementById('events-page') || {}).textContent || '1', 10) || 1;
            if (cur > 1) await this.loadEventsPage(cur - 1);
        });
        if (eventNext) eventNext.addEventListener('click', async () => {
            const cur = parseInt((document.getElementById('events-page') || {}).textContent || '1', 10) || 1;
            await this.loadEventsPage(cur + 1);
        });

        // Admin broadcast buttons
        const adminBroadcastBtn = document.getElementById('admin-broadcast-btn');
        if (adminBroadcastBtn) adminBroadcastBtn.addEventListener('click', () => this.openNotificationListModal());
        const adminBroadcastRefresh = document.getElementById('admin-broadcast-refresh');
        if (adminBroadcastRefresh) adminBroadcastRefresh.addEventListener('click', () => this.openNotificationListModal());
        const adminBroadcastNew = document.getElementById('admin-broadcast-new');
        if (adminBroadcastNew) adminBroadcastNew.addEventListener('click', () => this.openNewNotificationModal());

        const adminDemoBtn = document.getElementById('admin-demo-notify-btn');
        if (adminDemoBtn) {
            adminDemoBtn.addEventListener('click', () => {
                this.handleAdminDemoNotify();
            });
        }

        // Broadcast modal controls
        const closeBroadcast = document.getElementById('close-broadcast-modal');
        if (closeBroadcast) closeBroadcast.addEventListener('click', () => this.closeBroadcastModal());
        const cancelBroadcast = document.getElementById('cancel-broadcast-btn');
        if (cancelBroadcast) cancelBroadcast.addEventListener('click', () => this.closeBroadcastModal());
        const sendBroadcastBtn = document.getElementById('send-broadcast-btn');
        if (sendBroadcastBtn) sendBroadcastBtn.addEventListener('click', () => this.handleSendBroadcast());

        // Broadcast edit modal controls
        const closeBroadcastEdit = document.getElementById('close-broadcast-edit-modal');
        if (closeBroadcastEdit) closeBroadcastEdit.addEventListener('click', () => { document.getElementById('admin-broadcast-edit-modal').style.display = 'none'; });
        const cancelBroadcastEdit = document.getElementById('cancel-broadcast-edit-btn');
        if (cancelBroadcastEdit) cancelBroadcastEdit.addEventListener('click', () => { document.getElementById('admin-broadcast-edit-modal').style.display = 'none'; });
        const updateBroadcastBtn = document.getElementById('update-broadcast-btn');
        if (updateBroadcastBtn) updateBroadcastBtn.addEventListener('click', () => this.updateBroadcast());
        const deleteBroadcastBtn = document.getElementById('delete-broadcast-btn');
        if (deleteBroadcastBtn) deleteBroadcastBtn.addEventListener('click', () => this.deleteBroadcast());

        // Notification management modal controls
        const closeNotificationList = document.getElementById('close-notification-list-modal');
        if (closeNotificationList) closeNotificationList.addEventListener('click', () => this.closeNotificationListModal());
        
        const closeEditNotification = document.getElementById('close-edit-notification-modal');
        if (closeEditNotification) closeEditNotification.addEventListener('click', () => this.closeEditNotificationModal());
        const cancelEditNotification = document.getElementById('cancel-edit-notification-btn');
        if (cancelEditNotification) cancelEditNotification.addEventListener('click', () => this.closeEditNotificationModal());
        
        const closeNewNotification = document.getElementById('close-new-notification-modal');
        if (closeNewNotification) closeNewNotification.addEventListener('click', () => this.closeNewNotificationModal());
        const cancelNewNotification = document.getElementById('cancel-new-notification-btn');
        if (cancelNewNotification) cancelNewNotification.addEventListener('click', () => this.closeNewNotificationModal());
        
        // Character count listeners
        const newNotifTitle = document.getElementById('new-notification-title');
        if (newNotifTitle) newNotifTitle.addEventListener('input', () => this.updateCharacterCount('new-notification-title'));
        const newNotifContent = document.getElementById('new-notification-content');
        if (newNotifContent) newNotifContent.addEventListener('input', () => this.updateCharacterCount('new-notification-content'));
        const editNotifTitle = document.getElementById('edit-notification-title');
        if (editNotifTitle) editNotifTitle.addEventListener('input', () => this.updateCharacterCount('edit-notification-title'));
        const editNotifContent = document.getElementById('edit-notification-content');
        if (editNotifContent) editNotifContent.addEventListener('input', () => this.updateCharacterCount('edit-notification-content'));

        // Save and delete notification listeners
        const saveEditNotifBtn = document.getElementById('save-edit-notification-btn');
        if (saveEditNotifBtn) saveEditNotifBtn.addEventListener('click', () => this.saveEditNotification());
        const deleteEditNotifBtn = document.getElementById('delete-edit-notification-btn');
        if (deleteEditNotifBtn) deleteEditNotifBtn.addEventListener('click', () => this.deleteEditNotification());

        // Send new notification listener
        const sendNewNotifBtn = document.getElementById('send-new-notification-btn');
        if (sendNewNotifBtn) sendNewNotifBtn.addEventListener('click', () => this.sendNewNotification());

        const adminChangePwBtn = document.getElementById('admin-change-password-btn');
        if (adminChangePwBtn) {
            adminChangePwBtn.addEventListener('click', () => {
                this.openChangePasswordModal();
            });
        }

        const adminEditBoundsBtn = document.getElementById('admin-edit-bounds-btn');
        if (adminEditBoundsBtn) {
            adminEditBoundsBtn.addEventListener('click', () => this.openBoundsModal());
        }

        // Bounds modal handlers
        const closeBounds = document.getElementById('close-bounds-modal');
        if (closeBounds) closeBounds.addEventListener('click', () => this.closeBoundsModal());
        const cancelBounds = document.getElementById('cancel-bounds-btn');
        if (cancelBounds) cancelBounds.addEventListener('click', () => this.closeBoundsModal());
        const saveBounds = document.getElementById('save-bounds-btn');
        if (saveBounds) saveBounds.addEventListener('click', () => this.handleSaveBounds());

        // Admin update map button
        const adminUpdateMapBtn = document.getElementById('admin-update-map-btn');
        if (adminUpdateMapBtn) {
            adminUpdateMapBtn.addEventListener('click', () => this.openUpdateMapModal());
        }

        const closeUpdateMap = document.getElementById('close-update-map-modal');
        if (closeUpdateMap) closeUpdateMap.addEventListener('click', () => this.closeUpdateMapModal());
        const cancelUpdateMap = document.getElementById('cancel-update-map');
        if (cancelUpdateMap) cancelUpdateMap.addEventListener('click', () => this.closeUpdateMapModal());
        const submitUpdateMap = document.getElementById('submit-update-map');
        if (submitUpdateMap) submitUpdateMap.addEventListener('click', () => this.handleSubmitMapUpdate());

        // Change password modal buttons
        const closeChangePw = document.getElementById('close-change-password-modal');
        if (closeChangePw) closeChangePw.addEventListener('click', () => this.closeChangePasswordModal());
        const cancelChangePw = document.getElementById('cancel-change-password');
        if (cancelChangePw) cancelChangePw.addEventListener('click', () => this.closeChangePasswordModal());
        const submitChangePw = document.getElementById('submit-change-password');
        if (submitChangePw) submitChangePw.addEventListener('click', () => this.handleChangePasswordSubmit());

        // Broadcast modal removed; broadcast panel removed from HTML.

        // Admin actions wired: logout is above. User actions (change role, notify) are added after users list renders.

        // Modal close
        document.querySelector('.close-modal').addEventListener('click', () => {
            this.closePOIModal();
        });

        // Close modal when clicking outside
        document.getElementById('poi-modal').addEventListener('click', (e) => {
            if (e.target.id === 'poi-modal') {
                this.closePOIModal();
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closePOIModal();
                this.hideLoginPanel();
            }
        });

        // attach select sync listeners (if selects exist)
        try { this.attachSelectSyncs(); } catch (e) {}
    }

    // Sync select pickers to the input fields so choosing by name works
    attachSelectSyncs() {
        try {
            const startSelectEl = document.getElementById('start-select');
            if (startSelectEl) startSelectEl.addEventListener('change', (e) => {
                const option = e.target.options[e.target.selectedIndex];
                const val = option ? option.value : '';
                const text = option ? option.textContent || option.label || val : '';
                const inp = document.getElementById('start-point');
                const inpId = document.getElementById('start-point-id');
                if (inp) inp.value = text;
                if (inpId) inpId.value = val;
                // show details for selected POI if available
                const matched = this.pois.find(p => (p._id === val || p.id === val));
                if (matched) this.showSelectionDetails(matched, 'start');
            });

            const endSelectEl = document.getElementById('end-select');
            if (endSelectEl) endSelectEl.addEventListener('change', (e) => {
                const option = e.target.options[e.target.selectedIndex];
                const val = option ? option.value : '';
                const text = option ? option.textContent || option.label || val : '';
                const inp = document.getElementById('end-point');
                const inpId = document.getElementById('end-point-id');
                if (inp) inp.value = text;
                if (inpId) inpId.value = val;
                const matched = this.pois.find(p => (p._id === val || p.id === val));
                if (matched) this.showSelectionDetails(matched, 'end');
            });

            // Also when users type into the inputs, resolve on blur to set the hidden id where possible
            const startInput = document.getElementById('start-point');
            const endInput = document.getElementById('end-point');
            if (startInput) {
                startInput.addEventListener('blur', (e) => {
                    const v = (e.target.value || '').trim();
                    const inpId = document.getElementById('start-point-id');
                    if (/^current$/i.test(v) || /^current location$/i.test(v)) {
                        if (inpId) inpId.value = 'current';
                        return;
                    }
                    const matched = this.pois.find(p => (p.name && p.name.toLowerCase() === v.toLowerCase()) || (p.building && p.building.toLowerCase() === v.toLowerCase()) || p._id === v || p.id === v);
                    if (matched) {
                        if (inpId) inpId.value = matched._id || matched.id;
                        // normalize display
                        e.target.value = matched.name;
                        this.showSelectionDetails(matched, 'start');
                    } else {
                        if (inpId) inpId.value = '';
                        this.clearSelection('start');
                    }
                });
            }
            if (endInput) {
                endInput.addEventListener('blur', (e) => {
                    const v = (e.target.value || '').trim();
                    const inpId = document.getElementById('end-point-id');
                    const matched = this.pois.find(p => (p.name && p.name.toLowerCase() === v.toLowerCase()) || (p.building && p.building.toLowerCase() === v.toLowerCase()) || p._id === v || p.id === v);
                    if (matched) {
                        if (inpId) inpId.value = matched._id || matched.id;
                        e.target.value = matched.name;
                        this.showSelectionDetails(matched, 'end');
                    } else {
                        if (inpId) inpId.value = '';
                        this.clearSelection('end');
                    }
                });
            }
        } catch (e) { /* non-fatal */ }
    }

    showSelectionDetails(poi, which) {
        try {
            if (!poi || !which) return;
            const name = this.getLocalizedPOIName(poi) || (poi.name || '');
            const addr = poi.building || poi.category || '';
            if (which === 'start') {
                const container = document.getElementById('start-selection-details');
                if (!container) return;
                const nameEl = document.getElementById('start-selection-name');
                const addrEl = document.getElementById('start-selection-addr');
                if (nameEl) nameEl.textContent = name;
                if (addrEl) addrEl.textContent = addr;
                container.style.display = 'block';
                // wire buttons
                const setDest = document.getElementById('start-set-destination');
                if (setDest) setDest.onclick = () => {
                    const endSelect = document.getElementById('end-select');
                    if (endSelect) {
                        endSelect.value = poi._id || poi.id || '';
                        try { endSelect.dispatchEvent(new Event('change')); } catch (e) {}
                    }
                    const inpId = document.getElementById('end-point-id'); if (inpId) inpId.value = poi._id || poi.id || '';
                    this.showSelectionDetails(poi, 'end');
                };
                const clearBtn = document.getElementById('start-clear-selection');
                if (clearBtn) clearBtn.onclick = () => { this.clearSelection('start'); };
            } else if (which === 'end') {
                const container = document.getElementById('end-selection-details');
                if (!container) return;
                const nameEl = document.getElementById('end-selection-name');
                const addrEl = document.getElementById('end-selection-addr');
                if (nameEl) nameEl.textContent = name;
                if (addrEl) addrEl.textContent = addr;
                container.style.display = 'block';
                const setStart = document.getElementById('end-set-start');
                if (setStart) setStart.onclick = () => {
                    const startSelect = document.getElementById('start-select');
                    if (startSelect) {
                        startSelect.value = poi._id || poi.id || '';
                        try { startSelect.dispatchEvent(new Event('change')); } catch (e) {}
                    }
                    const inpId = document.getElementById('start-point-id'); if (inpId) inpId.value = poi._id || poi.id || '';
                    this.showSelectionDetails(poi, 'start');
                };
                const clearBtn = document.getElementById('end-clear-selection');
                if (clearBtn) clearBtn.onclick = () => { this.clearSelection('end'); };
            }
        } catch (e) { console.warn('showSelectionDetails failed', e); }
    }

    clearSelection(which) {
        try {
            if (which === 'start') {
                const container = document.getElementById('start-selection-details');
                if (container) container.style.display = 'none';
                const nameEl = document.getElementById('start-selection-name'); if (nameEl) nameEl.textContent = '';
                const addrEl = document.getElementById('start-selection-addr'); if (addrEl) addrEl.textContent = '';
                const startSelect = document.getElementById('start-select'); if (startSelect) { startSelect.value = ''; try { startSelect.dispatchEvent(new Event('change')); } catch (e) {} }
                const inpId = document.getElementById('start-point-id'); if (inpId) inpId.value = '';
            } else if (which === 'end') {
                const container = document.getElementById('end-selection-details');
                if (container) container.style.display = 'none';
                const nameEl = document.getElementById('end-selection-name'); if (nameEl) nameEl.textContent = '';
                const addrEl = document.getElementById('end-selection-addr'); if (addrEl) addrEl.textContent = '';
                const endSelect = document.getElementById('end-select'); if (endSelect) { endSelect.value = ''; try { endSelect.dispatchEvent(new Event('change')); } catch (e) {} }
                const inpId = document.getElementById('end-point-id'); if (inpId) inpId.value = '';
            }
        } catch (e) { /* non-fatal */ }
    }

    initializeMap() {
        // Ensure map container exists before initializing
        const mapContainer = document.getElementById('map');
        if (!mapContainer) {
            console.error('❌ Map container element not found! Cannot initialize map.');
            return;
        }

        // Use explicit campus geographic bounds (set by admin)
        // Bounds provided by user (cropped area)
        const campusGeo = {
            // latitudes and longitudes as provided
            // north/south are latitudes, east/west are longitudes
                north: 11.85752990166513,
                south: 11.84975620199455,
                east: 38.05147930542123,
                west: 38.038476018283426
        };
        // store for other methods
        this.campusGeo = campusGeo;

        // compute center from bounds
        const center = [
            (campusGeo.north + campusGeo.south) / 2,
            (campusGeo.east + campusGeo.west) / 2
        ];

        // create Leaflet bounds from provided values
        this.campusBounds = L.latLngBounds([campusGeo.south, campusGeo.west], [campusGeo.north, campusGeo.east]);

        // Create map with disabled default zoom control (we use custom controls)
        this.map = L.map('map', {
            center: center,
            zoom: 17,
            minZoom: 15,
            maxZoom: 19,
            zoomControl: false,
            maxBounds: this.campusBounds,
            maxBoundsViscosity: 0.9
        });

        // Standard map layer
        this.standardLayer = L.tileLayer('https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
            maxZoom: 20,
            subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
            attribution: '&copy; Google Maps'
        });

        // Satellite layer (default) - pure satellite without Google labels
        this.satelliteLayer = L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
            maxZoom: 20,
            subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
            attribution: '&copy; Satellites'
        }).addTo(this.map);

        // (restored to rectangular bounds — no polygon/mask)

        // compute radius from center to northeast corner (meters)
        const radiusMeters = Math.round(this.calculateDistance(center[0], center[1], campusGeo.north, campusGeo.east));

        // Add a subtle campus rectangle to indicate the allowed area
        this.campusRect = L.rectangle(this.campusBounds, {
            color: '#1a5f7a',
            weight: 2,
            fillOpacity: 0.02
        }).addTo(this.map);

        // Add a dimmed mask overlay outside the campus rectangle
        this.addCampusMask();

        console.log('✅ DTU Campus Map initialized (satellite default, explicit bounds)');
    }

    // Populate start/end datalists and POI suggestions
    populateDatalists() {
        try {
            const startList = document.getElementById('start-suggestions');
            const endList = document.getElementById('end-suggestions');
            const poiList = document.getElementById('poi-suggestions');

            // Also target the selects (if present) so users can pick from a list
            const startSelect = document.getElementById('start-select');
            const endSelect = document.getElementById('end-select');

            // Clear (if elements exist)
            if (startList) startList.innerHTML = '<option value="Current Location"></option>';
            if (endList) endList.innerHTML = '';
            if (poiList) poiList.innerHTML = '';
            if (startSelect) startSelect.innerHTML = '<option value="current">Current Location</option><option value="">Choose...</option>';
            if (endSelect) endSelect.innerHTML = '<option value="">Choose...</option>';

            // Sort POIs by localized display name for predictable ordering
            const sortedPOIs = Array.from(this.pois).sort((a, b) => {
                const na = (this.getLocalizedPOIName(a) || '').toLowerCase();
                const nb = (this.getLocalizedPOIName(b) || '').toLowerCase();
                return na.localeCompare(nb);
            });

            // Group POIs by category for select grouping (normalize to lowercase keys)
            const groups = {};
            sortedPOIs.forEach(p => {
                const rawCat = p.category || 'others';
                const cat = (typeof rawCat === 'string') ? rawCat.toLowerCase() : 'others';
                if (!groups[cat]) groups[cat] = [];
                groups[cat].push(p);
            });

            // Helper: categories order and label formatting
            const order = ['academic', 'administrative', 'services', 'recreational', 'others'];

            // Populate datalists (free-text suggestions) — keep simple flat list
            sortedPOIs.forEach(p => {
                const displayName = this.getLocalizedPOIName(p) || p.name || p.id;
                if (startList) {
                    const opt1 = document.createElement('option');
                    opt1.value = displayName;
                    startList.appendChild(opt1);
                }
                if (endList) {
                    const opt2 = document.createElement('option');
                    opt2.value = displayName;
                    endList.appendChild(opt2);
                }
                if (poiList) {
                    const opt3 = document.createElement('option');
                    opt3.value = displayName;
                    poiList.appendChild(opt3);
                }
            });

            // Populate selects using optgroups by category for easier scanning
            const makeGroupedOptions = (selectEl) => {
                if (!selectEl) return;
                // preserve the first two special options (current / placeholder) if present
                const firstOpts = [];
                Array.from(selectEl.children).slice(0, 2).forEach(o => firstOpts.push(o.cloneNode(true)));
                selectEl.innerHTML = '';
                firstOpts.forEach(o => selectEl.appendChild(o));

                // Add ordered groups
                order.forEach(cat => {
                    const list = groups[cat];
                    if (!list || !list.length) return;
                    const optgroup = document.createElement('optgroup');
                    optgroup.label = cat === 'others' ? 'Other' : this.formatCategory(cat);
                    list.forEach(p => {
                        const o = document.createElement('option');
                        o.value = p.id;
                        o.textContent = this.getLocalizedPOIName(p) || p.name || p.id;
                        optgroup.appendChild(o);
                    });
                    selectEl.appendChild(optgroup);
                });
            };

            if (startSelect) makeGroupedOptions(startSelect);
            if (endSelect) makeGroupedOptions(endSelect);
        } catch (e) { console.warn('populateDatalists error', e); }
    }

    // Zoom helpers that respect campus bounds and min/max zoom
    zoomInCampus() {
        if (!this.map) return;
        const next = Math.min(this.map.getZoom() + 1, this.map.options.maxZoom || 19);
        this.map.setZoom(next);
    }

    zoomOutCampus() {
        if (!this.map) return;
        const next = Math.max(this.map.getZoom() - 1, this.map.options.minZoom || 15);
        this.map.setZoom(next);
    }

    // Add a dim mask overlay outside the campus circle (hole in the mask)
    addCampusMask(center, radiusMeters = 800) {
        if (!this.map) return;

        // If explicit campusGeo is available, use rectangular inner ring matching the bounds
        let innerRing = [];
        if (this.campusGeo) {
            const g = this.campusGeo;
            // inner ring is the rectangle (south-west, south-east, north-east, north-west)
            innerRing = [
                [g.south, g.west],
                [g.south, g.east],
                [g.north, g.east],
                [g.north, g.west]
            ];
        } else {
            // fallback to circular hole approximation
            const points = 64;
            const lat = center[0];
            const lng = center[1];

            // Degrees per meter approx (varies with latitude)
            const degLatPerMeter = 1 / 111320; // ~ degrees latitude per meter
            const degLngPerMeter = 1 / (111320 * Math.cos(lat * Math.PI / 180));

            for (let i = 0; i < points; i++) {
                const theta = (i / points) * Math.PI * 2;
                const dLat = Math.sin(theta) * radiusMeters * degLatPerMeter;
                const dLng = Math.cos(theta) * radiusMeters * degLngPerMeter;
                innerRing.push([lat + dLat, lng + dLng]);
            }
        }

        // Outer ring covering most of world (clockwise)
        const outerRing = [
            [-85, -180],
            [-85, 180],
            [85, 180],
            [85, -180]
        ];

        // Leaflet supports polygons with holes by passing [outer, inner]
        // Use fillRule evenodd to ensure hole displays correctly
        try {
            // create a dedicated pane for the mask so we can control z-index
            try {
                if (!this.map.getPane('maskPane')) {
                    this.map.createPane('maskPane');
                    this.map.getPane('maskPane').style.zIndex = 450; // above tiles, below markers
                    this.map.getPane('maskPane').style.pointerEvents = 'auto';
                }
            } catch (pe) { /* ignore pane creation errors */ }

            if (this.campusMask) {
                this.map.removeLayer(this.campusMask);
            }

            this.campusMask = L.polygon([outerRing, innerRing], {
                pane: (this.map.getPane('maskPane') ? 'maskPane' : undefined),
                color: '#000',
                weight: 0,
                fillColor: '#000',
                // make fully opaque so outside area is visually removed
                fillOpacity: 1,
                interactive: true,
                className: 'campus-mask campus-mask-blocking'
            }).addTo(this.map);

            // Ensure mask is above tiles but below controls and markers
            if (this.campusMask && this.campusMask.bringToFront) this.campusMask.bringToFront();

            // Block interactions outside the campus by capturing events on the mask
            try {
                ['click','mousedown','mouseup','dblclick','contextmenu','touchstart','touchend','touchmove','mousemove','wheel'].forEach(evt => {
                    this.campusMask.on(evt, function(e) {
                        try {
                            if (e && e.originalEvent) {
                                e.originalEvent.stopPropagation();
                                e.originalEvent.preventDefault();
                            }
                            // also stop Leaflet from propagating
                            if (e && e.originalEvent && e.originalEvent._stopped !== true) e.originalEvent._stopped = true;

                            // show a debounced toast informing user the area is restricted
                            try {
                                const appObj = (window && window.app) ? window.app : null;
                                const now = Date.now();
                                if (appObj) {
                                    if (!appObj._lastMaskToast || (now - appObj._lastMaskToast) > 1500) {
                                        try { appObj.showToast('Map limited to campus area', 'info'); } catch (tt) {}
                                        appObj._lastMaskToast = now;
                                    }
                                }
                            } catch (toastErr) { /* non-fatal */ }
                        } catch (innerErr) { /* swallowing to avoid breaking mask */ }
                        return false;
                    });
                });
            } catch (bindErr) { console.warn('Failed to bind mask event handlers', bindErr); }
        } catch (e) {
            console.warn('Could not add campus mask overlay, falling back to circle dimming', e);
            // fallback: slightly darken outside by creating a semi-transparent circle (less ideal)
            if (this.campusMask) this.map.removeLayer(this.campusMask);
            this.campusMask = L.circle(center, {
                radius: radiusMeters,
                color: '#000',
                weight: 0,
                fillColor: '#000',
                fillOpacity: 0.25,
                interactive: false
            }).addTo(this.map);
            this.campusMask.bringToFront();
        }
    }

    loadPOIs(category = 'all') {
        // Clear existing markers
        this.markers.forEach(marker => this.map.removeLayer(marker));
        this.markers = [];

        // Filter POIs by category
        const filteredPOIs = category === 'all' 
            ? this.pois 
            : this.pois.filter(poi => (poi.category || '').toLowerCase() === String(category || '').toLowerCase());

        // Add markers to map
        filteredPOIs.forEach(poi => {
            const marker = L.marker([poi.latitude, poi.longitude])
                .addTo(this.map)
                .bindPopup(`
                    <div class="popup-content">
                        <h3>${this.getLocalizedPOIName(poi)}</h3>
                        <p>${poi.description}</p>
                        <p><strong>Building:</strong> ${poi.building}</p>
                        <p><strong>Hours:</strong> ${poi.opening_hours}</p>
                        <button onclick="app.showPOIDetails('${poi.id}')" 
                                style="margin-top: 10px; padding: 8px 16px; background: #1a5f7a; color: white; border: none; border-radius: 5px; cursor: pointer;">
                            View Details
                        </button>
                    </div>
                `);

            marker.on('click', () => {
                this.showPOIDetails(poi.id);
            });

            this.markers.push(marker);
        });

        // Fit map to show all markers if there are any
        if (filteredPOIs.length > 0) {
            const group = new L.featureGroup(this.markers);
            this.map.fitBounds(group.getBounds().pad(0.1));
        }

        // Update datalists for autocomplete
        this.populateDatalists();
    }

    /**
     * Add a single POI marker to the map
     * Used by admin POI manager when creating new POIs
     */
    addMarkerToMap(poi) {
        try {
            if (!poi || !this.map) return;

            const marker = L.marker([poi.latitude, poi.longitude])
                .addTo(this.map)
                .bindPopup(`
                    <div class="popup-content">
                        <h3>${this.getLocalizedPOIName(poi)}</h3>
                        <p>${poi.description}</p>
                        <p><strong>Building:</strong> ${poi.building}</p>
                        <p><strong>Hours:</strong> ${poi.opening_hours}</p>
                        <button onclick="app.showPOIDetails('${poi._id || poi.id}')" 
                                style="margin-top: 10px; padding: 8px 16px; background: #1a5f7a; color: white; border: none; border-radius: 5px; cursor: pointer;">
                            View Details
                        </button>
                    </div>
                `);

            marker.on('click', () => {
                this.showPOIDetails(poi._id || poi.id);
            });

            this.markers.push(marker);
        } catch (e) {
            console.warn('Failed to add marker to map:', e);
        }
    }

    /**
     * Update a POI marker on the map
     * Used by admin POI manager when editing POIs
     */
    updateMarkerForPOI(poi) {
        try {
            if (!poi || !this.map) return;

            // Find and remove old marker
            const oldMarkerIdx = this.markers.findIndex(m => {
                const latLng = m.getLatLng();
                // Try to match by checking if this marker is for the same POI
                // This is a bit tricky since markers don't store POI data directly
                // We'll remove all markers and reload them
                return false;
            });

            // Simpler approach: reload all POIs to refresh markers
            this.loadPOIs('all');
        } catch (e) {
            console.warn('Failed to update marker for POI:', e);
        }
    }

    /**
     * Remove a POI marker from the map
     * Used by admin POI manager when deleting POIs
     */
    removeMarkerForPOI(poiId) {
        try {
            if (!this.map) return;

            // Reload all POIs to refresh markers (removes the deleted one)
            this.loadPOIs('all');
        } catch (e) {
            console.warn('Failed to remove marker for POI:', e);
        }
    }

    async calculateRoute(opts = {}) {
        // Prefer hidden POI ids when available (from selects or resolved blurs)
        const startInputEl = document.getElementById('start-point');
        const endInputEl = document.getElementById('end-point');
        const startSelectEl = document.getElementById('start-select');
        const endSelectEl = document.getElementById('end-select');

        const startPointRaw = startInputEl ? startInputEl.value : (startSelectEl ? startSelectEl.value : '');
        const endPointRaw = endInputEl ? endInputEl.value : (endSelectEl ? endSelectEl.value : '');
        const startPointId = (document.getElementById('start-point-id') || {}).value;
        const endPointId = (document.getElementById('end-point-id') || {}).value;

        const startPoint = startPointId && startPointId !== '' ? startPointId : this.normalizePointInput(startPointRaw);
        const endPoint = endPointId && endPointId !== '' ? endPointId : this.normalizePointInput(endPointRaw);

        if (!startPoint || !endPoint) {
            this.showError('i18n:errors.select_both');
            return;
        }

        if (startPoint === endPoint) {
            this.showError('i18n:errors.same_points');
            return;
        }

        this.showLoading('calculate-route-btn');

        // Simulate API call delay
        setTimeout(async () => {
            try {
                let startPOI, endPOI;

                if (startPoint === 'current') {
                    // If we don't have a recent accurate location, attempt to resolve a better one
                    const needResolve = !this.userLocationMarker || (this.userLocationAccuracy && this.userLocationAccuracy > 50);
                    if (needResolve) {
                        try {
                            this.showMessage('Getting improved location...', 'info');
                            const loc = await this.resolveCurrentLocation(15000, 20); // 15s, desirable 20m
                            this._setUserLocationMarker(loc.lat, loc.lng, loc.accuracy);
                            this.userLocationAccuracy = loc.accuracy;
                        } catch (e) {
                            console.warn('Failed to resolve improved location', e);
                            // Fall back to any existing marker or error out
                            if (!this.userLocationMarker) throw new Error('Current location not set. Allow location access or choose a starting point');
                        }
                    }

                    // use the marker (must exist now)
                    const latlng = this.userLocationMarker.getLatLng();
                    startPOI = { id: 'current', name: 'Current Location', latitude: latlng.lat, longitude: latlng.lng };
                } else {
                    startPOI = this.pois.find(poi => poi.id === startPoint || this.matchesPOIName(startPoint, poi));
                }

                endPOI = this.pois.find(poi => poi.id === endPoint || this.matchesPOIName(endPoint, poi));

                if (!startPOI || !endPOI) {
                    throw new Error('Selected locations not found');
                }

                // Determine routing strategy (OSRM preferred unless forced fallback)
                let route = null;
                let routeSource = 'fallback';

                if (opts.forceFallback) {
                    route = this.calculateRouteBetweenPOIs(startPOI, endPOI);
                    routeSource = 'fallback';
                } else {
                    try {
                        const osrmRoute = await this.fetchOSRMRoute(startPOI.latitude, startPOI.longitude, endPOI.latitude, endPOI.longitude);
                        if (osrmRoute) {
                            route = osrmRoute;
                            routeSource = 'osrm';
                        }
                    } catch (e) {
                        console.warn('OSRM routing failed', e);
                        if (opts.forceOSRM) {
                            // If the caller explicitly requested OSRM only, surface an error
                            this.showMessage('Routing service unavailable (OSRM).', 'error');
                            throw e;
                        }
                    }

                    if (!route) {
                        route = this.calculateRouteBetweenPOIs(startPOI, endPOI);
                        routeSource = 'fallback';
                    }
                }

                this.displayRoute(route, startPOI, endPOI);
                this.setRouteSource(routeSource);
                // track route calculation event (prefer database _id when available)
                try { this.trackEvent('calculate_route', '/calculate', { start: startPOI._id || startPOI.id || startPOI.name, end: endPOI._id || endPOI.id || endPOI.name }); } catch (e) {}
                
                this.hideLoading('calculate-route-btn');
            } catch (error) {
                this.showError(error.message);
                this.hideLoading('calculate-route-btn');
            }
        }, 1000);
    }

    calculateRouteBetweenPOIs(startPOI, endPOI) {
        // Calculate distance using Haversine formula
        const distance = this.calculateDistance(
            startPOI.latitude, startPOI.longitude,
            endPOI.latitude, endPOI.longitude
        );

        // Generate path coordinates
        const path = this.generatePathCoordinates(startPOI, endPOI);

        // Generate instructions
        const instructions = this.generateRouteInstructions(startPOI, endPOI, distance);

        return {
            distance: Math.round(distance),
            estimated_time: Math.round(distance / 1.4 / 60), // Walking speed 1.4 m/s
            path_data: {
                coordinates: path,
                type: 'LineString'
            },
            indoor_instructions: instructions
        };
    }

    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371000; // Earth's radius in meters
        const dLat = this.toRad(lat2 - lat1);
        const dLon = this.toRad(lon2 - lon1);
        
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
        
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }

    toRad(degrees) {
        return degrees * (Math.PI/180);
    }

    generatePathCoordinates(startPOI, endPOI) {
        const coordinates = [];
        const steps = 10;

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const lat = startPOI.latitude + (endPOI.latitude - startPOI.latitude) * t;
            const lng = startPOI.longitude + (endPOI.longitude - startPOI.longitude) * t;
            coordinates.push([lng, lat]);
        }

        return coordinates;
    }

    generateRouteInstructions(startPOI, endPOI, distance) {
        const instructions = [];

        // Start instruction (localized)
        const startTpl = this.t('route_instructions.start', 'Start from {name}');
        instructions.push({
            step: 1,
            instruction: startTpl.replace('{name}', this.getLocalizedPOIName(startPOI) || startPOI.name),
            distance: 0,
            duration: 0
        });

        // Add intermediate instructions based on distance
        if (distance > 200) {
            const walkMain = this.t('route_instructions.walk_main', 'Walk straight on the main pathway');
            const cont = this.t('route_instructions.continue', 'Continue following the campus walkway');

            instructions.push({
                step: 2,
                instruction: walkMain,
                distance: Math.round(distance * 0.3),
                duration: Math.round((distance * 0.3) / 1.4 / 60)
            });

            instructions.push({
                step: 3,
                instruction: cont,
                distance: Math.round(distance * 0.4),
                duration: Math.round((distance * 0.4) / 1.4 / 60)
            });
        }

        const arriveTpl = this.t('route_instructions.arrive', 'Arrive at {name}');
        instructions.push({
            step: instructions.length + 1,
            instruction: arriveTpl.replace('{name}', this.getLocalizedPOIName(endPOI) || endPOI.name),
            distance: 0,
            duration: 0
        });

        return instructions;
    }

    // Attempt to fetch a road-snapped route from OSRM public server.
    // Returns a route object compatible with our displayRoute() expectation.
    async fetchOSRMRoute(startLat, startLng, endLat, endLng) {
        const base = 'https://router.project-osrm.org/route/v1/foot';
        const coords = `${startLng},${startLat};${endLng},${endLat}`;
        const url = `${base}/${coords}?overview=full&geometries=geojson&steps=true&annotations=distance,duration`;

        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error('Routing service returned an error');

        const data = await res.json();
        if (!data || !data.routes || data.routes.length === 0) throw new Error('No route returned');

        const r = data.routes[0];

        // Convert coordinates from geojson [lng,lat] to our stored format [lng,lat]
        const coordsArray = (r.geometry && r.geometry.coordinates) ? r.geometry.coordinates.slice() : [];

        // Build simple step instructions first so we can insert short "walk" steps
        const instructions = [];
        let stepIndex = 1;
        if (r.legs && r.legs.length) {
            for (const leg of r.legs) {
                if (!leg.steps) continue;
                for (const s of leg.steps) {
                    const name = s.name || '';
                    const m = (s.maneuver && s.maneuver.type) ? s.maneuver.type : '';
                    const mod = (s.maneuver && s.maneuver.modifier) ? ` ${s.maneuver.modifier}` : '';
                    const instr = `${m}${mod}${name ? ` onto ${name}` : ''}`;
                    instructions.push({ step: stepIndex++, instruction: instr, distance: Math.round(s.distance || 0), duration: Math.round((s.duration || 0) / 60) });
                }
            }
        }

        // Ensure route starts/ends at the exact provided coordinates (so path begins at POI)
        try {
            const almostEqual = (aLat, aLng, bLat, bLng, tolMeters = 2) => {
                const d = this.calculateDistance(aLat, aLng, bLat, bLng);
                return d <= tolMeters;
            };

            // first coord from OSRM (lng,lat)
            if (coordsArray.length) {
                const first = coordsArray[0];
                const last = coordsArray[coordsArray.length - 1];
                const firstLat = first[1], firstLng = first[0];
                const lastLat = last[1], lastLng = last[0];

                // if OSRM didn't start exactly at the requested start point, prepend the exact point
                if (!almostEqual(startLat, startLng, firstLat, firstLng)) {
                    coordsArray.unshift([startLng, startLat]);
                    // insert an initial instruction to walk from POI to road
                    const walkToRoadDist = Math.round(this.calculateDistance(startLat, startLng, firstLat, firstLng));
                    const walkInstr = { step: 1, instruction: `Walk ${walkToRoadDist}m to the road`, distance: walkToRoadDist, duration: Math.round(walkToRoadDist / 1.4 / 60) };
                    // shift existing instruction step numbers to keep ordering
                    for (let si = 0; si < instructions.length; si++) instructions[si].step = instructions[si].step + 1;
                    instructions.unshift(walkInstr);
                    stepIndex++;
                }

                // if OSRM didn't end exactly at the requested end point, append the exact point
                if (!almostEqual(endLat, endLng, lastLat, lastLng)) {
                    coordsArray.push([endLng, endLat]);
                    const walkToDestDist = Math.round(this.calculateDistance(endLat, endLng, lastLat, lastLng));
                    const arriveStep = { step: (instructions.length + 1), instruction: `Walk ${walkToDestDist}m to destination`, distance: walkToDestDist, duration: Math.round(walkToDestDist / 1.4 / 60) };
                    instructions.push(arriveStep);
                }
            } else {
                // no coords returned; ensure start/end are present
                coordsArray.push([startLng, startLat]);
                coordsArray.push([endLng, endLat]);
            }
        } catch (e) { console.warn('Failed to normalize route endpoints', e); }

        return {
            distance: Math.round(r.distance || 0),
            estimated_time: Math.round((r.duration || 0) / 60),
            path_data: {
                coordinates: coordsArray,
                type: 'LineString'
            },
            indoor_instructions: instructions.length ? instructions : this.generateRouteInstructions({ latitude: startLat, longitude: startLng, name: 'Start' }, { latitude: endLat, longitude: endLng, name: 'End' }, Math.round(r.distance || 0))
        };
    }

    displayRoute(route, startPOI, endPOI) {
        // Clear previous route
        if (this.routeLayer) {
            this.map.removeLayer(this.routeLayer);
        }

        // Draw new route
        this.routeLayer = L.polyline(route.path_data.coordinates.map(coord => [coord[1], coord[0]]), {
            color: '#1a5f7a',
            weight: 6,
            opacity: 0.8,
            lineJoin: 'round'
        }).addTo(this.map);

        // Fit map to show the entire route
        this.map.fitBounds(this.routeLayer.getBounds());

        // Update route information panel
        this.updateRouteInfo(route, startPOI, endPOI);

        // Show route panel
        document.getElementById('route-info').classList.add('active');

        // Scroll to route info
        document.getElementById('route-info').scrollIntoView({ 
            behavior: 'smooth', 
            block: 'start' 
        });
    }

    updateRouteInfo(route, startPOI, endPOI) {
        document.getElementById('route-distance').textContent = `${route.distance} m`;
        document.getElementById('route-time').textContent = `${route.estimated_time} min`;
        document.getElementById('route-type').textContent = 'Walking';

        const instructionsList = document.getElementById('instructions-list');
        instructionsList.innerHTML = '';

        route.indoor_instructions.forEach(instruction => {
            const li = document.createElement('li');
            li.className = 'instruction';
            li.innerHTML = `
                <div style="display: flex; align-items: flex-start; gap: 10px;">
                    <span style="font-weight: bold; color: #1a5f7a; min-width: 30px;">${instruction.step}.</span>
                    <div style="flex: 1;">
                        <div>${instruction.instruction}</div>
                        ${instruction.distance > 0 ? `
                            <div style="font-size: 0.8rem; color: #666; margin-top: 5px;">
                                ${instruction.distance}m • ${instruction.duration} min
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
            instructionsList.appendChild(li);
        });

        // Store current route for saving
        this.currentRoute = {
            route,
            startPOI,
            endPOI,
            calculatedAt: new Date()
        };
        // start live tracking simulation for this route (will stop when completed)
        try { this.startRouteTracking(route); } catch (e) {}
    }

    // Display route source badge and retry controls in the route header
    setRouteSource(source = 'fallback') {
        try {
            const header = document.querySelector('.route-header');
            if (!header) return;

            let badge = document.getElementById('route-source-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.id = 'route-source-badge';
                badge.style.marginLeft = '12px';
                badge.style.display = 'inline-flex';
                badge.style.alignItems = 'center';
                badge.style.gap = '8px';
                header.querySelector('.route-title')?.appendChild(badge);
            }

            // clear contents
            badge.innerHTML = '';

            const label = document.createElement('span');
            label.style.fontSize = '0.85rem';
            label.style.padding = '4px 8px';
            label.style.borderRadius = '12px';
            label.style.color = 'white';
            label.style.fontWeight = '600';

            if (source === 'osrm') {
                label.textContent = 'Snapped (OSRM)';
                label.style.background = '#2b9348';
            } else {
                label.textContent = 'Fallback (approx)';
                label.style.background = '#7a7a7a';
            }

            badge.appendChild(label);

            // Add retry/snapped toggle buttons
            const retryBtn = document.createElement('button');
            retryBtn.textContent = 'Retry Snapped';
            retryBtn.style.marginLeft = '6px';
            retryBtn.className = 'btn btn-sm btn-outline-secondary';
            retryBtn.addEventListener('click', () => {
                // Re-run route calculation forcing OSRM (will show error if unavailable)
                try {
                    this.calculateRoute({ forceOSRM: true });
                } catch (e) { console.warn('Retry OSRM failed', e); }
            });

            const fallbackBtn = document.createElement('button');
            fallbackBtn.textContent = 'Force Fallback';
            fallbackBtn.style.marginLeft = '4px';
            fallbackBtn.className = 'btn btn-sm btn-outline-secondary';
            fallbackBtn.addEventListener('click', () => {
                try {
                    this.calculateRoute({ forceFallback: true });
                } catch (e) { console.warn('Force fallback failed', e); }
            });

            badge.appendChild(retryBtn);
            badge.appendChild(fallbackBtn);
        } catch (e) { console.warn('setRouteSource failed', e); }
    }

    showPOIDetails(poiId) {
        const poi = this.pois.find(p => p.id === poiId);
        if (!poi) return;

        const modal = document.getElementById('poi-modal');
        const title = document.getElementById('poi-modal-title');
        const body = document.getElementById('poi-modal-body');

        title.textContent = this.getLocalizedPOIName(poi);

        body.innerHTML = `
            <div class="poi-details">
                <div class="poi-detail-section">
                    <h4><i class="fas fa-info-circle"></i> ${this.t('poi.description', 'Basic Information')}</h4>
                    <div class="poi-info-grid">
                        <div class="poi-info-item">
                            <span class="poi-info-label">${this.t('poi.building', 'Building')}</span>
                            <span class="poi-info-value">${poi.building}</span>
                        </div>
                        <div class="poi-info-item">
                            <span class="poi-info-label">${this.t('poi.category', 'Category')}</span>
                            <span class="poi-info-value">${this.formatCategory(poi.category)}</span>
                        </div>
                        <div class="poi-info-item">
                            <span class="poi-info-label">${this.t('poi.floors', 'Floors')}</span>
                            <span class="poi-info-value">${poi.floor}</span>
                        </div>
                        <div class="poi-info-item">
                            <span class="poi-info-label">${this.t('poi.opening_hours', 'Opening Hours')}</span>
                            <span class="poi-info-value">${poi.opening_hours}</span>
                        </div>
                    </div>
                </div>

                <div class="poi-detail-section">
                    <h4><i class="fas fa-align-left"></i> ${this.t('poi.description', 'Description')}</h4>
                    <p>${poi.description}</p>
                </div>

                ${poi.details && (poi.details.type || poi.details.departments || poi.details.facilities) ? `
                <div class="poi-detail-section">
                    <h4><i class="fas fa-building"></i> ${this.t('poi.departments', 'Departments & Facilities')}</h4>
                    <div class="poi-info-grid">
                        ${poi.details.type ? `
                        <div class="poi-info-item">
                            <span class="poi-info-label">${this.t('poi.description', 'Type')}</span>
                            <span class="poi-info-value">${poi.details.type}</span>
                        </div>
                        ` : ''}
                        ${poi.details.departments && Array.isArray(poi.details.departments) ? `
                        <div class="poi-info-item">
                            <span class="poi-info-label">${this.t('poi.departments', 'Departments')}</span>
                            <span class="poi-info-value">${poi.details.departments.join(', ')}</span>
                        </div>
                        ` : ''}
                        ${poi.details.facilities && Array.isArray(poi.details.facilities) ? `
                        <div class="poi-info-item">
                            <span class="poi-info-label">${this.t('poi.facilities', 'Facilities')}</span>
                            <span class="poi-info-value">${poi.details.facilities.join(', ')}</span>
                        </div>
                        ` : ''}
                    </div>
                </div>
                ` : ''}

                ${poi.details && poi.details.contact ? `
                <div class="poi-detail-section">
                    <h4><i class="fas fa-phone"></i> ${this.t('poi.contact', 'Contact Information')}</h4>
                    <p style="white-space: pre-line;">${poi.details.contact}</p>
                </div>
                ` : ''}

                <div class="poi-detail-section">
                    <h4><i class="fas fa-map-marker-alt"></i> ${this.t('poi.location', 'Location')}</h4>
                    <p>Latitude: ${poi.latitude}</p>
                    <p>Longitude: ${poi.longitude}</p>
                    <button onclick="app.setAsDestination('${poi.id}')" class="btn btn-primary" style="margin-top: 10px;">
                        <i class="fas fa-flag"></i> ${this.t('poi.set_destination', 'Set as Destination')}
                    </button>
                </div>
            </div>
        `;

        modal.style.display = 'block';
    }

    closePOIModal() {
        document.getElementById('poi-modal').style.display = 'none';
    }

    setAsDestination(poiId) {
        // Accept either id or name
        const poi = this.pois.find(p => p.id === poiId || p.name === poiId);
        const endSelect = document.getElementById('end-select');
        if (endSelect) {
            endSelect.value = poi ? (poi._id || poi.id) : poiId;
            try { endSelect.dispatchEvent(new Event('change')); } catch (e) {}
        }
        document.getElementById('end-point-id').value = poi ? (poi._id || poi.id) : poiId;
        this.closePOIModal();
        this.showMessage('Destination set successfully!', 'success');
    }

    normalizePointInput(val) {
        if (!val) return '';
        const trimmed = String(val).trim();
        if (/^current$/i.test(trimmed) || /^current location$/i.test(trimmed)) return 'current';
        // If input matches a POI id, return id; if matches name, return the poi id as well
        const byId = this.pois.find(p => p.id === trimmed);
        if (byId) return byId.id;
        const byName = this.pois.find(p => p.name.toLowerCase() === trimmed.toLowerCase());
        if (byName) return byName.id;
        return trimmed;
    }

    handleCategoryFilter(category) {
        try {
            // Update active class on category buttons
            document.querySelectorAll('.category-item').forEach(item => {
                item.classList.toggle('active', item.dataset.category === category);
            });

            // Normalize category key (lowercase) for comparison with POI data
            const key = (category || '').toLowerCase();
            // Load POIs for selected category (use 'all' to show every POI)
            this.loadPOIs(key === 'all' ? 'all' : key);

            // Populate category POI list for quick access (overlay mode)
            try {
                const listEl = document.getElementById('category-poi-list');
                // determine whether the clicked category is active after toggle
                const isActive = !!document.querySelector('.category-item.active') && document.querySelector('.category-item.active').dataset.category === category;
                if (listEl) {
                    // if category was deactivated, clear and hide overlay
                    if (!isActive) {
                        try { this.closeCategoryOverlay(); } catch (e) { /* ignore */ }
                        return;
                    }
                    listEl.innerHTML = '';
                    const filtered = key === 'all' ? Array.from(this.pois) : this.pois.filter(p => (p.category || '').toLowerCase() === key);
                    if (!filtered.length) {
                        listEl.innerHTML = '<div style="color:#666;font-size:0.95rem;">No places in this category.</div>';
                        listEl.classList.add('category-overlay');
                    } else {
                        const ul = document.createElement('div');
                        ul.style.display = 'grid';
                        ul.style.gridTemplateColumns = '1fr';
                        ul.style.gap = '6px';
                        // add a close button to the overlay
                        const closeBtn = document.createElement('button');
                        closeBtn.className = 'overlay-close overlay-back';
                        closeBtn.innerHTML = '← Back';
                        closeBtn.setAttribute('aria-label','Back to categories');
                        closeBtn.addEventListener('click', (ev) => {
                            ev.stopPropagation();
                            try { this.closeCategoryOverlay(); } catch (e) { /* ignore */ }
                        });
                        listEl.appendChild(closeBtn);
                        filtered.forEach(p => {
                            const item = document.createElement('div');
                            item.className = 'category-poi-item';
                            item.style.padding = '8px';
                            item.style.borderRadius = '6px';
                            item.style.background = '#fff';
                            item.style.cursor = 'pointer';
                            item.style.display = 'flex';
                            item.style.justifyContent = 'space-between';
                            item.style.alignItems = 'center';
                            item.innerHTML = `<div style="font-weight:600;">${this.getLocalizedPOIName(p)}</div><div style="font-size:0.85rem;color:#666">${p.building||''}</div>`;
                            item.addEventListener('click', () => {
                                try {
                                    // close overlay first so the UI returns to categories
                                    try { this.closeCategoryOverlay(); } catch (e) { /* ignore */ }
                                    // small timeout to ensure overlay DOM removed before opening modal
                                    setTimeout(() => { try { this.showPOIDetails(p.id); } catch (e) { console.warn(e); } }, 50);
                                } catch (e) { console.warn(e); }
                            });
                            // small "Set as destination" button
                            const btn = document.createElement('button');
                            btn.className = 'btn btn-sm btn-outline-secondary';
                            btn.textContent = 'Set destination';
                            btn.style.marginLeft = '8px';
                            btn.onclick = (ev) => {
                                ev.stopPropagation();
                                try {
                                    const endSelect = document.getElementById('end-select');
                                    if (endSelect) {
                                        endSelect.value = p._id || p.id;
                                        try { endSelect.dispatchEvent(new Event('change')); } catch (e) {}
                                    }
                                    this.map.setView([p.latitude, p.longitude], 18);
                                    // close overlay after setting destination so categories reappear
                                    try { this.closeCategoryOverlay(); } catch (e) { /* ignore */ }
                                } catch (e) { console.warn('set destination from category list failed', e); }
                            };
                            item.appendChild(btn);
                            ul.appendChild(item);
                        });
                        listEl.appendChild(ul);
                        listEl.classList.add('category-overlay');

                        // remove any previous listener
                        if (this._categoryOverlayListener) {
                            document.removeEventListener('click', this._categoryOverlayListener);
                            this._categoryOverlayListener = null;
                        }

                        // click outside to dismiss overlay (delegates to closeCategoryOverlay)
                        this._categoryOverlayListener = (ev) => {
                            try {
                                const cf = document.querySelector('.category-filter');
                                if (!cf) return;
                                if (!cf.contains(ev.target)) {
                                    try { this.closeCategoryOverlay(); } catch (e) { /* ignore */ }
                                }
                            } catch (e) { /* ignore */ }
                        };
                        // attach after a tick so the opening click doesn't immediately close it
                        setTimeout(() => document.addEventListener('click', this._categoryOverlayListener));

                        // Esc key should also close the overlay
                        if (!this._categoryOverlayKeyListener) {
                            this._categoryOverlayKeyListener = (ev) => {
                                if (ev.key === 'Escape' || ev.key === 'Esc') {
                                    try { this.closeCategoryOverlay(); } catch (e) { /* ignore */ }
                                }
                            };
                            document.addEventListener('keydown', this._categoryOverlayKeyListener);
                        }
                    }
                }
            } catch (e) { console.warn('populate category list failed', e); }
        } catch (e) { console.warn('handleCategoryFilter failed', e); }
    }

    handleQuickLink(location) {
        const poi = this.pois.find(p => p.id === location);
        const endSelect = document.getElementById('end-select');
        if (endSelect) {
            endSelect.value = poi ? (poi._id || poi.id) : location;
            try { endSelect.dispatchEvent(new Event('change')); } catch (e) {}
        }
        this.showMessage(`"${this.getPOIName(location)}" set as destination`, 'success');

        // Center map on the selected POI
        if (poi) {
            this.map.setView([poi.latitude, poi.longitude], 18);
        }
    }

    getPOIName(poiId) {
        const poi = this.pois.find(p => p.id === poiId);
        return poi ? poi.name : poiId;
    }

    formatCategory(category) {
        const categories = {
            'academic': 'Academic Block',
            'administrative': 'Administrative',
            'services': 'Services',
            'recreational': 'Recreational'
        };
        return categories[category] || category;
    }

    getCurrentLocation() {
        // Wrapper: attempt to resolve a good current location and apply it to the map.
        // This method will try a single high-accuracy read and then a short watch to improve accuracy.
        // Default location: Block 042 (11.854683040047707, 38.041506462045085)
        const BLOCK_042_LAT = 11.854683040047707;
        const BLOCK_042_LNG = 38.041506462045085;
        
        if (!navigator.geolocation) {
            this.showError('i18n:errors.geolocation_unsupported');
            // Use Block 042 as fallback when geolocation is not supported
            console.log('[Location] Geolocation not supported, using Block 042 as default location');
            this._setUserLocationMarker(BLOCK_042_LAT, BLOCK_042_LNG, 0);
            this.showMessage('i18n:messages.location_detected', 'success');
            return;
        }

        this.showMessage('i18n:messages.getting_location', 'info');

        // Use the shared resolver to obtain best available location
        // Use 20 second timeout and 20m accuracy for better precision
        this.resolveCurrentLocation(20000, 20).then(loc => {
            try {
                // Check if location is reasonably near campus (increased to 10km to cover all blocks)
                const distanceToCampus = this.calculateDistance(loc.lat, loc.lng, this.dtuCoordinates[0], this.dtuCoordinates[1]);
                console.log(`[Location] Distance to campus center: ${distanceToCampus}m`);
                
                // Allow locations up to 10km from campus center (covers all blocks)
                if (distanceToCampus > 10000) {
                    console.warn(`[Location] Location too far from campus: ${distanceToCampus}m`);
                    console.log('[Location] Using Block 042 as default location');
                    this._setUserLocationMarker(BLOCK_042_LAT, BLOCK_042_LNG, 0);
                    this.showMessage('i18n:messages.location_detected', 'success');
                    return;
                }

                console.log(`[Location] Location accepted: lat=${loc.lat}, lng=${loc.lng}, accuracy=${loc.accuracy}m`);
                this._setUserLocationMarker(loc.lat, loc.lng, loc.accuracy);
                this.showMessage('i18n:messages.location_detected', 'success');
            } catch (e) {
                console.warn('acceptPosition failed', e);
                console.log('[Location] Using Block 042 as default location due to error');
                this._setUserLocationMarker(BLOCK_042_LAT, BLOCK_042_LNG, 0);
                this.showMessage('i18n:messages.location_detected', 'success');
            }
        }).catch(err => {
            console.warn('Geolocation resolution failed', err);
            console.log('[Location] Using Block 042 as default location');
            this._setUserLocationMarker(BLOCK_042_LAT, BLOCK_042_LNG, 0);
            this.showMessage('i18n:messages.location_detected', 'success');
        });
    }

    // Resolve current location with optional improvement period
    // timeout: total ms to wait; desiredAccuracy: meters
    resolveCurrentLocation(timeout = 20000, desiredAccuracy = 50) {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));

            let best = null;
            let settled = false;
            let watchId = null;
            let initialPositionReceived = false;
            
            // Improved options: prioritize accuracy over speed
            // enableHighAccuracy: true - use GPS instead of WiFi/cell triangulation
            // maximumAge: 0 - don't use cached positions, always get fresh data
            // timeout: longer timeout to allow GPS to lock on
            const opts = { 
                enableHighAccuracy: true, 
                maximumAge: 0,  // Don't use cached positions - get fresh data
                timeout: Math.min(15000, timeout) 
            };

            const finish = (pos) => {
                if (settled) return;
                settled = true;
                try { if (watchId !== null) navigator.geolocation.clearWatch(watchId); } catch (e) {}
                const accuracy = pos.coords.accuracy || 9999;
                console.log(`[Geolocation] Location resolved: lat=${pos.coords.latitude}, lng=${pos.coords.longitude}, accuracy=${accuracy}m`);
                resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: accuracy });
            };

            const handleError = (err) => {
                if (settled) return;
                settled = true;
                try { if (watchId !== null) navigator.geolocation.clearWatch(watchId); } catch (e) {}
                console.warn(`[Geolocation] Error: ${err.message}`, err);
                
                // If we have a best position, use it even if not perfect
                if (best) {
                    console.log('[Geolocation] Using best available position despite error');
                    finish(best);
                } else {
                    reject(err);
                }
            };

            // Primary one-shot attempt with high accuracy settings
            try {
                navigator.geolocation.getCurrentPosition((pos) => {
                    initialPositionReceived = true;
                    best = pos;
                    const accuracy = pos.coords.accuracy || 9999;
                    console.log(`[Geolocation] Initial position: lat=${pos.coords.latitude}, lng=${pos.coords.longitude}, accuracy=${accuracy}m, desired=${desiredAccuracy}m`);
                    
                    // If accuracy is good enough, use it immediately
                    if (accuracy <= desiredAccuracy) {
                        console.log('[Geolocation] Accuracy acceptable, finishing');
                        finish(pos);
                        return;
                    }

                    // Otherwise, start a watch to try to improve accuracy
                    console.log('[Geolocation] Starting watch to improve accuracy');
                    const start = Date.now();
                    const maxWait = Math.max(5000, Math.min(18000, timeout - 2000));

                    const tryWatch = (wp) => {
                        const wpAccuracy = wp.coords.accuracy || 9999;
                        const bestAccuracy = best.coords.accuracy || 9999;
                        
                        // Keep the best position
                        if (wpAccuracy < bestAccuracy) {
                            best = wp;
                            console.log(`[Geolocation] Better position found: lat=${wp.coords.latitude}, lng=${wp.coords.longitude}, accuracy=${wpAccuracy}m`);
                        }
                        
                        // Check if accuracy is good enough
                        if (wpAccuracy <= desiredAccuracy) {
                            console.log('[Geolocation] Desired accuracy reached');
                            finish(wp);
                            return;
                        }
                        
                        // Check if we've waited long enough
                        if (Date.now() - start > maxWait) {
                            console.log('[Geolocation] Watch timeout, using best position');
                            if (best) finish(best); else finish(wp);
                        }
                    };

                    try {
                        // Watch with high accuracy settings
                        watchId = navigator.geolocation.watchPosition(
                            tryWatch, 
                            (e) => { 
                                console.warn('[Geolocation] Watch error:', e.message);
                                // Don't fail on watch error, use best available
                                if (best && !settled) finish(best);
                            }, 
                            { 
                                enableHighAccuracy: true, 
                                maximumAge: 0,  // Don't use cached positions during watch
                                timeout: maxWait 
                            }
                        );
                    } catch (e) {
                        console.warn('[Geolocation] Watch failed, using initial position', e);
                        finish(pos);
                    }
                }, handleError, opts);
            } catch (e) { 
                console.error('[Geolocation] getCurrentPosition failed', e);
                handleError(e); 
            }

            // Fallback timeout to ensure we don't wait forever
            setTimeout(() => {
                if (settled) return;
                console.log('[Geolocation] Global timeout reached');
                if (best) {
                    console.log('[Geolocation] Using best available position on timeout');
                    finish(best);
                } else {
                    handleError(new Error('Timeout getting location - no position available'));
                }
            }, timeout);
        });
    }

    // Wait for this.currentRoute to be set (used after calculateRoute call)
    _waitForCurrentRoute(timeout = 7000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                if (this.currentRoute && this.currentRoute.route) return resolve(this.currentRoute);
                if (Date.now() - start > timeout) return reject(new Error('Timeout waiting for route')); 
                setTimeout(check, 200);
            };
            check();
        });
    }

    /**
     * Start GPS tracking with real-time position updates
     * **Feature: walking-route-navigation, Property 2: Position Update Frequency**
     * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
     * 
     * Updates marker every 1-2 seconds, displays accuracy circle, centers map on user,
     * and calculates heading/bearing from GPS data.
     * 
     * @param {Object} options - Configuration options
     * @param {Function} options.onPositionUpdate - Callback when position updates (lat, lng, accuracy, heading)
     * @param {Function} options.onError - Callback on error
     * @param {boolean} options.centerMap - Whether to center map on user (default: true)
     * @param {boolean} options.showAccuracy - Whether to show accuracy circle (default: true)
     * @returns {number} Watch ID for clearing the watch later
     */
    startGPSTracking(options = {}) {
        if (!navigator.geolocation) {
            throw new Error('Geolocation not supported');
        }

        const {
            onPositionUpdate = null,
            onError = null,
            centerMap = true,
            showAccuracy = true
        } = options;

        // Store tracking state
        this._gpsTrackingActive = true;
        this._lastGPSPosition = null;
        this._lastGPSHeading = null;

        // GPS watch options: high accuracy, update every 1-2 seconds
        const watchOptions = {
            enableHighAccuracy: true,
            maximumAge: 1000,  // Accept cached position up to 1 second old
            timeout: 10000     // Wait max 10 seconds for position
        };

        // Position update handler
        const handlePositionUpdate = (position) => {
            try {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                const accuracy = position.coords.accuracy || 10;
                const heading = position.coords.heading || null;

                // Store current position
                this._lastGPSPosition = { lat, lng, accuracy, heading };

                // Update heading if available
                if (heading !== null) {
                    this._lastGPSHeading = heading;
                }

                // Update user location marker and accuracy circle
                this._setUserLocationMarker(lat, lng, accuracy);

                // Center map on user if enabled
                if (centerMap && this.map) {
                    try {
                        this.map.setView([lat, lng], Math.max(this.map.getZoom(), 17));
                    } catch (e) {
                        console.warn('Failed to center map on user position', e);
                    }
                }

                // Call custom callback if provided
                if (onPositionUpdate && typeof onPositionUpdate === 'function') {
                    try {
                        onPositionUpdate({
                            lat,
                            lng,
                            accuracy,
                            heading: this._lastGPSHeading
                        });
                    } catch (e) {
                        console.warn('Position update callback error', e);
                    }
                }
            } catch (e) {
                console.warn('GPS position update handler error', e);
            }
        };

        // Error handler
        const handleError = (error) => {
            console.warn('GPS tracking error', error);
            if (onError && typeof onError === 'function') {
                try {
                    onError(error);
                } catch (e) {
                    console.warn('Error callback failed', e);
                }
            }
        };

        // Start watching position
        try {
            const watchId = navigator.geolocation.watchPosition(
                handlePositionUpdate,
                handleError,
                watchOptions
            );

            // Store watch ID for later cleanup
            this._currentGPSWatchId = watchId;

            return watchId;
        } catch (e) {
            console.error('Failed to start GPS tracking', e);
            throw e;
        }
    }

    /**
     * Stop GPS tracking
     * Clears the watch and removes tracking markers from map
     */
    stopGPSTracking() {
        try {
            this._gpsTrackingActive = false;

            // Clear GPS watch
            if (this._currentGPSWatchId !== null && this._currentGPSWatchId !== undefined) {
                try {
                    navigator.geolocation.clearWatch(this._currentGPSWatchId);
                } catch (e) {
                    console.warn('Failed to clear GPS watch', e);
                }
                this._currentGPSWatchId = null;
            }

            // Remove tracking marker
            if (this.trackingMarker && this.map) {
                try {
                    this.map.removeLayer(this.trackingMarker);
                } catch (e) {
                    console.warn('Failed to remove tracking marker', e);
                }
                this.trackingMarker = null;
            }

            // Remove directional arrow
            this.removeDirectionalArrow();

            // Clear stored position
            this._lastGPSPosition = null;
            this._lastGPSHeading = null;
        } catch (e) {
            console.warn('Error stopping GPS tracking', e);
        }
    }

    /**
     * Create and display a directional arrow on the map pointing to the next waypoint
     * **Feature: walking-route-navigation, Property 9: Directional Arrow Rotation**
     * **Validates: Requirements 3.1, 3.2, 3.3**
     * 
     * @param {number} lat - Current user latitude
     * @param {number} lng - Current user longitude
     * @param {number} nextLat - Next waypoint latitude
     * @param {number} nextLng - Next waypoint longitude
     * @param {number} heading - User's heading in degrees (0-360)
     */
    updateDirectionalArrow(lat, lng, nextLat, nextLng, heading = 0) {
        try {
            if (!this.map || !this.currentRoute) return;

            // Calculate bearing to next waypoint
            const bearing = this.calculateBearing(lat, lng, nextLat, nextLng);

            // Calculate rotation angle relative to user heading
            const rotation = ((bearing - heading + 540) % 360) - 180;

            // Create arrow SVG icon if not exists
            if (!this._arrowIcon) {
                this._arrowIcon = L.divIcon({
                    html: `<div style="width:32px; height:32px; display:flex; align-items:center; justify-content:center; background:rgba(26,95,122,0.9); border-radius:50%; border:2px solid #2b9348;">
                        <div style="width:0; height:0; border-left:6px solid transparent; border-right:6px solid transparent; border-bottom:12px solid #2b9348; transform:rotate(0deg);" class="arrow-head"></div>
                    </div>`,
                    className: 'directional-arrow-icon',
                    iconSize: [32, 32],
                    iconAnchor: [16, 16]
                });
            }

            // Create or update arrow marker
            if (!this._directionMarker) {
                this._directionMarker = L.marker([lat, lng], { icon: this._arrowIcon, interactive: false })
                    .addTo(this.map);
            } else {
                this._directionMarker.setLatLng([lat, lng]);
            }

            // Rotate arrow
            const arrowHead = this._directionMarker.getElement()?.querySelector('.arrow-head');
            if (arrowHead) {
                arrowHead.style.transform = `rotate(${rotation}deg)`;
            }
        } catch (e) {
            console.warn('Failed to update directional arrow', e);
        }
    }

    /**
     * Remove the directional arrow from the map
     */
    removeDirectionalArrow() {
        try {
            if (this._directionMarker && this.map) {
                this.map.removeLayer(this._directionMarker);
                this._directionMarker = null;
            }
        } catch (e) {
            console.warn('Failed to remove directional arrow', e);
        }
    }

    /**
     * Update the distance countdown display
     * **Feature: walking-route-navigation, Property 4: Distance Countdown Accuracy**
     * **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
     * 
     * @param {number} distance - Distance in meters
     */
    updateDistanceCountdown(distance) {
        try {
            const overlay = document.getElementById('distance-countdown-overlay');
            const valueEl = document.getElementById('distance-countdown-value');

            if (!overlay || !valueEl) return;

            // Format distance
            let displayText;
            if (distance < 1000) {
                displayText = Math.round(distance) + ' m';
            } else {
                displayText = (distance / 1000).toFixed(1) + ' km';
            }

            valueEl.textContent = displayText;

            // Update color based on distance
            valueEl.classList.remove('warning', 'success');
            if (distance < 20) {
                valueEl.classList.add('success');
            } else if (distance < 100) {
                valueEl.classList.add('warning');
            }

            // Show overlay if not visible
            if (overlay.style.display === 'none') {
                overlay.style.display = 'block';
            }
        } catch (e) {
            console.warn('Failed to update distance countdown', e);
        }
    }

    /**
     * Hide the distance countdown display
     */
    hideDistanceCountdown() {
        try {
            const overlay = document.getElementById('distance-countdown-overlay');
            if (overlay) {
                overlay.style.display = 'none';
            }
        } catch (e) {
            console.warn('Failed to hide distance countdown', e);
        }
    }

    // Start live routing: set start to current, ensure destination chosen, calculate route, and start AR + live-follow
    async startLiveRouting() {
        if (!navigator.geolocation) throw new Error('Geolocation not supported');

        // On Android, request permissions for camera + location ahead of time
        try {
            if (this._isAndroid()) {
                try {
                    await this.requestAndroidPermissions();
                } catch (permErr) {
                    console.warn('Android permission request failed', permErr);
                    // Don't throw - continue anyway, user may have already granted permissions
                }
            }
        } catch (e) {
            console.warn('Permission request error', e);
            // Continue anyway
        }

        // Ensure destination selected
        const endSelect = document.getElementById('end-select');
        const endInput = document.getElementById('end-point');
        const endId = (document.getElementById('end-point-id') || {}).value || (endSelect ? endSelect.value : '');
        if (!endId) {
            if (endSelect) endSelect.focus();
            throw new Error('Please select a destination first');
        }

        this._liveRoutingActive = true;

        // Resolve and set current location marker
        let loc;
        try {
            this.showMessage('i18n:messages.getting_location', 'info');
            // Use 30 second timeout and accept 30m accuracy for live routing (more strict for better accuracy)
            // This ensures we get a precise location for accurate route calculation
            loc = await this.resolveCurrentLocation(30000, 30);
            console.log('[Live Routing] Current location resolved:', { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy });
            this._setUserLocationMarker(loc.lat, loc.lng, loc.accuracy);
        } catch (e) {
            console.warn('Could not resolve current location for live routing', e);
            throw new Error('Unable to determine current location. Allow location access and try again.');
        }

        // Ensure start-select is set to current (already done by _setUserLocationMarker)

        // Set AR destination from selected POI
        try {
            const destPOI = this.pois.find(p => (p._id === endId || p.id === endId));
            if (destPOI) {
                this._arDestination = {
                    latitude: destPOI.latitude || destPOI.lat,
                    longitude: destPOI.longitude || destPOI.lng
                };
            }
        } catch (e) {
            console.warn('Could not set AR destination', e);
        }

        // Check if route already exists, if not calculate it in background
        if (!this.currentRoute || !this.currentRoute.route) {
            try {
                // call calculateRoute (it schedules work internally)
                this.calculateRoute();
            } catch (e) {
                console.warn('calculateRoute call failed', e);
            }

            // Wait for route to be ready (with timeout)
            try {
                await this._waitForCurrentRoute(7000);
            } catch (e) {
                console.warn('Route not available', e);
                // Don't throw - continue with AR guidance anyway
            }
        }

        // Start AR guidance immediately (don't wait for route)
        try {
            await this.startARGuidance();
        } catch (e) {
            console.warn('AR guidance start failed', e);
            // continue even if camera not available
        }

        // Start GPS tracking with live routing callbacks
        try {
            this._lastRecalcPosition = { lat: loc.lat, lng: loc.lng };
            const recalcThreshold = 25; // meters

            this._liveFollowWatchId = this.startGPSTracking({
                onPositionUpdate: (posData) => {
                    try {
                        const { lat, lng, accuracy, heading } = posData;

                        // Update AR position so overlay responds
                        this._arPosition = { latitude: lat, longitude: lng };
                        if (heading !== null) {
                            this._arHeading = heading;
                        }
                        try { this._updateARNextWaypoint(); } catch (e) {}

                        // Move tracking marker to real user position
                        if (this.trackingMarker) {
                            this.trackingMarker.setLatLng([lat, lng]);
                        } else {
                            this.trackingMarker = L.circleMarker([lat, lng], { radius: 6, color: '#ff4d4f', fillColor: '#ff4d4f' }).addTo(this.map);
                        }

                        // Update directional arrow to point to next waypoint
                        try {
                            const route = this.currentRoute && this.currentRoute.route;
                            if (route && route.path_data && route.path_data.coordinates && route.path_data.coordinates.length > 0) {
                                // Find next waypoint on the route
                                const coords = route.path_data.coordinates;
                                let nextWaypoint = coords[0];
                                
                                // Find the closest waypoint ahead of user
                                for (let i = 0; i < coords.length; i++) {
                                    const dist = this.calculateDistance(lat, lng, coords[i][1], coords[i][0]);
                                    if (dist > 5) { // At least 5m ahead
                                        nextWaypoint = coords[i];
                                        break;
                                    }
                                }
                                
                                // Update arrow pointing to next waypoint
                                this.updateDirectionalArrow(lat, lng, nextWaypoint[1], nextWaypoint[0], heading || 0);
                            }
                        } catch (e) { console.warn('Failed to update directional arrow', e); }

                        // Update distance countdown display
                        try {
                            const dest = this.currentRoute && this.currentRoute.endPOI;
                            if (dest) {
                                const distToDest = this.calculateDistance(lat, lng, dest.latitude, dest.longitude);
                                this.updateDistanceCountdown(distToDest);
                            }
                        } catch (e) { console.warn('Failed to update distance countdown', e); }

                        // Optionally recalc route if user moved significantly from last recalc point
                        const d = this.calculateDistance(lat, lng, this._lastRecalcPosition.lat, this._lastRecalcPosition.lng);
                        if (d > recalcThreshold) {
                            // Notify user of deviation
                            try {
                                this.showMessage('i18n:messages.recalculating_route', 'info');
                            } catch (e) {}
                            
                            // Recalc route in background (preserve AR state)
                            try { this.calculateRoute(); } catch (e) { console.warn('Background recalculation failed', e); }
                            this._lastRecalcPosition = { lat, lng };
                        }

                        // Check arrival at destination (within ~6 meters)
                        try {
                            const dest = this.currentRoute && this.currentRoute.endPOI;
                            if (dest) {
                                const distToDest = this.calculateDistance(lat, lng, dest.latitude, dest.longitude);
                                if (distToDest <= 6) {
                                    this.showMessage('i18n:messages.arrived_destination', 'success');
                                    this.removeDirectionalArrow(); // Hide arrow on arrival
                                    this.hideDistanceCountdown(); // Hide distance countdown on arrival
                                    this.stopLiveRouting();
                                }
                            }
                        } catch (e) {}
                    } catch (e) { console.warn('Live routing position update error', e); }
                },
                onError: (error) => {
                    console.warn('Live routing GPS error', error);
                },
                centerMap: true,
                showAccuracy: true
            });
        } catch (e) { console.warn('Failed to start GPS tracking for live routing', e); }

        // Mark UI active
        this._liveRoutingActive = true;
    }

    stopLiveRouting() {
        try {
            this._liveRoutingActive = false;
            // Stop GPS tracking (which also removes tracking marker)
            this.stopGPSTracking();
            // Stop AR guidance
            try { this.stopARGuidance(); } catch (e) {}
        } catch (e) { console.warn('stopLiveRouting failed', e); }
    }

    // Apply user location to the map (marker + accuracy circle) and set start-select
    _setUserLocationMarker(lat, lng, accuracy = 10) {
        try {
            if (this.userLocationMarker) {
                try { this.map.removeLayer(this.userLocationMarker); } catch (e) {}
            }
            if (this.userAccuracyCircle) {
                try { this.map.removeLayer(this.userAccuracyCircle); } catch (e) {}
            }

            this.userLocationMarker = L.marker([lat, lng], { title: 'Your location' })
                .addTo(this.map)
                .bindPopup(this.t('messages.location_detected', 'Your Current Location'));

            // Add click handler to show location details
            this.userLocationMarker.on('click', () => {
                this.showLocationDetails(lat, lng);
            });

            this.userAccuracyCircle = L.circle([lat, lng], {
                radius: Math.max(accuracy || 5, 5),
                color: '#1a5f7a',
                weight: 1,
                fillOpacity: 0.1
            }).addTo(this.map);

            // store latest accuracy for decision-making elsewhere
            this.userLocationAccuracy = accuracy || 0;

            this.map.setView([lat, lng], 17);

            const startSelect = document.getElementById('start-select');
            if (startSelect) {
                startSelect.value = 'current';
                try { startSelect.dispatchEvent(new Event('change')); } catch (e) {}
            }
        } catch (e) { console.warn('Failed to set user location marker', e); }
    }

    toggleSatelliteView() {
        if (this.map.hasLayer(this.satelliteLayer)) {
            // Switch to standard map
            this.map.removeLayer(this.satelliteLayer);
            this.map.addLayer(this.standardLayer);
            this.showMessage('i18n:messages.switched_standard', 'success');
        } else {
            // Switch to satellite
            this.map.removeLayer(this.standardLayer);
            this.map.addLayer(this.satelliteLayer);
            this.showMessage('i18n:messages.switched_satellite', 'success');
        }
    }

    handleNavigation(page) {
        // Update active nav link
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.remove('active');
        });
        event.currentTarget.classList.add('active');

        switch (page) {
            case 'home':
                this.map.setView(this.dtuCoordinates, 16);
                break;
            case 'directions':
                const ss = document.getElementById('start-select'); if (ss) ss.focus();
                break;
            case 'feedback':
                this.showFeedbackPanel();
                break;
            case 'about':
                this.showAboutInfo();
                break;
        }
    }


    // Admin login only
    showAdminLoginPanel() {
        document.getElementById('admin-login-panel').style.display = 'block';
        document.getElementById('admin-username').focus();
    }

    hideAdminLoginPanel() {
        document.getElementById('admin-login-panel').style.display = 'none';
        document.getElementById('admin-username').value = '';
        document.getElementById('admin-password').value = '';
        document.getElementById('admin-login-message').innerHTML = '';
    }

    async handleAdminLogin() {
        const username = document.getElementById('admin-username').value.trim();
        const password = document.getElementById('admin-password').value;

        if (!username || !password) {
            this.showMessage('i18n:messages_extra.admin_login_prompt', 'error', 'admin-login-message');
            return;
        }

        // Show loading
        const btn = document.getElementById('admin-login-submit-btn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing In...';

        // Real API call
        try {
            const res = await fetch(`${this.apiBase}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            let data = {};
            try { data = await res.json(); } catch (e) { data = {}; }

            console.debug('Admin login response', { status: res.status, ok: res.ok, body: data });

            if (!res.ok) {
                // show server-provided error when present
                const serverMsg = data && (data.error || data.message) ? (data.error || data.message) : 'Login failed';
                this.showMessage(serverMsg, 'error', 'admin-login-message');
                return;
            }

            if (!data.user) {
                this.showMessage('Invalid login response from server', 'error', 'admin-login-message');
                return;
            }

            if (data.user.role !== 'admin') {
                // Provide clearer feedback if credentials are valid but user is not admin
                this.showMessage(`Access denied: user role is '${data.user.role}'`, 'error', 'admin-login-message');
                return;
            }

            // Save token and user info
            localStorage.setItem('authToken', data.token);
            localStorage.setItem('currentUser', JSON.stringify(data.user));
            this.currentUser = data.user;
            this.hideAdminLoginPanel();
            this.showMessage('i18n:messages_extra.admin_login_success', 'success');
            // Show admin controls
            this.updateUserInterface();
            // Load admin users list
            this.loadAdminUsers();
        } catch (err) {
            console.error('Admin login error', err);
            this.showMessage(err.message || 'Login failed', 'error', 'admin-login-message');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
        }
    }

    // --- User Feedback Modal / Submission ---
    openUserFeedbackModal() {
        const modal = document.getElementById('user-feedback-modal');
        if (!modal) return;
        // ensure datalist is populated
        this.populateDatalists();
        modal.style.display = 'block';
        // init rating stars behavior
        this.initRatingWidget();
    }

    closeUserFeedbackModal() {
        const modal = document.getElementById('user-feedback-modal');
        if (!modal) return;
        modal.style.display = 'none';
    }

    initRatingWidget() {
        const container = document.getElementById('fb-rating');
        const input = document.getElementById('fb-rating-value');
        if (!container || !input) return;
        container.innerHTML = '';
        // create 5 clickable stars
        for (let i = 1; i <= 5; i++) {
            const star = document.createElement('span');
            star.textContent = '★';
            star.style.cursor = 'pointer';
            star.style.marginRight = '6px';
            star.dataset.value = String(i);
            star.onclick = () => {
                input.value = String(i);
                // highlight stars
                Array.from(container.children).forEach(c => {
                    c.style.opacity = (Number(c.dataset.value) <= i) ? '1' : '0.33';
                });
            };
            container.appendChild(star);
        }
        // default opacity
        Array.from(container.children).forEach(c => c.style.opacity = '0.33');
    }

    async handleSubmitFeedback() {
        const type = (document.getElementById('fb-type') || {}).value;
        const title = (document.getElementById('fb-title') || {}).value?.trim();
        const rating = parseInt((document.getElementById('fb-rating-value') || {}).value || '0');
        const relatedName = (document.getElementById('fb-related') || {}).value?.trim();
        const message = (document.getElementById('fb-message') || {}).value?.trim();

        const statusEl = document.getElementById('feedback-status');

        if (!title || !message) {
            if (statusEl) statusEl.innerHTML = '<div class="error-message">Please provide title and message</div>';
            return;
        }

        const token = localStorage.getItem('authToken');

        // Prefer hidden fb-related-id if set, otherwise map relatedName to POI id when possible
        let relatedPOI = undefined;
        const fbRelatedId = (document.getElementById('fb-related-id') || {}).value;
        if (fbRelatedId) {
            relatedPOI = fbRelatedId;
        } else if (relatedName) {
            // try local POIs first (case-insensitive name match)
            const poiLocal = this.pois.find(p => p.name.toLowerCase() === relatedName.toLowerCase() || (p.building && p.building.toLowerCase() === relatedName.toLowerCase()));
            if (poiLocal) {
                relatedPOI = poiLocal._id || poiLocal.id;
            } else {
                // if looks like an ObjectId, pass through
                if (/^[0-9a-fA-F]{24}$/.test(relatedName)) {
                    relatedPOI = relatedName;
                } else {
                    // fallback: ask backend to resolve by name (best-effort)
                    try {
                        const res = await fetch(`${this.apiBase}/pois/by-name?name=${encodeURIComponent(relatedName)}`);
                        if (res && res.ok) {
                            const data = await res.json();
                            if (data && data.poi) {
                                relatedPOI = data.poi._id || data.poi.id || undefined;
                            }
                        }
                    } catch (e) {
                        // non-fatal: leave relatedPOI undefined and let server-side fallback handle it
                    }
                }
            }
        }

        // Choose endpoint: authenticated users -> /feedback, anonymous -> /feedback/public
        const endpoint = token ? `${this.apiBase}/feedback` : `${this.apiBase}/feedback/public`;

        const payload = { type, title, message, rating, relatedPOI, isPublic: false };
        // include name/email for anonymous submissions
        if (!token) {
            const name = (document.getElementById('fb-name') || {}).value?.trim();
            const email = (document.getElementById('fb-email') || {}).value?.trim();
            if (name) payload.name = name;
            if (email) payload.email = email;
        }
        // Optionally include a name for anonymous submissions (if user filled fb-title with name appended or separate input exists)
        // If not logged in we can allow a simple 'name' property if provided via fb-related or similar; skipping here for brevity.

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const res = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to submit feedback');
            if (statusEl) statusEl.innerHTML = '<div class="success-message">Feedback submitted. Thank you!</div>';
            setTimeout(() => this.closeUserFeedbackModal(), 1200);
        } catch (err) {
            if (statusEl) statusEl.innerHTML = `<div class="error-message">${err.message}</div>`;
        }
    }

    updateUserInterface() {
        // Show/hide admin UI based on `this.currentUser`
        const adminPanel = document.getElementById('admin-panel');
        const userFeatures = document.getElementById('user-features');
        const adminBtn = document.getElementById('admin-login');

        if (this.currentUser && this.currentUser.role === 'admin') {
            if (adminPanel) adminPanel.style.display = 'block';
            if (userFeatures) userFeatures.style.display = 'block';
            if (adminBtn) adminBtn.style.display = 'none';

            // Populate admin info
            const adminWelcome = document.getElementById('admin-welcome');
            if (adminWelcome) adminWelcome.textContent = `Welcome, ${this.currentUser.username}`;

            // Connect socket.io once and join admin room to receive real-time events
            try {
                if (!this.socket && window.io) {
                    this.socket = window.io();
                    this.socket.on('connect', () => {
                        try { this.socket.emit('join-admin'); } catch (e) {}
                        // Also join user room for this admin
                        try { if (this.currentUser && this.currentUser._id) this.socket.emit('join-user', this.currentUser._id); } catch (e) {}
                    });

                    // New feedback arrives -> refresh list and show a toast
                    this.socket.on('new-feedback', (payload) => {
                        this.showToast('New feedback received', 'info');
                        // Prepend the incoming feedback item if present
                        try {
                            if (payload && payload.feedback) {
                                // Add to stored list
                                if (!this.allFeedbacks) this.allFeedbacks = [];
                                this.allFeedbacks.unshift(payload.feedback);
                                
                                // Prepend to UI if section is visible
                                const fbSection = document.getElementById('admin-feedback-section');
                                if (fbSection && fbSection.style.display !== 'none') {
                                    this.prependFeedbackItem(payload.feedback);
                                }
                                
                                // increment badge
                                const badge = document.getElementById('admin-feedback-badge');
                                if (badge) {
                                    const cur = parseInt(badge.textContent || '0') || 0;
                                    this.updateFeedbackBadge(cur + 1);
                                }
                            } else {
                                // fallback: reload list
                                const fbSection = document.getElementById('admin-feedback-section');
                                if (fbSection && fbSection.style.display !== 'none') this.loadAdminFeedback();
                            }
                        } catch (e) {
                            console.warn('Failed handling new-feedback payload', e);
                        }
                    });

                    // load admin usage analytics and stats when admin connects
                    try { this.loadAdminUsage(); } catch (e) {}
                    try { this.loadAdminStats(); } catch (e) {}

                    // You can listen for other admin events here
                }
            } catch (e) {
                console.warn('Socket connection failed', e);
            }
        } else {
            if (adminPanel) adminPanel.style.display = 'none';
            if (userFeatures) userFeatures.style.display = 'none';
            if (adminBtn) adminBtn.style.display = 'block';

            // If logged out, disconnect socket if exists
            try {
                if (this.socket) {
                    try { this.socket.emit('leave-admin'); } catch (e) {}
                    this.socket.disconnect();
                    this.socket = null;
                }
            } catch (e) {}
        }
    }

    // Fetch and render admin users (requires admin token)
    async loadAdminUsers() {
        const usersListEl = document.getElementById('admin-users-list');
        if (!usersListEl) return;
        usersListEl.innerHTML = 'Loading users...';

        const token = localStorage.getItem('authToken');
        if (!token) {
            usersListEl.innerHTML = this.t('errors_extra.not_authenticated', 'Not authenticated');
            return;
        }

        try {
            const res = await fetch(`${this.apiBase}/auth/users`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load users');

            this.renderAdminUsers(data.users || []);
            // also load broadcasts for admin panel
            try { await this.loadAdminBroadcasts(); } catch (e) {}
            // update stats as well
            try { this.loadAdminStats(); } catch (e) {}
            // also load feedback unread count
            this.loadFeedbackCount();
            // also load usage analytics
            try { this.loadAdminUsage(); } catch (e) {}
        } catch (err) {
            usersListEl.innerHTML = `<div class="error-message">${err.message}</div>`;
        }
    }

    // Load admin stats (total users, active users)
    async loadAdminStats() {
        const token = localStorage.getItem('authToken');
        if (!token) return;
        try {
            const res = await fetch(`${this.apiBase}/admin/stats`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!res.ok) return;
            const data = await res.json();
            const totalEl = document.getElementById('admin-user-count');
            const activeEl = document.getElementById('admin-active-count');
            if (totalEl) totalEl.textContent = (data.totalUsers != null) ? String(data.totalUsers) : '--';
            if (activeEl) activeEl.textContent = (data.activeUsers != null) ? String(data.activeUsers) : '--';
        } catch (e) {
            console.warn('loadAdminStats failed', e);
        }
    }

    // Load admin usage analytics (counts)
    async loadAdminUsage() {
        const token = localStorage.getItem('authToken');
        if (!token) return;
        try {
            const ranges = ['today','week','month','year'];
            const results = {};
            for (const r of ranges) {
                const res = await fetch(`${this.apiBase}/admin/usage?range=${r}`, { headers: { 'Authorization': `Bearer ${token}` } });
                if (!res.ok) continue;
                const data = await res.json();
                results[r] = data;
            }

            // update UI
            document.getElementById('usage-today').textContent = results['today'] ? results['today'].total : '--';
            document.getElementById('usage-week').textContent = results['week'] ? results['week'].total : '--';
            document.getElementById('usage-month').textContent = results['month'] ? results['month'].total : '--';
            document.getElementById('usage-year').textContent = results['year'] ? results['year'].total : '--';

            const breakdownEl = document.getElementById('usage-breakdown');
            if (breakdownEl) {
                const br = (results['week'] && results['week'].breakdown) || [];
                if (!br.length) {
                    breakdownEl.textContent = 'No breakdown available';
                } else {
                    breakdownEl.innerHTML = br.map(b => `<div>${b._id}: ${b.count}</div>`).join('');
                }
            }
            // load timeseries for chart (last 30 days)
            try {
                const tsRes = await fetch(`${this.apiBase}/admin/usage/timeseries?days=30`, { headers: { 'Authorization': `Bearer ${token}` } });
                if (tsRes.ok) {
                    const ts = await tsRes.json();
                    const labels = (ts.series || []).map(s => s.date);
                    const data = (ts.series || []).map(s => s.count);
                    this.renderUsageChart(labels, data);
                }
            } catch (e) {
                console.warn('Failed to load timeseries for chart', e);
            }
        } catch (e) {
            console.warn('loadAdminUsage failed', e);
        }
    }

    renderUsageChart(labels, data) {
        try {
            const ctx = document.getElementById('usage-chart');
            if (!ctx) return;
            if (this.usageChart) {
                this.usageChart.data.labels = labels;
                this.usageChart.data.datasets[0].data = data;
                this.usageChart.update();
                return;
            }

            this.usageChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Events per day',
                        data: data,
                        backgroundColor: 'rgba(26,95,122,0.85)'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: { display: false },
                        y: { beginAtZero: true }
                    },
                    plugins: {
                        legend: { display: false }
                    }
                }
            });
        } catch (e) { console.warn('renderUsageChart failed', e); }
    }

    // Render a simple SVG sparkline into elementId using series [{date,count}]
    renderSparkline(elementId, series) {
        try {
            const el = document.getElementById(elementId);
            if (!el) return;
            const values = series.map(s => s.count);
            const w = Math.max(200, el.clientWidth || 300);
            const h = 48;
            const max = Math.max(1, ...values);
            const min = Math.min(...values);

            const norm = (v) => {
                if (max === min) return h / 2;
                return h - ((v - min) / (max - min)) * (h - 6) - 3;
            };

            const step = w / Math.max(1, values.length - 1);
            const points = values.map((v, i) => `${i * step},${norm(v)}`).join(' ');

            const svg = `
                <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
                    <polyline points="${points}" fill="none" stroke="#1a5f7a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
                </svg>
            `;
            el.innerHTML = svg;
        } catch (e) { console.warn('renderSparkline failed', e); }
    }

    // Load events page for admin event viewer
    async loadEventsPage(page = 1) {
        const token = localStorage.getItem('authToken');
        if (!token) return;
        const type = (document.getElementById('event-filter-type') || {}).value || '';
        try {
            const res = await fetch(`${this.apiBase}/admin/events?page=${page}&limit=20${type?`&eventType=${encodeURIComponent(type)}`:''}`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!res.ok) throw new Error('Failed loading events');
            const data = await res.json();

            const tbody = document.getElementById('events-table-body');
            tbody.innerHTML = '';
            (data.items || []).forEach(it => {
                const tr = document.createElement('tr');
                const when = new Date(it.createdAt).toLocaleString();
                const user = it.user && it.user.username ? it.user.username : (it.user ? it.user : 'Guest');
                const info = it.meta ? JSON.stringify(it.meta) : '';
                tr.innerHTML = `<td style="white-space:nowrap;">${when}</td><td>${it.eventType}</td><td>${user}</td><td style="max-width:400px; overflow:hidden; text-overflow:ellipsis;">${info}</td>`;
                tbody.appendChild(tr);
            });

            document.getElementById('events-page').textContent = String(data.page || page);

            // load sparkline for last 30 days
            const tsRes = await fetch(`${this.apiBase}/admin/usage/timeseries?days=30`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (tsRes.ok) {
                const ts = await tsRes.json();
                this.renderSparkline('events-sparkline', ts.series || []);
            }
        } catch (e) {
            console.warn('loadEventsPage failed', e);
        }
    }

    // Send a usage tracking event to backend
    async trackEvent(eventType, path, meta) {
        try {
            await fetch(`${this.apiBase}/usage/track`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ eventType, path, meta })
            });
        } catch (e) {
            // non-fatal
        }
    }

    async loadFeedbackCount() {
        const badge = document.getElementById('admin-feedback-badge');
        if (!badge) return;
        const token = localStorage.getItem('authToken');
        if (!token) return;
        try {
            const res = await fetch(`${this.apiBase}/feedback?unreadOnly=true`, { headers: { 'Authorization': `Bearer ${token}` } });
            const data = await res.json();
            if (!res.ok) return;
            const count = Array.isArray(data) ? data.length : 0;
            this.updateFeedbackBadge(count);
        } catch (e) {
            // ignore
        }
    }

    // Fetch and render admin feedback (admin-only)
    async loadAdminFeedback() {
        const listEl = document.getElementById('admin-feedback-list');
        if (!listEl) return;
        listEl.innerHTML = '<div style="text-align:center; color:#999; padding:20px;">Loading feedback...</div>';

        const token = localStorage.getItem('authToken');
        if (!token) {
            listEl.innerHTML = `<div class="error-message">Not authenticated</div>`;
            return;
        }

        try {
            const res = await fetch(`${this.apiBase}/feedback`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load feedback');

            // Store full list for filtering
            this.allFeedbacks = data || [];
            this.renderAdminFeedback(this.allFeedbacks);
            
            // Setup filter handlers
            this.setupFeedbackFilters();
            
            // update badge to 0 when loaded
            this.updateFeedbackBadge(0);
        } catch (err) {
            listEl.innerHTML = `<div class="error-message">${err.message}</div>`;
        }
    }

    setupFeedbackFilters() {
        const typeFilter = document.getElementById('feedback-filter-type');
        const searchInput = document.getElementById('feedback-search');
        const clearBtn = document.getElementById('feedback-clear-filters');

        if (typeFilter) {
            typeFilter.addEventListener('change', () => this.applyFeedbackFilters());
        }

        if (searchInput) {
            searchInput.addEventListener('input', () => this.applyFeedbackFilters());
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (typeFilter) typeFilter.value = '';
                if (searchInput) searchInput.value = '';
                this.applyFeedbackFilters();
            });
        }
    }

    applyFeedbackFilters() {
        const typeFilter = document.getElementById('feedback-filter-type')?.value || '';
        const searchTerm = document.getElementById('feedback-search')?.value.toLowerCase() || '';

        let filtered = this.allFeedbacks || [];

        // Apply type filter
        if (typeFilter) {
            filtered = filtered.filter(f => f.type === typeFilter);
        }

        // Apply search filter
        if (searchTerm) {
            filtered = filtered.filter(f => 
                (f.title && f.title.toLowerCase().includes(searchTerm)) ||
                (f.message && f.message.toLowerCase().includes(searchTerm))
            );
        }

        this.renderAdminFeedback(filtered);
    }

    renderAdminFeedback(items) {
        const listEl = document.getElementById('admin-feedback-list');
        if (!listEl) return;
        if (!items || items.length === 0) {
            listEl.innerHTML = '<div style="text-align:center; color:#999; padding:20px;">No feedback available</div>';
            return;
        }

        // prepend newest first
        items.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));

        const rows = items.map(f => {
            const time = f.createdAt ? new Date(f.createdAt).toLocaleString() : '';
            const status = f.status || 'pending';
            const user = f.user && f.user.username ? f.user.username : (f.senderName || 'Anonymous');
            const userEmail = f.user && f.user.email ? f.user.email : (f.senderEmail || '');
            const related = f.relatedPOI ? ` — ${f.relatedPOI.name}` : '';
            const isUnread = status === 'pending';
            const typeLabel = f.type ? f.type.charAt(0).toUpperCase() + f.type.slice(1) : 'General';
            const ratingStars = f.rating ? '★'.repeat(f.rating) + '☆'.repeat(5-f.rating) : '';
            
            return `
                <div class="admin-feedback-row ${isUnread ? 'unread' : ''}">
                    <div class="feedback-row-header">
                        <div class="feedback-row-title">${this.escapeHtml(f.title)}</div>
                        ${isUnread ? '<span class="feedback-row-badge">NEW</span>' : ''}
                    </div>
                    <div class="feedback-row-meta">
                        <span class="feedback-row-type">${typeLabel}</span>
                        <span>${this.escapeHtml(user)}</span>
                        <span>${time}</span>
                        ${ratingStars ? `<span class="feedback-row-rating">${ratingStars}</span>` : ''}
                    </div>
                    <div style="color:#555; font-size:0.9rem; margin-bottom:8px;">${this.escapeHtml((f.message || '').slice(0,150))}${(f.message && f.message.length>150)?'...':''}</div>
                    <div class="feedback-row-actions">
                        <button class="btn-view btn-view-feedback" data-id="${f._id}">View</button>
                        <select class="btn-status feedback-status-select" data-id="${f._id}">
                            <option value="pending" ${status === 'pending' ? 'selected' : ''}>Pending</option>
                            <option value="reviewed" ${status === 'reviewed' ? 'selected' : ''}>Reviewed</option>
                            <option value="resolved" ${status === 'resolved' ? 'selected' : ''}>Resolved</option>
                            <option value="rejected" ${status === 'rejected' ? 'selected' : ''}>Rejected</option>
                        </select>
                    </div>
                </div>
            `;
        }).join('');

        listEl.innerHTML = rows;

        // attach handlers
        listEl.querySelectorAll('.btn-view-feedback').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                this.viewFeedbackDetail(id);
            });
        });

        listEl.querySelectorAll('.feedback-status-select').forEach(select => {
            select.addEventListener('change', (e) => {
                const id = e.currentTarget.dataset.id;
                const newStatus = e.currentTarget.value;
                this.updateFeedbackStatus(id, newStatus);
            });
        });
    }

    // Prepend a single feedback item (used for real-time insert)
    prependFeedbackItem(f) {
        const listEl = document.getElementById('admin-feedback-list');
        if (!listEl) return;
        const time = f.createdAt ? new Date(f.createdAt).toLocaleString() : '';
        const status = f.status || 'pending';
        const user = f.user && f.user.username ? f.user.username : (f.senderName || 'Anonymous');
        const isUnread = status === 'pending';
        const typeLabel = f.type ? f.type.charAt(0).toUpperCase() + f.type.slice(1) : 'General';
        const ratingStars = f.rating ? '★'.repeat(f.rating) + '☆'.repeat(5-f.rating) : '';
        
        const html = `
                <div class="admin-feedback-row ${isUnread ? 'unread' : ''}">
                    <div class="feedback-row-header">
                        <div class="feedback-row-title">${this.escapeHtml(f.title)}</div>
                        ${isUnread ? '<span class="feedback-row-badge">NEW</span>' : ''}
                    </div>
                    <div class="feedback-row-meta">
                        <span class="feedback-row-type">${typeLabel}</span>
                        <span>${this.escapeHtml(user)}</span>
                        <span>${time}</span>
                        ${ratingStars ? `<span class="feedback-row-rating">${ratingStars}</span>` : ''}
                    </div>
                    <div style="color:#555; font-size:0.9rem; margin-bottom:8px;">${this.escapeHtml((f.message || '').slice(0,150))}${(f.message && f.message.length>150)?'...':''}</div>
                    <div class="feedback-row-actions">
                        <button class="btn-view btn-view-feedback" data-id="${f._id}">View</button>
                        <select class="btn-status feedback-status-select" data-id="${f._id}">
                            <option value="pending" ${status === 'pending' ? 'selected' : ''}>Pending</option>
                            <option value="reviewed" ${status === 'reviewed' ? 'selected' : ''}>Reviewed</option>
                            <option value="resolved" ${status === 'resolved' ? 'selected' : ''}>Resolved</option>
                            <option value="rejected" ${status === 'rejected' ? 'selected' : ''}>Rejected</option>
                        </select>
                    </div>
                </div>
        `;

        listEl.insertAdjacentHTML('afterbegin', html);

        // attach handlers for the new top item
        const firstView = listEl.querySelector('.btn-view-feedback');
        if (firstView) firstView.addEventListener('click', (e) => this.viewFeedbackDetail(e.currentTarget.dataset.id));
        const firstSelect = listEl.querySelector('.feedback-status-select');
        if (firstSelect) firstSelect.addEventListener('change', (e) => this.updateFeedbackStatus(e.currentTarget.dataset.id, e.currentTarget.value));
    }

    updateFeedbackBadge(count) {
        const badge = document.getElementById('admin-feedback-badge');
        if (!badge) return;
        if (!count || count <= 0) {
            badge.style.display = 'none';
        } else {
            badge.textContent = String(count);
            badge.style.display = 'inline-block';
        }
    }

    async viewFeedbackDetail(id) {
        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage('Not authenticated', 'error');

        try {
            const res = await fetch(`${this.apiBase}/feedback/${id}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to fetch feedback');

            const f = data;
            const modal = document.getElementById('admin-feedback-detail-modal');
            const contentEl = document.getElementById('feedback-detail-content');
            
            if (!modal || !contentEl) return;

            // Mark as read if pending
            if (f.status === 'pending') {
                await this.markFeedbackAsRead(id);
            }

            const userInitial = f.user?.username ? f.user.username.charAt(0).toUpperCase() : (f.senderName ? f.senderName.charAt(0).toUpperCase() : '?');
            const userName = f.user?.username || f.senderName || 'Anonymous';
            const userEmail = f.user?.email || f.senderEmail || 'N/A';
            const typeLabel = f.type ? f.type.charAt(0).toUpperCase() + f.type.slice(1) : 'General';
            const ratingStars = f.rating ? '★'.repeat(f.rating) + '☆'.repeat(5-f.rating) : 'No rating';
            const relatedPOI = f.relatedPOI ? f.relatedPOI.name : 'None';
            const statusClass = `feedback-detail-status ${f.status}`;
            const submittedTime = f.createdAt ? new Date(f.createdAt).toLocaleString() : 'Unknown';

            let html = `
                <div class="feedback-detail-section">
                    <div class="feedback-detail-label">Title</div>
                    <div class="feedback-detail-value">${this.escapeHtml(f.title)}</div>
                </div>

                <div class="feedback-detail-section">
                    <div class="feedback-detail-label">Type & Rating</div>
                    <div class="feedback-detail-value">
                        <span class="feedback-row-type">${typeLabel}</span>
                        <span class="feedback-row-rating" style="margin-left:12px;">${ratingStars}</span>
                    </div>
                </div>

                <div class="feedback-detail-section">
                    <div class="feedback-detail-label">From</div>
                    <div class="feedback-detail-user">
                        <div class="feedback-detail-user-avatar">${userInitial}</div>
                        <div>
                            <div style="font-weight:600;">${this.escapeHtml(userName)}</div>
                            <div style="font-size:0.9rem; color:#666;">${this.escapeHtml(userEmail)}</div>
                        </div>
                    </div>
                </div>

                <div class="feedback-detail-section">
                    <div class="feedback-detail-label">Submitted</div>
                    <div class="feedback-detail-value">${submittedTime}</div>
                </div>

                <div class="feedback-detail-section">
                    <div class="feedback-detail-label">Status</div>
                    <div class="feedback-detail-value">
                        <span class="${statusClass}">${f.status.charAt(0).toUpperCase() + f.status.slice(1)}</span>
                    </div>
                </div>

                <div class="feedback-detail-section">
                    <div class="feedback-detail-label">Related POI</div>
                    <div class="feedback-detail-value">${this.escapeHtml(relatedPOI)}</div>
                </div>

                <div class="feedback-detail-section">
                    <div class="feedback-detail-label">Message</div>
                    <div class="feedback-detail-value" style="white-space:pre-wrap; background:#f9f9f9; padding:10px; border-radius:4px; border-left:4px solid #1a5f7a;">
                        ${this.escapeHtml(f.message)}
                    </div>
                </div>
            `;

            // Add existing response if available
            if (f.adminResponse && f.adminResponse.message) {
                const respondedTime = f.adminResponse.respondedAt ? new Date(f.adminResponse.respondedAt).toLocaleString() : 'Unknown';
                const respondedBy = f.adminResponse.respondedBy?.username || 'Admin';
                html += `
                    <div class="feedback-detail-section">
                        <div class="feedback-detail-label">Admin Response</div>
                        <div class="feedback-existing-response">
                            <div class="feedback-existing-response-header">Response from ${this.escapeHtml(respondedBy)}</div>
                            <div class="feedback-existing-response-text">${this.escapeHtml(f.adminResponse.message)}</div>
                            <div class="feedback-existing-response-meta">Responded: ${respondedTime}</div>
                        </div>
                    </div>
                `;
            }

            // Add response form
            html += `
                <div class="feedback-detail-section">
                    <div class="feedback-detail-label">Add Response</div>
                    <div class="feedback-response-section">
                        <textarea id="feedback-response-text" class="feedback-response-textarea" placeholder="Write your response to the user..."></textarea>
                        <div class="feedback-response-buttons">
                            <button class="btn-cancel" id="feedback-response-cancel">Cancel</button>
                            <button class="btn-submit" id="feedback-response-submit">Submit Response</button>
                        </div>
                    </div>
                </div>
            `;

            contentEl.innerHTML = html;

            // Wire up event handlers
            document.getElementById('close-feedback-detail-modal').onclick = () => {
                modal.style.display = 'none';
            };

            document.getElementById('feedback-response-cancel').onclick = () => {
                modal.style.display = 'none';
            };

            document.getElementById('feedback-response-submit').onclick = async () => {
                const responseText = document.getElementById('feedback-response-text').value.trim();
                if (!responseText) {
                    this.showMessage('Please enter a response', 'error');
                    return;
                }
                await this.submitFeedbackResponse(id, responseText);
                modal.style.display = 'none';
            };

            modal.style.display = 'block';
        } catch (err) {
            this.showMessage(err.message, 'error');
        }
    }

    async markFeedbackAsRead(id) {
        const token = localStorage.getItem('authToken');
        if (!token) return;

        try {
            const res = await fetch(`${this.apiBase}/feedback/${id}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ status: 'reviewed' })
            });
            
            if (res.ok) {
                // Decrement badge count
                const badge = document.getElementById('admin-feedback-badge');
                if (badge && badge.style.display !== 'none') {
                    let count = parseInt(badge.textContent || '0') || 0;
                    count = Math.max(0, count - 1);
                    if (count <= 0) {
                        badge.style.display = 'none';
                    } else {
                        badge.textContent = String(count);
                    }
                }
            }
        } catch (err) {
            console.warn('Failed to mark feedback as read:', err);
        }
    }

    async patchFeedbackStatus(id, status, response) {
        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage('Not authenticated', 'error');

        try {
            const res = await fetch(`${this.apiBase}/feedback/${id}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ status, response })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to update feedback');
            this.showMessage('Feedback updated', 'success');
            this.loadAdminFeedback();
        } catch (err) {
            this.showMessage(err.message, 'error');
        }
    }

    async updateFeedbackStatus(id, newStatus) {
        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage('Not authenticated', 'error');

        try {
            const res = await fetch(`${this.apiBase}/feedback/${id}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ status: newStatus })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to update feedback');
            this.showMessage(`Feedback status updated to ${newStatus}`, 'success');
            // Reload to reflect changes
            this.loadAdminFeedback();
        } catch (err) {
            this.showMessage(err.message, 'error');
        }
    }

    async promptRespondFeedback(id) {
        const response = prompt('Enter response message to the user (leave empty to cancel)');
        if (!response) return this.showMessage('Response cancelled', 'info');

        const newStatus = prompt("Set status for this feedback (e.g. 'reviewed', 'resolved')", 'reviewed');
        if (!newStatus) return this.showMessage('Status change cancelled', 'info');

        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage('Not authenticated', 'error');

        try {
            const res = await fetch(`${this.apiBase}/feedback/${id}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ status: newStatus, response })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to update feedback');
            this.showMessage('Feedback updated', 'success');
            this.loadAdminFeedback();
        } catch (err) {
            this.showMessage(err.message, 'error');
        }
    }

    async submitFeedbackResponse(id, responseMessage) {
        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage('Not authenticated', 'error');

        try {
            const res = await fetch(`${this.apiBase}/feedback/${id}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ 
                    status: 'resolved',
                    response: responseMessage
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to submit response');
            this.showMessage('Response submitted successfully', 'success');
            this.loadAdminFeedback();
        } catch (err) {
            this.showMessage(err.message, 'error');
        }
    }

    // Users UI removed; render and action handlers cleared to avoid referencing removed elements.

    // Broadcast functions removed (UI removed)

    // Admin demo notify: create a quick broadcast via admin endpoint
    async handleAdminDemoNotify() {
        try {
            const title = prompt(this.t('admin.prompt_notification_title', 'Notification title'), this.t('admin.demo_title', 'Site Maintenance'));
            if (!title) return this.showMessage(this.t('messages_extra.demo_cancelled', 'Demo cancelled'), 'info');
            const message = prompt(this.t('admin.prompt_notification_message', 'Notification message'), this.t('admin.demo_message', 'This is a demo notification from admin.'));
            if (!message) return this.showMessage(this.t('messages_extra.demo_cancelled', 'Demo cancelled'), 'info');

            const token = localStorage.getItem('authToken');
            if (!token) return this.showMessage('Not authenticated as admin', 'error');

            const res = await fetch(`${this.apiBase}/admin/demo-notify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ title, message })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.message || 'Failed to send demo notification');

            this.showMessage(data.message || 'Demo notification sent', 'success');
        } catch (err) {
            this.showMessage(err.message, 'error');
        }
    }

    // --- Admin broadcasts and users helpers ---
    async loadAdminBroadcasts() {
        const token = localStorage.getItem('authToken');
        const listEl = document.getElementById('admin-broadcasts-list');
        if (!listEl) return;
        listEl.innerHTML = 'Loading broadcasts...';
        if (!token) {
            listEl.innerHTML = this.t('errors_extra.not_authenticated', 'Not authenticated');
            return;
        }
        try {
            const res = await fetch(`${this.apiBase}/notifications/admin/broadcasts`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!res.ok) throw new Error('Failed loading broadcasts');
            const data = await res.json();
            const items = Array.isArray(data) ? data : (data.broadcasts || []);
            if (!items.length) {
                listEl.innerHTML = '<div style="color:#666">No broadcasts</div>';
                return;
            }
            listEl.innerHTML = items.map(b => `
                <div class="broadcast-item" style="padding:8px; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <div style="font-weight:600">${this.escapeHtml(b.title || '')}</div>
                        <div style="font-size:0.9rem;color:#666">${new Date(b.createdAt || b.created || Date.now()).toLocaleString()}</div>
                    </div>
                    <div>
                        <button class="btn btn-sm btn-outline btn-edit-broadcast" data-id="${b._id || b.id}">Edit</button>
                    </div>
                </div>
            `).join('');
            // attach edit handlers
            listEl.querySelectorAll('.btn-edit-broadcast').forEach(btn => btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                this.openEditBroadcast(id);
            }));
        } catch (e) {
            listEl.innerHTML = `<div class="error-message">${e.message}</div>`;
        }
    }

    openBroadcastModal() {
        const modal = document.getElementById('admin-broadcast-modal');
        if (!modal) return;
        const tt = document.getElementById('broadcast-title'); if (tt) tt.value = '';
        const mm = document.getElementById('broadcast-message'); if (mm) mm.value = '';
        modal.style.display = 'block';
    }

    closeBroadcastModal() {
        const modal = document.getElementById('admin-broadcast-modal');
        if (!modal) return;
        modal.style.display = 'none';
    }

    async handleSendBroadcast() {
        const titleEl = document.getElementById('broadcast-title');
        const messageEl = document.getElementById('broadcast-message');
        if (!titleEl || !messageEl) return this.showMessage('Broadcast form not found', 'error');
        const title = titleEl.value.trim();
        const message = messageEl.value.trim();
        const expiresHours = parseInt((document.getElementById('broadcast-expires-hours') || {}).value || '24', 10) || 24;
        if (!title || !message) return this.showMessage(this.t('feedback.title_label', 'Please provide both title and message'), 'error');

        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage(this.t('errors_extra.not_authenticated', 'Not authenticated'), 'error');

        try {
            const res = await fetch(`${this.apiBase}/notifications`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ title, message, type: 'broadcast', priority: 'high', expiresHours })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.message || 'Failed to send broadcast');
            this.showMessage(data.message || this.t('admin.broadcast', 'Broadcast sent'), 'success');
            this.closeBroadcastModal();
            try { await this.loadAdminBroadcasts(); } catch (e) {}
        } catch (err) {
            this.showMessage(err.message || 'Broadcast failed', 'error');
        }
    }

    async openEditBroadcast(id) {
        if (!id) return;
        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage(this.t('errors_extra.not_authenticated', 'Not authenticated'), 'error');
        try {
            const res = await fetch(`${this.apiBase}/notifications/admin/broadcasts/${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!res.ok) throw new Error('Failed to load broadcast');
            const data = await res.json();
            const modal = document.getElementById('admin-broadcast-edit-modal');
            if (!modal) return;
            document.getElementById('edit-broadcast-id').value = data._id || data.id || id;
            document.getElementById('edit-broadcast-title').value = data.title || '';
            document.getElementById('edit-broadcast-message').value = data.message || '';
            document.getElementById('edit-broadcast-expires-hours').value = data.expiresHours || 24;
            modal.style.display = 'block';
        } catch (e) { this.showMessage(e.message, 'error'); }
    }

    async updateBroadcast() {
        const id = document.getElementById('edit-broadcast-id').value;
        const title = document.getElementById('edit-broadcast-title').value.trim();
        const message = document.getElementById('edit-broadcast-message').value.trim();
        const expiresHours = parseInt((document.getElementById('edit-broadcast-expires-hours') || {}).value || '24', 10) || 24;
        if (!id) return this.showMessage('Broadcast id missing', 'error');
        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage(this.t('errors_extra.not_authenticated', 'Not authenticated'), 'error');
        try {
            const res = await fetch(`${this.apiBase}/notifications/admin/broadcasts/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ title, message, expiresHours })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to update broadcast');
            this.showMessage('Broadcast updated', 'success');
            document.getElementById('admin-broadcast-edit-modal').style.display = 'none';
            try { await this.loadAdminBroadcasts(); } catch (e) {}
        } catch (e) { this.showMessage(e.message, 'error'); }
    }

    async deleteBroadcast() {
        const id = document.getElementById('edit-broadcast-id').value;
        if (!id) return this.showMessage('Broadcast id missing', 'error');
        if (!confirm('Delete this broadcast?')) return;
        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage(this.t('errors_extra.not_authenticated', 'Not authenticated'), 'error');
        try {
            const res = await fetch(`${this.apiBase}/notifications/admin/broadcasts/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to delete broadcast');
            this.showMessage('Broadcast deleted', 'success');
            document.getElementById('admin-broadcast-edit-modal').style.display = 'none';
            try { await this.loadAdminBroadcasts(); } catch (e) {}
        } catch (e) { this.showMessage(e.message, 'error'); }
    }

    // --- Notification Management Methods ---

    async loadNotificationList() {
        const token = localStorage.getItem('authToken');
        const listEl = document.getElementById('admin-notification-list');
        if (!listEl) return;
        listEl.innerHTML = '<div style="text-align:center; color:#999; padding:20px;">Loading notifications...</div>';
        if (!token) {
            listEl.innerHTML = '<div style="color:#e74c3c; padding:20px;">Not authenticated</div>';
            return;
        }
        try {
            const res = await fetch(`${this.apiBase}/notifications/admin/broadcasts`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!res.ok) throw new Error('Failed to load notifications');
            const data = await res.json();
            const items = Array.isArray(data) ? data : (data.items || []);
            if (!items.length) {
                listEl.innerHTML = '<div style="color:#999; padding:20px; text-align:center;">No notifications sent yet</div>';
                return;
            }
            listEl.innerHTML = items.map(notif => {
                const createdDate = new Date(notif.createdAt || Date.now());
                const dateStr = createdDate.toLocaleString();
                const preview = (notif.message || '').substring(0, 80) + (notif.message && notif.message.length > 80 ? '...' : '');
                return `
                    <div class="notification-item" data-id="${notif._id || notif.id}" style="padding:12px; border-bottom:1px solid #eee; cursor:pointer; transition:background 0.2s;">
                        <div class="notification-item-title" style="font-weight:600; color:#1a5f7a; margin-bottom:4px;">${this.escapeHtml(notif.title || '')}</div>
                        <div class="notification-item-preview" style="font-size:0.9rem; color:#666; margin-bottom:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(preview)}</div>
                        <div class="notification-item-meta" style="font-size:0.85rem; color:#999; display:flex; justify-content:space-between;">
                            <span>${dateStr}</span>
                            <span>Priority: ${notif.priority || 'low'}</span>
                        </div>
                    </div>
                `;
            }).join('');
            // Attach click handlers to edit notifications
            listEl.querySelectorAll('.notification-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    const id = e.currentTarget.dataset.id;
                    this.openEditNotificationModal(id);
                });
            });
        } catch (e) {
            listEl.innerHTML = `<div style="color:#e74c3c; padding:20px;">${this.escapeHtml(e.message)}</div>`;
        }
    }

    openNotificationListModal() {
        const modal = document.getElementById('admin-notification-list-modal');
        if (!modal) return;
        modal.style.display = 'block';
        this.loadNotificationList();
    }

    closeNotificationListModal() {
        const modal = document.getElementById('admin-notification-list-modal');
        if (!modal) return;
        modal.style.display = 'none';
    }

    openEditNotificationModal(id) {
        const modal = document.getElementById('admin-edit-notification-modal');
        if (!modal) return;
        const idInput = document.getElementById('edit-notification-id');
        if (idInput) idInput.value = id;
        modal.style.display = 'block';
        this.loadNotificationDetails(id);
    }

    closeEditNotificationModal() {
        const modal = document.getElementById('admin-edit-notification-modal');
        if (!modal) return;
        modal.style.display = 'none';
    }

    async loadNotificationDetails(id) {
        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage('Not authenticated', 'error');
        try {
            const res = await fetch(`${this.apiBase}/notifications/admin/broadcasts/${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!res.ok) throw new Error('Failed to load notification');
            const notif = await res.json();
            document.getElementById('edit-notification-title').value = notif.title || '';
            document.getElementById('edit-notification-content').value = notif.message || '';
            document.getElementById('edit-notification-status').checked = notif.active !== false;
            this.updateCharacterCount('edit-notification-title');
            this.updateCharacterCount('edit-notification-content');
        } catch (e) {
            this.showMessage(e.message, 'error');
        }
    }

    openNewNotificationModal() {
        const modal = document.getElementById('admin-new-notification-modal');
        if (!modal) return;
        document.getElementById('new-notification-title').value = '';
        document.getElementById('new-notification-content').value = '';
        document.getElementById('new-notification-priority').value = 'medium';
        this.updateCharacterCount('new-notification-title');
        this.updateCharacterCount('new-notification-content');
        modal.style.display = 'block';
    }

    closeNewNotificationModal() {
        const modal = document.getElementById('admin-new-notification-modal');
        if (!modal) return;
        modal.style.display = 'none';
    }

    updateCharacterCount(elementId) {
        const el = document.getElementById(elementId);
        const countEl = document.getElementById(elementId + '-count');
        if (!el || !countEl) return;
        const count = el.value.length;
        const max = parseInt(el.maxLength) || 200;
        countEl.textContent = count;
        if (count > max * 0.9) {
            countEl.parentElement.classList.add('warning');
        } else {
            countEl.parentElement.classList.remove('warning');
        }
    }

    async saveEditNotification() {
        const id = document.getElementById('edit-notification-id').value;
        const title = document.getElementById('edit-notification-title').value.trim();
        const content = document.getElementById('edit-notification-content').value.trim();
        const active = document.getElementById('edit-notification-status').checked;

        if (!id) return this.showMessage('Notification ID missing', 'error');
        if (!title) return this.showMessage('Title cannot be empty', 'error');
        if (!content) return this.showMessage('Content cannot be empty', 'error');
        if (title.length > 200) return this.showMessage('Title exceeds 200 characters', 'error');
        if (content.length > 2000) return this.showMessage('Content exceeds 2000 characters', 'error');

        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage('Not authenticated', 'error');

        try {
            const res = await fetch(`${this.apiBase}/notifications/admin/broadcasts/${id}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    title,
                    message: content,
                    active
                })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to update notification');

            this.showMessage('Notification updated successfully', 'success');
            this.closeEditNotificationModal();
            this.loadNotificationList();
        } catch (e) {
            this.showMessage(e.message, 'error');
        }
    }

    async deleteEditNotification() {
        const id = document.getElementById('edit-notification-id').value;
        if (!id) return this.showMessage('Notification ID missing', 'error');
        if (!confirm('Are you sure you want to delete this notification?')) return;

        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage('Not authenticated', 'error');

        try {
            const res = await fetch(`${this.apiBase}/notifications/admin/broadcasts/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to delete notification');

            this.showMessage('Notification deleted successfully', 'success');
            this.closeEditNotificationModal();
            this.loadNotificationList();
        } catch (e) {
            this.showMessage(e.message, 'error');
        }
    }

    async sendNewNotification() {
        const title = document.getElementById('new-notification-title').value.trim();
        const content = document.getElementById('new-notification-content').value.trim();
        const priority = document.getElementById('new-notification-priority').value;

        if (!title) return this.showMessage('Title cannot be empty', 'error');
        if (!content) return this.showMessage('Content cannot be empty', 'error');
        if (title.length > 200) return this.showMessage('Title exceeds 200 characters', 'error');
        if (content.length > 2000) return this.showMessage('Content exceeds 2000 characters', 'error');

        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage('Not authenticated', 'error');

        try {
            const res = await fetch(`${this.apiBase}/notifications/send`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    title,
                    message: content,
                    priority,
                    type: 'broadcast',
                    duration: 86400 // 24 hours in seconds
                })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to send notification');

            this.showMessage('Notification sent to all users successfully', 'success');
            this.closeNewNotificationModal();
            this.loadNotificationList();
        } catch (e) {
            this.showMessage(e.message, 'error');
        }
    }

    renderAdminUsers(users) {
        const usersListEl = document.getElementById('admin-users-list');
        if (!usersListEl) return;
        if (!users || users.length === 0) {
            usersListEl.innerHTML = '<div>No users found</div>';
            return;
        }

        const rows = users.map(u => {
            const created = u.createdAt ? new Date(u.createdAt).toLocaleString() : '';
            return `
                <div class="admin-user-row" style="padding:8px; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <div style="font-weight:600">${this.escapeHtml(u.username || '')} <span style="font-weight:400;color:#666">(${this.escapeHtml(u.role || '')})</span></div>
                        <div style="font-size:0.9rem;color:#666">${this.escapeHtml(u.email || '')} • ${created}</div>
                    </div>
                    <div>
                        <button class="btn btn-secondary btn-change-role" data-userid="${u._id}" data-role="${u.role}" style="margin-right:6px;">Change Role</button>
                        <button class="btn btn-primary btn-send-notif" data-userid="${u._id}">Notify</button>
                    </div>
                </div>
            `;
        }).join('');

        usersListEl.innerHTML = rows;

        // Attach handlers for change-role and send-notif buttons
        usersListEl.querySelectorAll('.btn-change-role').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const userId = e.currentTarget.dataset.userid;
                const currentRole = e.currentTarget.dataset.role;
                this.handleChangeUserRole(userId, currentRole);
            });
        });

        usersListEl.querySelectorAll('.btn-send-notif').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const userId = e.currentTarget.dataset.userid;
                this.handleSendNotification(userId);
            });
        });
    }

    async handleChangeUserRole(userId, currentRole) {
        const newRole = prompt(this.t('admin.prompt_role', `Change role for user to 'admin' or 'user' (current: ${currentRole})`).replace('{role}', currentRole), currentRole);
        if (!newRole || (newRole !== 'admin' && newRole !== 'user')) {
            this.showMessage(this.t('messages_extra.role_change_cancelled', 'Role change cancelled or invalid role'), 'info');
            return;
        }
        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage(this.t('errors_extra.not_authenticated', 'Not authenticated'), 'error');

        try {
            const res = await fetch(`${this.apiBase}/auth/users/${userId}/role`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ role: newRole })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to update role');
            this.showMessage('User role updated', 'success');
            this.loadAdminUsers();
        } catch (err) {
            this.showMessage(err.message, 'error');
        }
    }

    async handleSendNotification(userId) {
        const title = prompt(this.t('admin.prompt_notification_title', 'Notification title'));
        if (!title) return this.showMessage(this.t('messages_extra.notification_cancelled', 'Notification cancelled'), 'info');
        const message = prompt(this.t('admin.prompt_notification_message', 'Notification message'));
        if (!message) return this.showMessage(this.t('messages_extra.notification_cancelled', 'Notification cancelled'), 'info');

        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage(this.t('errors_extra.not_authenticated', 'Not authenticated'), 'error');

        try {
            const res = await fetch(`${this.apiBase}/notifications`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ userId, title, message, type: 'system', priority: 'low' })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to send notification');
            this.showMessage('Notification sent', 'success');
        } catch (err) {
            this.showMessage(err.message, 'error');
        }
    }

    // Update Map Data (Add POI)
    openUpdateMapModal() {
        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage(this.t('errors_extra.not_authenticated', 'Not authenticated'), 'error');
        const modal = document.getElementById('admin-update-map-modal');
        if (!modal) return this.showMessage(this.t('errors_extra.update_map_modal_not_found', 'Update map modal not found'), 'error');
        // clear fields
        ['poi-id','poi-name','poi-lat','poi-lng','poi-category','poi-description'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        modal.style.display = 'block';

        // Inform admin they can click on the map to pick coordinates
        try {
            this.showMessage('Click the map to pick POI coordinates (click again to move)', 'info');
        } catch (e) {}

        // Install a temporary map click handler so admin can select lat/lng by clicking map
        try {
            if (this.map) {
                // remove any existing temporary handler
                try { if (this._adminMapClickHandler) this.map.off('click', this._adminMapClickHandler); } catch (e) {}
                this._adminMapTempMarker = null;
                this._adminMapClickHandler = (ev) => {
                    try {
                        const lat = ev.latlng.lat; const lng = ev.latlng.lng;
                        const latEl = document.getElementById('poi-lat');
                        const lngEl = document.getElementById('poi-lng');
                        if (latEl) latEl.value = lat.toFixed(6);
                        if (lngEl) lngEl.value = lng.toFixed(6);
                        // place or move temporary marker
                        try {
                            if (this._adminMapTempMarker) this.map.removeLayer(this._adminMapTempMarker);
                        } catch (e) {}
                        this._adminMapTempMarker = L.marker([lat, lng], { title: 'New POI location (temporary)' }).addTo(this.map);
                    } catch (inner) { console.warn('admin map click handler error', inner); }
                };
                this.map.on('click', this._adminMapClickHandler);
            }
        } catch (e) { console.warn('Failed to attach admin map click handler', e); }
    }

    closeUpdateMapModal() {
        const modal = document.getElementById('admin-update-map-modal');
        if (modal) modal.style.display = 'none';
        // remove temporary map click handler and marker
        try {
            if (this.map && this._adminMapClickHandler) {
                this.map.off('click', this._adminMapClickHandler);
                this._adminMapClickHandler = null;
            }
            if (this._adminMapTempMarker) {
                try { this.map.removeLayer(this._adminMapTempMarker); } catch (e) {}
                this._adminMapTempMarker = null;
            }
        } catch (e) { console.warn('Failed to cleanup admin update map temporary UI', e); }
    }

    // Change password modal helpers
    openChangePasswordModal() {
        const modal = document.getElementById('admin-change-password-modal');
        if (!modal) return this.showMessage('Change password modal not found', 'error');
        document.getElementById('current-password').value = '';
        document.getElementById('new-password').value = '';
        document.getElementById('confirm-password').value = '';
        document.getElementById('change-password-status').innerHTML = '';
        modal.style.display = 'block';
    }

    closeChangePasswordModal() {
        const modal = document.getElementById('admin-change-password-modal');
        if (!modal) return;
        modal.style.display = 'none';
    }

    async handleChangePasswordSubmit() {
        const cur = (document.getElementById('current-password') || {}).value || '';
        const neu = (document.getElementById('new-password') || {}).value || '';
        const conf = (document.getElementById('confirm-password') || {}).value || '';
        const statusEl = document.getElementById('change-password-status');

        if (!cur || !neu) {
            if (statusEl) statusEl.innerHTML = '<div class="error-message">Please provide current and new password</div>';
            return;
        }
        if (neu !== conf) {
            if (statusEl) statusEl.innerHTML = '<div class="error-message">New password and confirmation do not match</div>';
            return;
        }

        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage(this.t('errors_extra.not_authenticated','Not authenticated'), 'error');

        try {
            const res = await fetch(`${this.apiBase}/auth/change-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ currentPassword: cur, newPassword: neu })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.message || 'Failed to change password');
            if (statusEl) statusEl.innerHTML = '<div class="success-message">Password changed successfully</div>';
            setTimeout(() => this.closeChangePasswordModal(), 1200);
        } catch (err) {
            if (statusEl) statusEl.innerHTML = `<div class="error-message">${err.message}</div>`;
        }
    }

    async handleSubmitMapUpdate() {
        const id = (document.getElementById('poi-id') || {}).value?.trim();
        const name = (document.getElementById('poi-name') || {}).value?.trim();
        const lat = parseFloat((document.getElementById('poi-lat') || {}).value);
        const lng = parseFloat((document.getElementById('poi-lng') || {}).value);
        const category = (document.getElementById('poi-category') || {}).value;
        const description = (document.getElementById('poi-description') || {}).value?.trim();

        if (!id || !name || Number.isNaN(lat) || Number.isNaN(lng)) {
            return this.showMessage(this.t('errors_extra.invalid_poi_fields', 'Please provide valid id, name, latitude and longitude'), 'error');
        }

        const token = localStorage.getItem('authToken');
        if (!token) return this.showMessage('Not authenticated', 'error');

        // Map frontend category keys to backend enum values (lowercase)
        const categoryMap = {
            'administrative': 'administrative',
            'academic': 'academic',
            'services': 'services',
            'recreational': 'recreational'
        };

        // Collect translations from admin inputs (if provided)
        const nameAm = (document.getElementById('poi-name-am') || {}).value?.trim();
        const nameTi = (document.getElementById('poi-name-ti') || {}).value?.trim();
        const nameOm = (document.getElementById('poi-name-om') || {}).value?.trim();

        const translations = {};
        if (nameAm) translations.am = { name: nameAm };
        if (nameTi) translations.ti = { name: nameTi };
        if (nameOm) translations.om = { name: nameOm };

        const payload = {
            // backend expects name, description, building, category, latitude, longitude
            id: id,
            name,
            description: description || name,
            building: name,
            category: categoryMap[category] || category,
            latitude: lat,
            longitude: lng,
            floor: 'Ground Floor',
            opening_hours: 'Unknown',
            tags: [],
            details: {
                type: category || 'Unknown',
                departments: [],
                facilities: [],
                contact: 'Contact information not provided'
            }
        };
        if (Object.keys(translations).length) payload.translations = translations;

        try {
            // Try to POST to backend first
            const res = await fetch(`${this.apiBase}/pois`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                const data = await res.json();
                this.showMessage('POI successfully added to server', 'success');
                // Fetch updated POIs from backend
                try {
                    await this.fetchPOIsFromBackend();
                    console.log('POIs refreshed from backend');
                } catch (err) {
                    console.warn('Could not fetch from backend, using local addition:', err);
                    if (data && data.poi) {
                        this.pois.push(data.poi);
                    } else {
                        this.pois.push(payload);
                    }
                }
                this.loadPOIs();
                this.populateDatalists();
                this.closeUpdateMapModal();
                return;
            }

            // If server returns non-ok, fall back to client-side addition
            const errBody = await res.text();
            console.warn('Server add POI responded non-ok:', errBody);
            this.showMessage('Server rejected POI — adding locally as fallback', 'info');
            this.pois.push(payload);
            console.log('POI added (fallback):', payload);
            console.log('Total POIs now:', this.pois.length);
            this.loadPOIs();
            this.populateDatalists();
            this.closeUpdateMapModal();
        } catch (err) {
            // Fallback to client-side update
            console.warn('Failed to add POI to server:', err);
            this.showMessage('Failed to reach server — POI added locally', 'info');
            this.pois.push(payload);
            console.log('POI added (error fallback):', payload);
            console.log('Total POIs now:', this.pois.length);
            this.loadPOIs();
            this.populateDatalists();
            this.closeUpdateMapModal();
        }
    }

    // Admins cannot create user accounts via the frontend UI per requirements.

    handleLogout() {
        this.currentUser = null;
        localStorage.removeItem('authToken');
        localStorage.removeItem('currentUser');
        this.updateUserInterface();
        this.showMessage('Logged out successfully', 'success');
    }

    showLoginPanel() {
        document.getElementById('login-panel').classList.add('active');
        this.switchLoginTab('login');
    }

    showRegisterPanel() {
        document.getElementById('login-panel').classList.add('active');
        this.switchLoginTab('register');
    }

    hideLoginPanel() {
        document.getElementById('login-panel').classList.remove('active');
        document.getElementById('login-username').value = '';
        document.getElementById('login-password').value = '';
        document.getElementById('register-username').value = '';
        document.getElementById('register-email').value = '';
        document.getElementById('register-password').value = '';
        document.getElementById('login-message').innerHTML = '';
    }

    switchLoginTab(tab) {
        document.querySelectorAll('.login-tab').forEach(t => {
            t.classList.remove('active');
        });
        document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

        document.querySelectorAll('.login-form').forEach(form => {
            form.classList.remove('active');
        });
        document.getElementById(`${tab}-form`).classList.add('active');

        document.getElementById('login-message').innerHTML = '';
    }

    saveCurrentRoute() {
        if (!this.currentRoute) {
            this.showError('No route to save');
            return;
        }
        // Only admin can save routes (or disable this feature for all)
        if (!this.currentUser || this.currentUser.role !== 'admin') {
            this.showMessage('Only admin can save routes.', 'info');
            return;
        }
        this.showMessage('Route saved to your history!', 'success');
    }

    showFeedbackPanel() {
        // Use the same modal as footer feedback
        this.openUserFeedbackModal();
    }

    showAboutInfo() {
        // Create about modal
        const modal = document.createElement('div');
        modal.id = 'about-modal-overlay';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;

        const content = document.createElement('div');
        content.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 24px;
            max-width: 600px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
        `;

        content.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h2 style="margin: 0; color: #1a5f7a;"><i class="fas fa-info-circle"></i> About DTU Navigation</h2>
                <button id="close-about-modal" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #999;">&times;</button>
            </div>

            <div style="line-height: 1.8; color: #333;">
                <h3 style="color: #1a5f7a; margin-top: 16px;">DTU Campus Navigation System v1.0</h3>
                <p>A comprehensive campus navigation solution developed for Debre Tabor University to help students, staff, and visitors navigate the campus efficiently.</p>

                <h3 style="color: #1a5f7a; margin-top: 16px;">Key Features</h3>
                <ul style="margin: 8px 0; padding-left: 20px;">
                    <li><strong>Interactive Campus Map</strong> - Explore all campus buildings and points of interest</li>
                    <li><strong>Real-time Routing</strong> - Get turn-by-turn directions between any two locations</li>
                    <li><strong>Live Navigation</strong> - AR-powered guidance with real-time positioning</li>
                    <li><strong>Multi-language Support</strong> - Available in English, Amharic, Tigrigna, and Afaan Oromo</li>
                    <li><strong>Building Details</strong> - Comprehensive information about campus facilities</li>
                    <li><strong>User Feedback</strong> - Help us improve by sharing your feedback</li>
                </ul>

                <h3 style="color: #1a5f7a; margin-top: 16px;">Technology</h3>
                <p>Built with modern web technologies including Leaflet for mapping, Socket.io for real-time updates, and responsive design for all devices.</p>

                <h3 style="color: #1a5f7a; margin-top: 16px;">Contact & Support</h3>
                <p>For technical support or feedback, please use the Feedback button in the navigation menu.</p>

                <h3 style="color: #1a5f7a; margin-top: 16px;">Version Information</h3>
                <p>
                    <strong>Version:</strong> 1.0<br>
                    <strong>Last Updated:</strong> No Update - This is the original<br>
                    <strong>Institution:</strong> Debre Tabor University<br>
                    <strong>© 2025 Debre Tabor University</strong>
                </p>
            </div>

            <div style="display: flex; justify-content: flex-end; margin-top: 20px;">
                <button id="close-about-btn" style="padding: 10px 20px; background: #1a5f7a; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">Close</button>
            </div>
        `;

        modal.appendChild(content);
        document.body.appendChild(modal);

        // Close button
        document.getElementById('close-about-modal').addEventListener('click', () => {
            modal.remove();
        });

        document.getElementById('close-about-btn').addEventListener('click', () => {
            modal.remove();
        });

        // Close on background click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }

    // Utility methods
    showLoading(buttonId) {
        const button = document.getElementById(buttonId);
        const text = button.querySelector('span');
        const loading = button.querySelector('.loading') || document.createElement('div');
        
        loading.className = 'loading';
        loading.style.display = 'inline-block';
        
        if (text) text.style.display = 'none';
        if (!button.querySelector('.loading')) {
            button.appendChild(loading);
        }
        
        button.disabled = true;
    }

    hideLoading(buttonId) {
        const button = document.getElementById(buttonId);
        const text = button.querySelector('span');
        const loading = button.querySelector('.loading');
        
        if (text) text.style.display = 'inline-block';
        if (loading) loading.style.display = 'none';
        
        button.disabled = false;
    }

    showMessage(message, type = 'info', containerId = null) {
        // Allow messages to be i18n keys prefixed with 'i18n:' (e.g. 'i18n:feedback.submit')
        if (typeof message === 'string' && message.startsWith('i18n:')) {
            const key = message.slice(5);
            message = this.t(key, message);
        }

        if (containerId) {
            const container = document.getElementById(containerId);
            container.innerHTML = `
                <div class="${type === 'error' ? 'error-message' : type === 'success' ? 'success-message' : 'info-message'}">
                    <i class="fas fa-${type === 'error' ? 'exclamation-triangle' : type === 'success' ? 'check-circle' : 'info-circle'}"></i>
                    ${message}
                </div>
            `;
        } else {
            this.showToast(message, type);
        }
    }

    showError(message) {
        this.showMessage(message, 'error');
    }

    showToast(message, type = 'info') {
        // Support i18n keyed messages
        if (typeof message === 'string' && message.startsWith('i18n:')) {
            const key = message.slice(5);
            message = this.t(key, message);
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <i class="fas fa-${type === 'error' ? 'exclamation-triangle' : type === 'success' ? 'check-circle' : 'info-circle'}"></i>
            ${message}
        `;

        document.body.appendChild(toast);

        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 5000);
    }

    checkAuthentication() {
        // Only check for admin
        const token = localStorage.getItem('authToken');
        if (token) {
            const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
            if (user && user._id) {
                this.currentUser = user;
                this.updateUserInterface();
                // load persisted notifications for any authenticated user
                this.loadUserNotifications();
                // Join user room for real-time notifications
                try {
                    if (this.socket) {
                        this.socket.emit('join-user', user._id);
                    } else if (window.io) {
                        this.socket = window.io();
                        this.socket.on('connect', () => {
                            try { this.socket.emit('join-user', user._id); } catch (e) {}
                        });
                    }
                } catch (e) { console.warn('Failed to join user room', e); }
            } else {
                this.currentUser = null;
                localStorage.removeItem('authToken');
                localStorage.removeItem('currentUser');
            }
        }
    }

    openBoundsModal() {
        const modal = document.getElementById('admin-bounds-modal');
        if (!modal) return;
        // populate current values
        const north = this.campusGeo?.north || this.campusBounds?.getNorthEast?.()[0] || '';
        const south = this.campusGeo?.south || this.campusBounds?.getSouthWest?.()[0] || '';
        const east = this.campusGeo?.east || this.campusBounds?.getNorthEast?.()[1] || '';
        const west = this.campusGeo?.west || this.campusBounds?.getSouthWest?.()[1] || '';

        const el = (id) => document.getElementById(id);
        if (el('bound-north')) el('bound-north').value = Number(north) || '';
        if (el('bound-south')) el('bound-south').value = Number(south) || '';
        if (el('bound-east')) el('bound-east').value = Number(east) || '';
        if (el('bound-west')) el('bound-west').value = Number(west) || '';

        modal.style.display = 'block';
    }

    closeBoundsModal() {
        const modal = document.getElementById('admin-bounds-modal');
        if (!modal) return;
        modal.style.display = 'none';
    }

    async handleSaveBounds() {
        try {
            const north = parseFloat((document.getElementById('bound-north')||{}).value);
            const south = parseFloat((document.getElementById('bound-south')||{}).value);
            const east = parseFloat((document.getElementById('bound-east')||{}).value);
            const west = parseFloat((document.getElementById('bound-west')||{}).value);
            if ([north,south,east,west].some(v => Number.isNaN(v))) return this.showMessage('Please provide valid numeric bounds', 'error');

            const token = localStorage.getItem('authToken');
            if (!token) return this.showMessage('Not authenticated', 'error');

            const res = await fetch(`${this.apiBase}/settings/campus-bounds`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ north, south, east, west })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.message || 'Failed to save bounds');

            // update local values and redraw
            this.campusGeo = { north, south, east, west };
            this.dtuCoordinates = [ (north + south)/2, (east + west)/2 ];
            this.campusBounds = L.latLngBounds([south, west], [north, east]);
            this.drawCampusBoundingBox();
            this.closeBoundsModal();
            this.showMessage('Campus bounds updated', 'success');
        } catch (err) {
            this.showMessage(err.message, 'error');
        }
    }

    // Load persisted notifications from server for authenticated user
    async loadUserNotifications() {
        console.log('[loadUserNotifications] FUNCTION CALLED');
        try {
            const token = localStorage.getItem('authToken');
            console.log('[loadUserNotifications] auth token present:', !!token);
            if (!token) {
                console.log('[loadUserNotifications] no auth token, skipping');
                return;
            }
            console.log('[loadUserNotifications] starting fetch from:', `${this.apiBase}/notifications`);
            const res = await fetch(`${this.apiBase}/notifications`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            console.log('[loadUserNotifications] response status:', res.status);
            if (!res.ok) {
                console.warn('[loadUserNotifications] API returned non-OK status:', res.status);
                return;
            }
            const data = await res.json();
            console.log('[loadUserNotifications] received data:', data);
            if (Array.isArray(data)) {
                // Merge with existing broadcasts (don't overwrite)
                const existingBroadcasts = this.notifications || [];
                const userNotifications = data.map(n => ({
                    id: n._id || n.id,
                    title: n.title,
                    message: n.message,
                    createdAt: n.createdAt,
                    isRead: n.isRead
                }));
                
                // Combine: user notifications first, then broadcasts
                this.notifications = [...userNotifications, ...existingBroadcasts];
                
                // set unread count to number of unread notifications if server provided isRead
                if (data.length && data[0] && typeof data[0].isRead !== 'undefined') {
                    this.unreadCount = data.filter(x => !x.isRead).length;
                } else {
                    this.unreadCount = userNotifications.length;
                }
                console.log('[loadUserNotifications] loaded', userNotifications.length, 'user notifications, total:', this.notifications.length);
                this.renderNotificationsDropdown();
            } else {
                console.warn('[loadUserNotifications] data is not an array:', typeof data);
            }
        } catch (e) {
            console.error('[loadUserNotifications] error:', e.message, e);
        }
    }

    // Refresh unread count from server (if authenticated)
    async refreshUnreadCount() {
        try {
            const token = localStorage.getItem('authToken');
            if (!token) return;
            const res = await fetch(`${this.apiBase}/notifications/unread/count`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!res.ok) return;
            const data = await res.json();
            if (data && typeof data.count !== 'undefined') {
                this.unreadCount = Number(data.count) || 0;
                this.renderNotificationsDropdown();
            }
        } catch (e) { console.warn('refreshUnreadCount failed', e); }
    }

    // Footer button helper methods
    navigateToPage(page) {
        try {
            const navLinks = document.querySelectorAll('.nav-link');
            navLinks.forEach(link => {
                link.classList.remove('active');
                if (link.dataset.page === page) {
                    link.classList.add('active');
                    link.click();
                }
            });
        } catch (e) { console.warn('navigateToPage failed', e); }
    }

    showHelpCenter() {
        try {
            const helpContent = `
                <div style="padding: 20px; max-height: 500px; overflow-y: auto;">
                    <h3 style="color: var(--primary-color); margin-bottom: 15px;">Help Center</h3>
                    <div style="line-height: 1.8; color: #333;">
                        <h4 style="margin-top: 15px; margin-bottom: 8px;">Getting Started</h4>
                        <p>1. Select a starting point and destination from the sidebar</p>
                        <p>2. Click "Calculate Route" to see the path</p>
                        <p>3. Use the map controls to zoom and navigate</p>
                        
                        <h4 style="margin-top: 15px; margin-bottom: 8px;">Features</h4>
                        <p><strong>Campus Map:</strong> Browse all campus locations and buildings</p>
                        <p><strong>Live Routing:</strong> Get real-time navigation with your current location</p>
                        <p><strong>AR Navigation:</strong> Use augmented reality for turn-by-turn directions</p>
                        <p><strong>Categories:</strong> Filter locations by type (Academic, Administrative, Services, Recreational)</p>
                        
                        <h4 style="margin-top: 15px; margin-bottom: 8px;">Troubleshooting</h4>
                        <p><strong>Location not found?</strong> Try searching in the category filters</p>
                        <p><strong>Route not calculating?</strong> Ensure both start and end points are selected</p>
                        <p><strong>Need more help?</strong> Contact us at info@dtu.edu.et</p>
                    </div>
                </div>
            `;
            this.showModalContent('Help Center', helpContent);
        } catch (e) { console.warn('showHelpCenter failed', e); }
    }

    showMobileAppInfo() {
        try {
            const appContent = `
                <div style="padding: 20px; text-align: center;">
                    <h3 style="color: var(--primary-color); margin-bottom: 15px;">Mobile App</h3>
                    <p style="margin-bottom: 20px; color: #666;">Download our mobile app for better navigation on the go!</p>
                    <div style="display: flex; gap: 15px; justify-content: center; flex-wrap: wrap;">
                        <a href="#" style="display: inline-block; padding: 12px 24px; background: #000; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600;">
                            <i class="fab fa-apple" style="margin-right: 8px;"></i>App Store
                        </a>
                        <a href="#" style="display: inline-block; padding: 12px 24px; background: #3ddc84; color: #000; border-radius: 8px; text-decoration: none; font-weight: 600;">
                            <i class="fab fa-google-play" style="margin-right: 8px;"></i>Google Play
                        </a>
                    </div>
                    <p style="margin-top: 20px; color: #999; font-size: 0.9rem;">Coming soon to your favorite app store!</p>
                </div>
            `;
            this.showModalContent('Mobile App', appContent);
        } catch (e) { console.warn('showMobileAppInfo failed', e); }
    }

    showAccessibilityInfo() {
        try {
            const accessContent = `
                <div style="padding: 20px; max-height: 500px; overflow-y: auto;">
                    <h3 style="color: var(--primary-color); margin-bottom: 15px;">Accessibility</h3>
                    <div style="line-height: 1.8; color: #333;">
                        <h4 style="margin-top: 15px; margin-bottom: 8px;">Our Commitment</h4>
                        <p>DTU Campus Navigation is designed to be accessible to all users, including those with disabilities.</p>
                        
                        <h4 style="margin-top: 15px; margin-bottom: 8px;">Features</h4>
                        <p><strong>Keyboard Navigation:</strong> Navigate using keyboard shortcuts</p>
                        <p><strong>Screen Reader Support:</strong> Compatible with popular screen readers</p>
                        <p><strong>High Contrast Mode:</strong> Available for better visibility</p>
                        <p><strong>Text Scaling:</strong> Adjust text size for readability</p>
                        
                        <h4 style="margin-top: 15px; margin-bottom: 8px;">Accessibility Statement</h4>
                        <p>We are committed to ensuring digital accessibility for individuals with disabilities. If you encounter any accessibility issues, please contact us at info@dtu.edu.et</p>
                    </div>
                </div>
            `;
            this.showModalContent('Accessibility', accessContent);
        } catch (e) { console.warn('showAccessibilityInfo failed', e); }
    }

    showAddressInfo() {
        try {
            const addressContent = `
                <div style="padding: 20px; text-align: center;">
                    <h3 style="color: var(--primary-color); margin-bottom: 15px;">Our Location</h3>
                    <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin-bottom: 15px;">
                        <p style="font-size: 1.1rem; font-weight: 600; margin-bottom: 8px;">Debre Tabor University</p>
                        <p style="color: #666; margin-bottom: 8px;">Debre Tabor, Ethiopia</p>
                        <p style="color: #999; font-size: 0.9rem;">Located in the heart of Ethiopia's historic region</p>
                    </div>
                    <a href="#" onclick="window.open('https://maps.google.com/?q=Debre+Tabor+University', '_blank'); return false;" style="display: inline-block; padding: 10px 20px; background: var(--primary-color); color: white; border-radius: 6px; text-decoration: none; font-weight: 600;">
                        <i class="fas fa-map-marker-alt" style="margin-right: 8px;"></i>View on Map
                    </a>
                </div>
            `;
            this.showModalContent('Location', addressContent);
        } catch (e) { console.warn('showAddressInfo failed', e); }
    }

    showHoursInfo() {
        try {
            const hoursContent = `
                <div style="padding: 20px;">
                    <h3 style="color: var(--primary-color); margin-bottom: 15px;">Office Hours</h3>
                    <div style="background: #f9f9f9; padding: 20px; border-radius: 8px;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr style="border-bottom: 1px solid #ddd;">
                                <td style="padding: 10px; font-weight: 600;">Monday - Friday</td>
                                <td style="padding: 10px; text-align: right;">8:00 AM - 5:00 PM</td>
                            </tr>
                            <tr style="border-bottom: 1px solid #ddd;">
                                <td style="padding: 10px; font-weight: 600;">Saturday</td>
                                <td style="padding: 10px; text-align: right;">9:00 AM - 1:00 PM</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px; font-weight: 600;">Sunday</td>
                                <td style="padding: 10px; text-align: right;">Closed</td>
                            </tr>
                        </table>
                    </div>
                    <p style="margin-top: 15px; color: #666; font-size: 0.9rem;">For urgent matters, please contact us at +251-58-1410495</p>
                </div>
            `;
            this.showModalContent('Office Hours', hoursContent);
        } catch (e) { console.warn('showHoursInfo failed', e); }
    }

    showModalContent(title, content) {
        try {
            let modal = document.getElementById('footer-info-modal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'footer-info-modal';
                modal.style.cssText = 'display:none; position:fixed; left:0; top:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:2000;';
                document.body.appendChild(modal);
            }
            
            modal.innerHTML = `
                <div style="background:#fff; max-width:600px; margin:40px auto; padding:20px; border-radius:8px; max-height:80vh; overflow-y:auto;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                        <h2 style="margin:0; color:var(--primary-color);">${title}</h2>
                        <button id="close-footer-modal" style="background:none; border:none; font-size:1.5rem; cursor:pointer; color:#666;">&times;</button>
                    </div>
                    ${content}
                </div>
            `;
            
            modal.style.display = 'block';
            const closeBtn = document.getElementById('close-footer-modal');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => {
                    modal.style.display = 'none';
                });
            }
            
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.style.display = 'none';
            });
        } catch (e) { console.warn('showModalContent failed', e); }
    }

    // ===== Location Details Panel Methods =====
    
    /**
     * Show location details panel with user's current location and nearby POIs
     * @param {number} lat - User's latitude
     * @param {number} lng - User's longitude
     */
    showLocationDetails(lat, lng) {
        try {
            // Create or get the location details panel
            let panel = document.getElementById('location-details-panel');
            if (!panel) {
                panel = this._createLocationDetailsPanel();
            }

            // Get user's current location info
            const userLocation = {
                latitude: lat,
                longitude: lng,
                accuracy: this._lastGPSAccuracy || 10
            };

            // Get nearby POIs
            const nearbyPOIs = this.getNearbyPOIs(lat, lng, 500); // 500m radius

            // Update panel content
            this._updateLocationDetailsPanel(panel, userLocation, nearbyPOIs);

            // Show panel
            panel.classList.add('visible');
            panel.style.display = 'block';

            // Store current state
            this._locationDetailsPanelOpen = true;
            this._currentLocationDetails = { lat, lng, userLocation, nearbyPOIs };

        } catch (error) {
            console.error('Error showing location details:', error);
            this.showMessage('Unable to load location details', 'error');
        }
    }

    /**
     * Hide location details panel
     */
    hideLocationDetails() {
        try {
            const panel = document.getElementById('location-details-panel');
            if (panel) {
                panel.classList.remove('visible');
                panel.style.display = 'none';
            }
            this._locationDetailsPanelOpen = false;
        } catch (error) {
            console.error('Error hiding location details:', error);
        }
    }

    /**
     * Create the location details panel HTML structure
     * @returns {HTMLElement} The created panel element
     */
    _createLocationDetailsPanel() {
        const panel = document.createElement('div');
        panel.id = 'location-details-panel';
        panel.className = 'location-details-panel';
        panel.innerHTML = `
            <div class="location-details-content">
                <div class="location-details-header">
                    <h3>${this.t('location_details')}</h3>
                    <button class="close-btn" id="close-location-details">&times;</button>
                </div>
                
                <div class="location-info">
                    <div class="info-item">
                        <label>${this.t('latitude')}:</label>
                        <span id="location-latitude">-</span>
                    </div>
                    <div class="info-item">
                        <label>${this.t('longitude')}:</label>
                        <span id="location-longitude">-</span>
                    </div>
                    <div class="info-item">
                        <label>${this.t('accuracy')}:</label>
                        <span id="location-accuracy">-</span>
                    </div>
                </div>

                <div class="nearby-pois-section">
                    <h4>${this.t('nearby_pois')}</h4>
                    
                    <div class="category-filter">
                        <select id="poi-category-filter">
                            <option value="">${this.t('all_categories')}</option>
                        </select>
                    </div>

                    <div class="nearby-pois-list" id="nearby-pois-list">
                        <p class="loading">${this.t('loading')}</p>
                    </div>
                </div>
            </div>
        `;

        // Add to map container
        const mapContainer = document.getElementById('map');
        if (mapContainer) {
            mapContainer.parentElement.appendChild(panel);
        }

        // Add event listeners
        const closeBtn = panel.querySelector('#close-location-details');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hideLocationDetails());
        }

        const categoryFilter = panel.querySelector('#poi-category-filter');
        if (categoryFilter) {
            categoryFilter.addEventListener('change', (e) => {
                this._filterNearbyPOIs(e.target.value);
            });
        }

        // Close panel when clicking outside
        panel.addEventListener('click', (e) => {
            if (e.target === panel) {
                this.hideLocationDetails();
            }
        });

        return panel;
    }

    /**
     * Update location details panel with current data
     * @param {HTMLElement} panel - The panel element
     * @param {Object} userLocation - User location data
     * @param {Array} nearbyPOIs - Array of nearby POIs
     */
    _updateLocationDetailsPanel(panel, userLocation, nearbyPOIs) {
        try {
            // Update location info
            document.getElementById('location-latitude').textContent = userLocation.latitude;
            document.getElementById('location-longitude').textContent = userLocation.longitude;
            document.getElementById('location-accuracy').textContent = `${Math.round(userLocation.accuracy)} m`;

            // Update category filter options
            const categoryFilter = panel.querySelector('#poi-category-filter');
            const categories = [...new Set(nearbyPOIs.map(poi => poi.category))];
            
            // Clear existing options except the first one
            while (categoryFilter.options.length > 1) {
                categoryFilter.remove(1);
            }

            // Add category options
            categories.forEach(category => {
                const option = document.createElement('option');
                option.value = category;
                option.textContent = category;
                categoryFilter.appendChild(option);
            });

            // Update POI list
            this._updateNearbyPOIsList(nearbyPOIs);

            // Store for filtering
            this._allNearbyPOIs = nearbyPOIs;

        } catch (error) {
            console.error('Error updating location details panel:', error);
        }
    }

    /**
     * Update the nearby POIs list display
     * @param {Array} pois - Array of POIs to display
     */
    _updateNearbyPOIsList(pois) {
        try {
            const poiList = document.getElementById('nearby-pois-list');
            if (!poiList) return;

            if (pois.length === 0) {
                poiList.innerHTML = `<p class="no-pois">${this.t('no_nearby_pois')}</p>`;
                return;
            }

            poiList.innerHTML = pois.map(poi => `
                <div class="poi-item" data-poi-id="${poi.id}">
                    <div class="poi-info">
                        <h5>${poi.name}</h5>
                        <p class="poi-category">${poi.category}</p>
                        <p class="poi-distance">${this._formatDistance(poi.distance)}</p>
                    </div>
                    <button class="poi-action-btn" data-poi-id="${poi.id}">
                        ${this.t('navigate')}
                    </button>
                </div>
            `).join('');

            // Add click handlers for POI items
            poiList.querySelectorAll('.poi-action-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const poiId = e.target.dataset.poiId;
                    const poi = pois.find(p => p.id === poiId);
                    if (poi) {
                        this._handlePOISelection(poi);
                    }
                });
            });

        } catch (error) {
            console.error('Error updating nearby POIs list:', error);
        }
    }

    /**
     * Filter nearby POIs by category
     * @param {string} category - Category to filter by (empty string for all)
     */
    _filterNearbyPOIs(category) {
        try {
            if (!this._allNearbyPOIs) return;

            let filtered = this._allNearbyPOIs;
            if (category) {
                filtered = this._allNearbyPOIs.filter(poi => poi.category === category);
            }

            this._updateNearbyPOIsList(filtered);
        } catch (error) {
            console.error('Error filtering nearby POIs:', error);
        }
    }

    /**
     * Get nearby POIs within a specified radius
     * @param {number} lat - User latitude
     * @param {number} lng - User longitude
     * @param {number} radius - Search radius in meters
     * @returns {Array} Array of nearby POIs sorted by distance
     */
    getNearbyPOIs(lat, lng, radius = 500) {
        try {
            const nearby = [];

            this.pois.forEach(poi => {
                const distance = this.calculateDistance(lat, lng, poi.latitude, poi.longitude);
                if (distance <= radius) {
                    nearby.push({
                        ...poi,
                        distance: distance
                    });
                }
            });

            // Sort by distance (closest first)
            nearby.sort((a, b) => a.distance - b.distance);

            return nearby;
        } catch (error) {
            console.error('Error getting nearby POIs:', error);
            return [];
        }
    }

    /**
     * Format distance for display
     * @param {number} meters - Distance in meters
     * @returns {string} Formatted distance string
     */
    _formatDistance(meters) {
        if (meters < 1000) {
            return `${Math.round(meters)} m`;
        } else {
            return `${(meters / 1000).toFixed(1)} km`;
        }
    }

    /**
     * Handle POI selection from location details panel
     * @param {Object} poi - Selected POI
     */
    _handlePOISelection(poi) {
        try {
            // Close location details panel
            this.hideLocationDetails();

            // Calculate route to selected POI
            if (this.currentUser) {
                this.calculateRoute(poi);
            } else {
                // If no user location, just show POI details
                this.showPOIDetails(poi);
            }
        } catch (error) {
            console.error('Error handling POI selection:', error);
        }
    }

    /**
     * Add click handler to user location marker
     */
    _addLocationMarkerClickHandler() {
        try {
            if (this.userLocationMarker) {
                this.userLocationMarker.on('click', () => {
                    if (this._lastGPSPosition) {
                        this.showLocationDetails(
                            this._lastGPSPosition.lat,
                            this._lastGPSPosition.lng
                        );
                    }
                });
            }
        } catch (error) {
            console.error('Error adding location marker click handler:', error);
        }
    }
}

// Initialize the application
let app;

document.addEventListener('DOMContentLoaded', () => {
    app = new DTUCampusNavigation();
    window.app = app; // Make available globally for debugging
    
    // Initialize Admin POI Manager for real-time POI updates
    try {
        const adminPoiManager = new AdminPOIManager('http://localhost:5000/api', app);
        window.adminPoiManager = adminPoiManager;
        console.log('[Init] AdminPOIManager initialized');
    } catch (e) {
        console.warn('[Init] Failed to initialize AdminPOIManager:', e);
    }
});

// Quick demo helper: open `index.html?demo` to auto-select two POIs and calculate route
try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('demo')) {
        // delay to allow app to finish initialization and populate selects
        setTimeout(() => {
            try {
                if (!window.app) return;
                // ensure datalists populated
                try { window.app.populateDatalists(); } catch (e) {}
                const startSel = document.getElementById('start-select');
                const endSel = document.getElementById('end-select');
                if (startSel && endSel) {
                    // choose two example blocks that should exist in the canonical list
                    startSel.value = 'block_1';
                    endSel.value = 'block_10';
                    try { startSel.dispatchEvent(new Event('change')); } catch (e) {}
                    try { endSel.dispatchEvent(new Event('change')); } catch (e) {}
                    // trigger calculation
                    try { window.app.calculateRoute(); } catch (e) { console.warn('Demo calculate failed', e); }
                }
            } catch (e) { console.warn('Demo initialization failed', e); }
        }, 1200);
    }
} catch (e) { /* non-fatal */ }
