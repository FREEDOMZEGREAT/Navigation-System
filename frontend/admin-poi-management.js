/**
 * Admin POI Management Module
 * Handles creation, editing, and deletion of POIs
 * Integrates with main navigation system to update map in real-time
 */

class AdminPOIManager {
  constructor(apiBase = 'http://localhost:5000/api', navigationInstance = null) {
    this.apiBase = apiBase;
    this.currentEditingPOI = null;
    this.navigationInstance = navigationInstance || window.dtuNavigation; // Reference to main DTUCampusNavigation instance
    this.init();
  }

  init() {
    this.setupEventListeners();
  }

  setupEventListeners() {
    // POI Management button
    const poiMgmtBtn = document.getElementById('admin-poi-management-btn');
    if (poiMgmtBtn) {
      poiMgmtBtn.addEventListener('click', () => this.openPOIManagementPanel());
    }

    // Form submission
    const submitBtn = document.getElementById('admin-poi-submit-btn');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => this.handleSubmitPOI());
    }

    // Cancel button
    const cancelBtn = document.getElementById('admin-poi-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.closePOIForm());
    }

    // Close panel button
    const closeBtn = document.getElementById('admin-poi-panel-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.closePOIManagementPanel());
    }

    // Add new POI button
    const addNewBtn = document.getElementById('admin-poi-add-new-btn');
    if (addNewBtn) {
      addNewBtn.addEventListener('click', () => this.openPOIForm());
    }

    // Listen for real-time POI updates via socket.io
    if (window.socket) {
      window.socket.on('poi-updated', (data) => {
        console.log('[AdminPOI] Received POI update:', data);
        this.handlePOIUpdate(data);
      });
    }
  }

  /**
   * Handle real-time POI updates from backend
   * Updates map and POI list when changes occur
   */
  handlePOIUpdate(data) {
    try {
      const { action, poi, poiId, poiName } = data;

      if (action === 'created') {
        console.log('[AdminPOI] New POI created:', poi.name);
        // Add to navigation POIs list
        if (this.navigationInstance && this.navigationInstance.pois) {
          this.navigationInstance.pois.push(poi);
          this.navigationInstance.addMarkerToMap(poi);
          this.navigationInstance.populateDatalists();
        }
        // Refresh POI list if panel is open
        if (document.getElementById('admin-poi-management-panel').style.display !== 'none') {
          this.loadPOIList();
        }
      } else if (action === 'updated') {
        console.log('[AdminPOI] POI updated:', poi.name);
        // Update in navigation POIs list
        if (this.navigationInstance && this.navigationInstance.pois) {
          const idx = this.navigationInstance.pois.findIndex(p => p._id === poi._id);
          if (idx >= 0) {
            this.navigationInstance.pois[idx] = poi;
            // Update marker on map
            this.navigationInstance.updateMarkerForPOI(poi);
            this.navigationInstance.populateDatalists();
          }
        }
        // Refresh POI list if panel is open
        if (document.getElementById('admin-poi-management-panel').style.display !== 'none') {
          this.loadPOIList();
        }
      } else if (action === 'deleted') {
        console.log('[AdminPOI] POI deleted:', poiName);
        // Remove from navigation POIs list
        if (this.navigationInstance && this.navigationInstance.pois) {
          this.navigationInstance.pois = this.navigationInstance.pois.filter(p => p._id !== poiId);
          // Remove marker from map
          this.navigationInstance.removeMarkerForPOI(poiId);
          this.navigationInstance.populateDatalists();
        }
        // Refresh POI list if panel is open
        if (document.getElementById('admin-poi-management-panel').style.display !== 'none') {
          this.loadPOIList();
        }
      }
    } catch (e) {
      console.warn('[AdminPOI] Error handling POI update:', e);
    }
  }

  async openPOIManagementPanel() {
    const panel = document.getElementById('admin-poi-management-panel');
    if (!panel) {
      console.error('POI management panel not found');
      return;
    }

    panel.style.display = 'block';
    await this.loadPOIList();
  }

  closePOIManagementPanel() {
    const panel = document.getElementById('admin-poi-management-panel');
    if (panel) {
      panel.style.display = 'none';
    }
    this.closePOIForm();
  }

  openPOIForm(poi = null) {
    const form = document.getElementById('admin-poi-form');
    const formTitle = document.getElementById('admin-poi-form-title');
    const submitBtn = document.getElementById('admin-poi-submit-btn');

    if (!form) return;

    this.currentEditingPOI = poi;

    if (poi) {
      // Edit mode
      formTitle.textContent = 'Edit POI';
      submitBtn.textContent = 'Update POI';
      document.getElementById('admin-poi-name').value = poi.name || '';
      document.getElementById('admin-poi-description').value = poi.description || '';
      document.getElementById('admin-poi-building').value = poi.building || '';
      document.getElementById('admin-poi-category').value = poi.category || 'services';
      document.getElementById('admin-poi-latitude').value = poi.latitude || '';
      document.getElementById('admin-poi-longitude').value = poi.longitude || '';
      document.getElementById('admin-poi-floor').value = poi.floor || 'Ground Floor';
      document.getElementById('admin-poi-opening-hours').value = poi.opening_hours || '';
    } else {
      // Create mode
      formTitle.textContent = 'Add New POI';
      submitBtn.textContent = 'Add POI';
      this.clearPOIForm();
    }

    form.style.display = 'block';
  }

  closePOIForm() {
    const form = document.getElementById('admin-poi-form');
    if (form) {
      form.style.display = 'none';
    }
    this.currentEditingPOI = null;
    this.clearPOIForm();
  }

  clearPOIForm() {
    document.getElementById('admin-poi-name').value = '';
    document.getElementById('admin-poi-description').value = '';
    document.getElementById('admin-poi-building').value = '';
    document.getElementById('admin-poi-category').value = 'services';
    document.getElementById('admin-poi-latitude').value = '';
    document.getElementById('admin-poi-longitude').value = '';
    document.getElementById('admin-poi-floor').value = 'Ground Floor';
    document.getElementById('admin-poi-opening-hours').value = '';
    document.getElementById('admin-poi-form-error').textContent = '';
  }

  validatePOIForm() {
    const name = document.getElementById('admin-poi-name').value.trim();
    const description = document.getElementById('admin-poi-description').value.trim();
    const building = document.getElementById('admin-poi-building').value.trim();
    const category = document.getElementById('admin-poi-category').value;
    const latitude = parseFloat(document.getElementById('admin-poi-latitude').value);
    const longitude = parseFloat(document.getElementById('admin-poi-longitude').value);

    const errors = [];

    if (!name) errors.push('Name is required');
    if (!description) errors.push('Description is required');
    if (!building) errors.push('Building is required');
    if (!category) errors.push('Category is required');
    if (isNaN(latitude) || latitude < -90 || latitude > 90) {
      errors.push('Latitude must be a number between -90 and 90');
    }
    if (isNaN(longitude) || longitude < -180 || longitude > 180) {
      errors.push('Longitude must be a number between -180 and 180');
    }

    return { valid: errors.length === 0, errors };
  }

  async handleSubmitPOI() {
    const validation = this.validatePOIForm();
    const errorEl = document.getElementById('admin-poi-form-error');

    if (!validation.valid) {
      errorEl.textContent = validation.errors.join('; ');
      errorEl.style.display = 'block';
      return;
    }

    errorEl.style.display = 'none';

    const token = localStorage.getItem('authToken');
    if (!token) {
      errorEl.textContent = 'Not authenticated';
      errorEl.style.display = 'block';
      return;
    }

    const payload = {
      name: document.getElementById('admin-poi-name').value.trim(),
      description: document.getElementById('admin-poi-description').value.trim(),
      building: document.getElementById('admin-poi-building').value.trim(),
      category: document.getElementById('admin-poi-category').value,
      latitude: parseFloat(document.getElementById('admin-poi-latitude').value),
      longitude: parseFloat(document.getElementById('admin-poi-longitude').value),
      floor: document.getElementById('admin-poi-floor').value.trim() || 'Ground Floor',
      opening_hours: document.getElementById('admin-poi-opening-hours').value.trim(),
      tags: []
    };

    try {
      const method = this.currentEditingPOI ? 'PUT' : 'POST';
      const url = this.currentEditingPOI
        ? `${this.apiBase}/pois/${this.currentEditingPOI._id}`
        : `${this.apiBase}/pois`;

      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to save POI');
      }

      const data = await res.json();
      const message = this.currentEditingPOI ? 'POI updated successfully' : 'POI created successfully';
      this.showMessage(message, 'success');

      // Update map immediately
      if (this.navigationInstance) {
        if (this.currentEditingPOI) {
          // Update existing POI in map
          const idx = this.navigationInstance.pois.findIndex(p => p._id === data._id);
          if (idx >= 0) {
            this.navigationInstance.pois[idx] = data;
            this.navigationInstance.updateMarkerForPOI(data);
          }
        } else {
          // Add new POI to map
          this.navigationInstance.pois.push(data);
          this.navigationInstance.addMarkerToMap(data);
        }
        this.navigationInstance.populateDatalists();
      }

      this.closePOIForm();
      await this.loadPOIList();
    } catch (error) {
      console.error('Error saving POI:', error);
      errorEl.textContent = error.message || 'Failed to save POI';
      errorEl.style.display = 'block';
    }
  }

  async loadPOIList() {
    const listContainer = document.getElementById('admin-poi-list');
    if (!listContainer) return;

    try {
      const res = await fetch(`${this.apiBase}/pois?limit=1000`);
      if (!res.ok) throw new Error('Failed to fetch POIs');

      const pois = await res.json();
      this.renderPOIList(pois, listContainer);
    } catch (error) {
      console.error('Error loading POI list:', error);
      listContainer.innerHTML = `<div class="error-message">Failed to load POIs: ${error.message}</div>`;
    }
  }

  renderPOIList(pois, container) {
    if (!pois || pois.length === 0) {
      container.innerHTML = '<div style="padding: 16px; text-align: center; color: #999;">No POIs found</div>';
      return;
    }

    // Group by category
    const grouped = {};
    pois.forEach(poi => {
      const cat = poi.category || 'uncategorized';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(poi);
    });

    let html = '';
    Object.keys(grouped).sort().forEach(category => {
      html += `<div class="admin-poi-category">
        <h4 style="margin: 12px 0 8px 0; padding: 8px; background: #f0f0f0; border-radius: 4px;">
          ${category.charAt(0).toUpperCase() + category.slice(1)} (${grouped[category].length})
        </h4>
        <div class="admin-poi-items">`;

      grouped[category].forEach(poi => {
        html += `<div class="admin-poi-item" data-poi-id="${poi._id}">
          <div class="admin-poi-item-header">
            <div class="admin-poi-item-name">${this.escapeHtml(poi.name)}</div>
            <div class="admin-poi-item-actions">
              <button class="btn btn-sm btn-secondary" onclick="window.adminPOIManager.editPOI('${poi._id}')">
                <i class="fas fa-edit"></i> Edit
              </button>
              <button class="btn btn-sm btn-danger" onclick="window.adminPOIManager.deletePOI('${poi._id}')">
                <i class="fas fa-trash"></i> Delete
              </button>
            </div>
          </div>
          <div class="admin-poi-item-details">
            <div><strong>Building:</strong> ${this.escapeHtml(poi.building)}</div>
            <div><strong>Coordinates:</strong> ${poi.latitude.toFixed(6)}, ${poi.longitude.toFixed(6)}</div>
            <div><strong>Description:</strong> ${this.escapeHtml(poi.description.substring(0, 100))}${poi.description.length > 100 ? '...' : ''}</div>
          </div>
        </div>`;
      });

      html += '</div></div>';
    });

    container.innerHTML = html;
  }

  async editPOI(poiId) {
    try {
      const res = await fetch(`${this.apiBase}/pois/${poiId}`);
      if (!res.ok) throw new Error('Failed to fetch POI');

      const poi = await res.json();
      this.openPOIForm(poi);
    } catch (error) {
      console.error('Error loading POI:', error);
      this.showMessage('Failed to load POI', 'error');
    }
  }

  async deletePOI(poiId) {
    if (!confirm('Are you sure you want to delete this POI? This action cannot be undone.')) {
      return;
    }

    const token = localStorage.getItem('authToken');
    if (!token) {
      this.showMessage('Not authenticated', 'error');
      return;
    }

    try {
      const res = await fetch(`${this.apiBase}/pois/${poiId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to delete POI');
      }

      this.showMessage('POI deleted successfully', 'success');

      // Update map immediately
      if (this.navigationInstance) {
        this.navigationInstance.pois = this.navigationInstance.pois.filter(p => p._id !== poiId);
        this.navigationInstance.removeMarkerForPOI(poiId);
        this.navigationInstance.populateDatalists();
      }

      await this.loadPOIList();
    } catch (error) {
      console.error('Error deleting POI:', error);
      this.showMessage(error.message || 'Failed to delete POI', 'error');
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  showMessage(message, type = 'info') {
    // Use existing notification system if available
    if (window.notificationSystem && window.notificationSystem.show) {
      window.notificationSystem.show(message, type);
    } else {
      alert(message);
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // Wait a moment for the main app to initialize
    setTimeout(() => {
      window.adminPOIManager = new AdminPOIManager(
        window.API_BASE || 'http://localhost:5000/api',
        window.app
      );
    }, 100);
  });
} else {
  // Wait a moment for the main app to initialize
  setTimeout(() => {
    window.adminPOIManager = new AdminPOIManager(
      window.API_BASE || 'http://localhost:5000/api',
      window.app
    );
  }, 100);
}
