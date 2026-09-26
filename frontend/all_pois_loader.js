// all_pois_loader.js
// Loads POIs from the static JSON endpoint.
(async function () {
    try {
        const apiBase = window.API_BASE || 'http://localhost:5000/api';
        const url = apiBase.replace('/api', '') + '/all_pois.json';
        console.log('[all_pois_loader] Fetching from:', url);
        
        const res = await fetch(url);
        console.log('[all_pois_loader] Response status:', res.status);
        
        if (res.ok) {
            const data = await res.json();
            window.allPOIs = Array.isArray(data) ? data : [];
            console.log('[all_pois_loader] Loaded', window.allPOIs.length, 'POIs');
            try { 
                document.dispatchEvent(new CustomEvent('all_pois_loaded')); 
            } catch (e) {
                console.warn('[all_pois_loader] Failed to dispatch event:', e);
            }
            return;
        } else {
            console.warn('[all_pois_loader] Response not OK:', res.status, res.statusText);
        }
    } catch (e) {
        console.warn('[all_pois_loader] failed to fetch POIs', e);
    }
    
    // Fallback: set empty array and dispatch event
    window.allPOIs = [];
    try { 
        document.dispatchEvent(new CustomEvent('all_pois_loaded')); 
    } catch (e) {
        console.warn('[all_pois_loader] Failed to dispatch fallback event:', e);
    }
})();
