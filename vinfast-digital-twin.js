class VinFastDigitalTwin extends HTMLElement {
  setConfig(config) {
    this.config = config || {};
    this._map = null;
    this._polyline = null;
    this._marker = null;
    this._stationLayer = null;
    this._leafletLoaded = false;
    this._lastLat = null;
    this._lastLon = null;
    this._isReplaying = false;
    this._replayTimer = null;
    this._tripHistory = []; 
    this._selectedRouteCoords = []; 
    this._stationFilter = 'ALL'; 
    this._currentStations = []; 
    this._backendData = {};
    this._powerFetchTimer = null;
    this._currentPolylineString = null;
  }

  loadLeaflet() {
    if (this._leafletLoaded) return;
    this._leafletLoaded = true;
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => { setTimeout(() => this.initMap(), 200); };
    document.head.appendChild(script);
  }

  async fetchBackendState(vin) {
      if (!vin) return;
      try {
          const res = await fetch(`/local/vinfast_state_${vin.toLowerCase()}.json?v=${new Date().getTime()}`);
          if (res.ok) {
              const stateData = await res.json();
              if (stateData && stateData.last_data) {
                  this._backendData = stateData.last_data;
                  
                  const powerEl = this.querySelector('#vf-charge-power');
                  if (powerEl) {
                      let pwr = this._backendData.api_live_charge_power || 0;
                      powerEl.innerText = pwr > 0 ? `${pwr} kW` : 'Đang tính...';
                  }

                  if (this._map && this._lastLat === null && this._backendData.api_last_lat) {
                      this._lastLat = parseFloat(this._backendData.api_last_lat);
                      this._lastLon = parseFloat(this._backendData.api_last_lon);
                      this._map.setView([this._lastLat, this._lastLon], 15);
                      if (this._marker) {
                          this._marker.setLatLng([this._lastLat, this._lastLon]);
                          this._marker.setOpacity(1);
                      }
                  }
              }
          }
      } catch(e) {}
  }

  cleanRouteData(points) {
      if (!points || !Array.isArray(points) || points.length === 0) return [];
      return points; 
  }

  async fetchTripHistory(vin) {
    if (!vin) return;
    try {
        const res = await fetch(`/local/vinfast_trips_${vin.toLowerCase()}.json?v=${new Date().getTime()}`);
        if (res.ok) {
            this._tripHistory = await res.json();
            this.renderTripSelector();
        }
    } catch(e) {}
  }

  renderEmptyTripSelector() {
      const selectEl = this.querySelector('#trip-selector');
      if (selectEl) selectEl.innerHTML = `<option value="current">📍 Đang ghi Trip...</option>`;
  }

  renderTripSelector() {
      const selectEl = this.querySelector('#trip-selector');
      if (!selectEl || this._tripHistory.length === 0) {
          this.renderEmptyTripSelector();
          return;
      }
      let options = `<option value="current">📍 Chuyến đi hiện tại</option>`;
      this._tripHistory.forEach((trip, index) => {
          let shortStart = (trip.start_address || "").split(',')[0].substring(0, 15);
          options += `<option value="${index}">🗓 ${trip.date} ${trip.start_time} - ${trip.distance}km (${shortStart}...)</option>`;
      });
      selectEl.innerHTML = options;
  }

  getBearing(startLat, startLng, destLat, destLng) {
      startLat = startLat * Math.PI / 180; startLng = startLng * Math.PI / 180;
      destLat = destLat * Math.PI / 180; destLng = destLng * Math.PI / 180;
      const y = Math.sin(destLng - startLng) * Math.cos(destLat);
      const x = Math.cos(startLat) * Math.sin(destLat) - Math.sin(startLat) * Math.cos(destLat) * Math.cos(destLng - startLng);
      let brng = Math.atan2(y, x);
      return (brng * 180 / Math.PI + 360) % 360;
  }

  getCarIcon(angle = 0, speed = null) {
      if(typeof L === 'undefined') return null;
      
      const arrowSvg = `<svg class="car-dir-svg" viewBox="0 0 24 24" fill="#2563eb" stroke="white" stroke-width="2" style="position: absolute; top: 0; left: 0; transform: rotate(${angle}deg); transform-origin: center; transition: transform 0.25s linear; width: 28px; height: 28px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5)); z-index: 1000;"><path d="M12 2L22 20L12 17L2 20L12 2Z"/></svg>`;
      
      let speedDisplay = speed !== null ? 'block' : 'none';
      let speedVal = speed !== null ? speed : 0;
      const speedBadge = `<div class="car-speed-badge" style="position: absolute; bottom: 32px; left: 50%; transform: translateX(-50%); background: #10b981; color: white; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: bold; border: 1px solid white; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.3); z-index: 1001; display: ${speedDisplay};">${speedVal} km/h</div>`;
      
      return L.divIcon({ 
          className: '', 
          html: `<div style="position: relative; width: 28px; height: 28px;">${arrowSvg}${speedBadge}</div>`, 
          iconSize: [28, 28], 
          iconAnchor: [14, 14] 
      });
  }

  renderStations() {
      if (!this._stationLayer || !this._map || typeof L === 'undefined') return;
      this._stationLayer.clearLayers();
      if (!Array.isArray(this._currentStations)) return;

      this._currentStations.forEach(st => {
          if (st.dist > 5.0) return; 
          const isDC = st.power >= 20;
          if (this._stationFilter === 'DC' && !isDC) return;
          if (this._stationFilter === 'AC' && isDC) return;

          if (st.lat && st.lng) {
              let ratio = st.total > 0 ? (st.avail / st.total) * 100 : 0;
              let pinColor = '', statusText = '';
              if (st.total === 0 || st.avail === 0) { pinColor = '#dc2626'; statusText = 'Hết chỗ'; }
              else if (ratio < 30) { pinColor = '#f97316'; statusText = 'Sắp kín'; }
              else if (ratio < 50) { pinColor = '#eab308'; statusText = 'Đông'; }
              else if (ratio < 80) { pinColor = '#0ea5e9'; statusText = 'Trống'; }
              else { pinColor = '#16a34a'; statusText = 'Vắng'; }

              let boltCount = st.power >= 120 ? 3 : (st.power >= 20 ? 2 : 1);
              let boltsHtml = Array(boltCount).fill(`<ha-icon icon="mdi:flash" style="--mdc-icon-size: 16px; margin: 0 -2px;"></ha-icon>`).join('');
              const pinWidth = boltCount === 1 ? 30 : (boltCount === 2 ? 42 : 54);

              const stationIcon = L.divIcon({ 
                  className: 'custom-station-marker', 
                  html: `<div style="background-color: ${pinColor}; border: 2px solid white; border-radius: 14px; padding: 2px; display: flex; align-items: center; justify-content: center; color: white; box-shadow: 0 3px 6px rgba(0,0,0,0.3); height: 26px; width: ${pinWidth}px;">${boltsHtml}</div>`, 
                  iconSize: [pinWidth, 26], iconAnchor: [pinWidth / 2, 13] 
              });

              // =================================================================
              // ĐÃ FIX LINK GOOGLE MAPS - CHUẨN API MỞ APP TRÊN ĐIỆN THOẠI
              // =================================================================
              let originParam = (this._lastLat && this._lastLon) ? `&origin=${this._lastLat},${this._lastLon}` : '';
              const navUrl = `https://www.google.com/maps/dir/?api=1${originParam}&destination=${st.lat},${st.lng}&travelmode=driving`;

              const popupContent = `
                  <div style="font-family:sans-serif; min-width: 170px;">
                      <b style="font-size: 13px; color: #1e3a8a;">${st.name}</b><br>
                      <div style="margin-top: 6px; font-size: 12px;">
                          🚗 Cách xe: <b>${st.dist} km</b><br>
                          ⚡ Công suất: <b>${st.power} kW</b><br>
                          🔌 Trụ trống: <b style="color:${pinColor}; font-size:14px;">${st.avail} / ${st.total}</b>
                      </div>
                      <a href="${navUrl}" target="_blank" style="display: flex; align-items: center; justify-content: center; gap: 4px; margin-top: 10px; background: #2563eb; color: white; padding: 8px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 12px; transition: background 0.2s;">
                          <svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"></polygon></svg>
                          Chỉ đường (Maps)
                      </a>
                  </div>
              `;

              L.marker([st.lat, st.lng], {icon: stationIcon}).bindPopup(popupContent).addTo(this._stationLayer);
          }
      });
  }

  initMap() {
    const mapEl = this.querySelector('#vf-map-canvas');
    if (!mapEl || typeof L === 'undefined' || this._map) return;
    
    this._map = L.map(mapEl, { zoomControl: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(this._map);
    this._marker = L.marker([0, 0], {icon: this.getCarIcon(0, null), opacity: 0}).addTo(this._map);
    this._polyline = L.polyline([], {color: '#2563eb', weight: 4, opacity: 0.8}).addTo(this._map);
    this._stationLayer = L.layerGroup().addTo(this._map);
    
    const p = this.config?.entity_prefix || 'vinfast_xe';
    const vinStr = p.includes('_') ? p.split('_')[1] : p;
    this.fetchBackendState(vinStr);

    new IntersectionObserver((entries) => { 
        if (entries[0].isIntersecting && this._map) setTimeout(() => this._map.invalidateSize(), 100); 
    }).observe(mapEl);
  }

  set hass(hass) {
    try {
      this._hass = hass;
      const p = this.config?.entity_prefix || 'vinfast_xe';
      const vinStr = p.includes('_') ? p.split('_')[1] : p;
      
      const getValidState = (entityId) => {
        const stateObj = hass.states[entityId];
        if (!stateObj || stateObj.state === 'unavailable' || stateObj.state === 'unknown' || stateObj.state === '') return null;
        return stateObj.state;
      };

      const formatTimeSince = (dateString) => {
          if (!dateString) return "";
          const s = Math.floor((new Date() - new Date(dateString)) / 1000);
          if (s < 60) return "vừa xong";
          const m = Math.floor(s / 60); if (m < 60) return `${m} phút trước`;
          const h = Math.floor(m / 60); if (h < 24) return `${h} giờ trước`;
          return `${Math.floor(h / 24)} ngày trước`;
      };

      if (!this.content) {
        this.loadLeaflet();
        this.fetchTripHistory(vinStr);
        
        this.innerHTML = `
          <ha-card class="vf-card">
            <div class="vf-card-container">
              <div class="vf-header">
                <div class="vf-title">
                  <svg viewBox="0 0 512 512" fill="currentColor"><path d="M560 3586 c-132 -28 -185 -75 -359 -321 -208 -291 -201 -268 -201 -701 0 -361 3 -383 69 -470 58 -77 133 -109 311 -134 202 -29 185 -21 199 -84 14 -62 66 -155 119 -209 110 -113 277 -165 430 -133 141 29 269 125 328 246 l29 59 1115 0 1115 0 29 -59 c60 -123 201 -226 345 -250 253 -43 499 137 543 397 34 203 -77 409 -268 500 -69 33 -89 38 -172 41 -116 5 -198 -15 -280 -67 -116 -76 -195 -193 -214 -321 -6 -36 -12 -71 -14 -77 -5 -19 -2163 -19 -2168 0 -2 6 -8 41 -14 77 -19 128 -98 245 -214 321 -82 52 -164 72 -280 67 -82 -3 -103 -8 -168 -40 -41 -19 -94 -52 -117 -72 -55 -48 -115 -139 -137 -209 -21 -68 -13 -66 -196 -37 -69 11 -128 20 -132 20 -17 0 -82 67 -94 97 -10 23 -14 86 -14 228 l0 195 60 0 c48 0 63 4 80 22 22 24 26 58 10 88 -12 22 -61 40 -111 40 l-39 0 0 43 c1 23 9 65 18 93 20 58 264 406 317 453 43 37 120 61 198 61 52 0 58 -2 53 -17 -4 -10 -48 -89 -98 -177 -70 -122 -92 -170 -95 -205 -5 -56 19 -106 67 -138 l33 -23 1511 0 c867 0 1583 -4 1680 -10 308 -18 581 -60 788 -121 109 -32 268 -103 268 -119 0 -6 -27 -10 -60 -10 -68 0 -100 -21 -100 -66 0 -63 40 -84 161 -84 l79 0 0 -214 c0 -200 -1 -215 -20 -239 -13 -16 -35 -29 -58 -33 -88 -16 -113 -102 -41 -140 81 -41 228 49 259 160 8 29 11 119 8 292 l-3 249 -32 67 c-45 96 -101 152 -197 197 -235 112 -604 187 -1027 209 l-156 9 -319 203 c-176 112 -359 223 -409 246 -116 56 -239 91 -366 104 -149 15 -1977 12 -2049 -4z m800 -341 l0 -205 -335 0 -336 0 12 23 c7 12 59 104 116 205 l105 182 219 0 219 0 0 -205z m842 15 c14 -102 27 -193 27 -202 1 -17 -23 -18 -359 -18 l-360 0 0 198 c0 109 3 202 7 205 4 4 153 6 332 5 l326 -3 27 -185z m528 157 c52 -14 125 -38 161 -55 54 -24 351 -206 489 -299 l35 -23 -516 0 -516 0 -26 188 c-15 103 -27 196 -27 206 0 18 7 19 153 13 112 -5 177 -12 247 -30z m-1541 -1132 c115 -63 176 -174 169 -305 -16 -272 -334 -402 -541 -221 -20 18 -51 63 -69 99 -28 57 -33 77 -33 142 0 65 5 85 33 142 37 76 93 128 169 159 75 30 200 23 272 -16z m3091 16 c110 -42 192 -149 207 -269 18 -159 -101 -319 -264 -352 -134 -28 -285 47 -350 174 -37 72 -43 180 -14 257 35 91 107 162 200 195 55 20 162 17 221 -5z"></path></svg>
                  <span id="vf-name"></span>
                </div>
                <div class="vf-odo"><div class="vf-odo-label">ODOMETER</div><div class="vf-odo-value"><span id="vf-odo-int"></span> <span class="vf-odo-unit">km</span></div></div>
              </div>

              <div class="vf-car-stage">
                <div id="vf-status-badge" class="vf-status-badge"></div>
                <img id="vf-car-img" src="" alt="VinFast Car" onerror="this.src='https://shop.vinfastauto.com/on/demandware.static/-/Sites-app_vinfast_vn-Library/default/dw15d3dc68/images/PDP/vf9/M/M.png'">
                <div class="vf-tire vf-tire-fl" id="tire-fl" style="display:none;"><ha-icon icon="mdi:tire"></ha-icon><br><span></span> <span class="tire-unit">bar</span></div>
                <div class="vf-tire vf-tire-fr" id="tire-fr" style="display:none;"><ha-icon icon="mdi:tire"></ha-icon><br><span></span> <span class="tire-unit">bar</span></div>
                <div class="vf-tire vf-tire-rl" id="tire-rl" style="display:none;"><ha-icon icon="mdi:tire"></ha-icon><br><span></span> <span class="tire-unit">bar</span></div>
                <div class="vf-tire vf-tire-rr" id="tire-rr" style="display:none;"><ha-icon icon="mdi:tire"></ha-icon><br><span></span> <span class="tire-unit">bar</span></div>
              </div>

              <div class="vf-controls-area">
                <div class="vf-gears"><span class="gear" id="gear-P">P</span><span class="gear" id="gear-R">R</span><span class="gear" id="gear-N">N</span><span class="gear" id="gear-D">D</span></div>
                <div class="vf-speed" id="vf-speed-container"><span id="vf-speed"></span><span class="vf-speed-unit">km/h</span></div>
              </div>
              
              <div class="vf-doors-status" id="vf-doors-container"></div>
              
              <div class="vf-charging-banner" id="vf-charging-banner" style="display: none;">
                  <div class="charging-info">
                      <div class="charging-title"><ha-icon icon="mdi:ev-plug-type2"></ha-icon><span id="vf-charge-status-text">Hệ thống đang sạc</span></div>
                      <div class="charging-details">Giới hạn: <span id="vf-charge-limit">--%</span><span style="margin:0 6px;opacity:0.5;">|</span>Công suất: <span id="vf-charge-power">-- kW</span></div>
                  </div>
                  <div class="charging-time-box"><span id="vf-charge-time" class="charging-time">--</span><span style="font-size:11px;opacity:0.8;">còn lại</span></div>
              </div>

              <div class="vf-remote-bar" id="vf-remote-controls" style="display: none;">
                  <div class="remote-btn" id="btn-rc-lock" title="Khóa cửa"><ha-icon icon="mdi:lock"></ha-icon></div>
                  <div class="remote-btn" id="btn-rc-unlock" title="Mở cửa"><ha-icon icon="mdi:lock-open"></ha-icon></div>
                  <div class="remote-btn" id="btn-rc-horn" title="Bấm còi"><ha-icon icon="mdi:bullhorn"></ha-icon></div>
                  <div class="remote-btn" id="btn-rc-lights" title="Nháy đèn"><ha-icon icon="mdi:car-light-high"></ha-icon></div>
              </div>

              <div class="vf-stats-grid">
                <div class="stat-box clickable" data-entity="sensor.${p}_phan_tram_pin">
                  <ha-icon icon="mdi:battery-charging-60" style="color: #10b981;"></ha-icon>
                  <div class="stat-info"><div class="stat-label">Mức Pin</div><div class="stat-val" id="vf-stat-batt">--</div></div>
                </div>
                <div class="stat-box clickable" data-entity="sensor.${p}_quang_duong_du_kien">
                  <ha-icon icon="mdi:map-marker-distance" style="color: #3b82f6;"></ha-icon>
                  <div class="stat-info"><div class="stat-label">Phạm vi</div><div class="stat-val" id="vf-stat-range">--</div></div>
                </div>
                <div class="stat-box clickable" data-entity="sensor.${p}_hieu_suat_tieu_thu_trung_binh_xe">
                  <ha-icon icon="mdi:leaf" style="color: #10b981;"></ha-icon>
                  <div class="stat-info"><div class="stat-label">Hiệu suất TB</div><div class="stat-val" id="vf-stat-eff">--</div></div>
                </div>
                <div class="stat-box clickable" data-entity="sensor.${p}_dai_toc_do_toi_uu_nhat">
                  <ha-icon icon="mdi:chart-bell-curve" style="color: #f59e0b;"></ha-icon>
                  <div class="stat-info"><div class="stat-label">Tốc độ tối ưu</div><div class="stat-val" id="vf-stat-ideal">--</div></div>
                </div>
                <div class="stat-box clickable" data-entity="sensor.${p}_quang_duong_chuyen_di_trip">
                  <ha-icon icon="mdi:map-marker-path" style="color: #8b5cf6;"></ha-icon>
                  <div class="stat-info"><div class="stat-label">Trip hiện tại</div><div class="stat-val" id="vf-stat-trip">--</div></div>
                </div>
                <div class="stat-box clickable" data-entity="sensor.${p}_dien_nang_tieu_thu_trip">
                  <ha-icon icon="mdi:lightning-bolt" style="color: #eab308;"></ha-icon>
                  <div class="stat-info"><div class="stat-label">Điện năng Trip</div><div class="stat-val" id="vf-stat-energy">--</div></div>
                </div>
              </div>

              <div class="vf-map-container" style="position:relative; border-radius:16px; overflow:hidden; margin-top:10px; border:1px solid #e5e7eb; display:flex; flex-direction:column;">
                <div style="position:absolute; top:12px; left:12px; z-index:400; width: 70%; max-width: 300px;">
                    <select id="trip-selector" style="width:100%; background:rgba(255,255,255,0.95); backdrop-filter:blur(4px); border:2px solid #2563eb; border-radius:8px; padding:8px; font-size:12px; font-weight:bold; color:#1e3a8a; cursor:pointer;"><option value="current">Đang tải...</option></select>
                </div>
                <div id="vf-map-canvas" style="width:100%; height:350px; background:#e5e7eb; z-index:1;"></div>
                <div class="vf-address-bar" id="vf-address-container"><ha-icon icon="mdi:map-marker-radius"></ha-icon><span id="vf-current-address">Đang tải dữ liệu...</span></div>
                <div class="map-controls">
                  <button class="map-btn" id="btn-locate"><ha-icon icon="mdi:crosshairs-gps"></ha-icon></button>
                  <div style="height:1px;background:#ccc;margin:4px 0;"></div>
                  <button class="map-btn" id="btn-stations"><ha-icon icon="mdi:ev-station" style="color:#f59e0b;"></ha-icon></button>
                  <button class="map-btn" id="btn-filter-station" style="font-weight:900; font-size:11px; color:#f59e0b;">ALL</button>
                  <div style="height:1px;background:#ccc;margin:4px 0;"></div>
                  <button class="map-btn" id="btn-replay"><ha-icon id="icon-replay" icon="mdi:play-circle" style="color:#2563eb;"></ha-icon></button>
                </div>
              </div>

            </div>
          </ha-card>
        `;

        const style = document.createElement('style');
        style.textContent = `
          @import url('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
          .vf-card { isolation: isolate; border-radius: 24px; overflow: hidden; background: var(--card-background-color, #ffffff); box-shadow: 0 4px 20px rgba(0,0,0,0.05); font-family: -apple-system, sans-serif;}
          .vf-card-container { padding: 20px; }
          .vf-header { display: flex; justify-content: space-between; margin-bottom: 10px; }
          .vf-title { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 700; color: var(--primary-text-color);} .vf-title svg {width: 24px; color: #2563eb;}
          .vf-odo { text-align: right; } .vf-odo-label {font-size: 10px; font-weight: 800; color: #2563eb;} .vf-odo-value {font-size: 24px; font-weight: 800; color: var(--primary-text-color);}
          .vf-car-stage { position: relative; height: 220px; display: flex; justify-content: center; align-items: center; margin-bottom: 5px;}
          .vf-car-stage img { max-width: 90%; max-height: 100%; filter: drop-shadow(0 20px 20px rgba(0,0,0,0.2)); z-index: 1;}
          .vf-status-badge { position: absolute; top: -10px; right: 0; background: #2563eb; color: white; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: bold; z-index: 5;}
          .vf-tire { position: absolute; background: rgba(255,255,255,0.85); backdrop-filter: blur(8px); padding: 4px 8px; border-radius: 12px; border: 1px solid #e5e7eb; font-size: 11px; font-weight: 800; color: #1f2937; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.05); z-index: 5; }
          .vf-tire ha-icon { --mdc-icon-size: 14px; color: #6b7280; } .tire-unit { font-size: 9px; font-weight: 600; color: #6b7280; }
          .vf-tire-fl { bottom: 10%; left: 0; } .vf-tire-fr { top: 15%; left: 0; } .vf-tire-rl { bottom: 10%; right: 0; } .vf-tire-rr { top: 15%; right: 0; }
          .vf-controls-area { display: flex; justify-content: center; gap: 16px; margin-bottom: 12px; align-items: center;}
          .vf-gears { display: flex; background: rgba(243,244,246,0.8); padding: 8px 20px; border-radius: 30px; gap: 20px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.05);}
          .gear { font-size: 16px; font-weight: 800; color: #9ca3af; transition: all 0.3s; position: relative;} 
          .gear.active {color: #2563eb; transform: scale(1.2);} .gear.active::after { content: ''; position: absolute; bottom: -4px; left: 50%; transform: translateX(-50%); width: 4px; height: 4px; background: #2563eb; border-radius: 50%; }
          .vf-speed { display: flex; align-items: baseline; background: rgba(37,99,235,0.1); border: 2px solid rgba(37,99,235,0.3); padding: 6px 20px; border-radius: 30px;}
          .vf-speed span:first-child { font-size: 28px; font-weight: 900; color: #2563eb; } .vf-speed-unit { font-size: 11px; font-weight: bold; color: #2563eb; margin-left: 4px;}
          .vf-doors-status { display: flex; gap: 8px; justify-content: center; width: 100%; flex-wrap: wrap; margin-bottom: 15px;}
          .door-badge { display: flex; align-items: center; gap: 4px; padding: 4px 12px; border-radius: 12px; font-size: 11px; font-weight: bold; background: rgba(255,255,255,0.95); border: 1px solid #e5e7eb; box-shadow: 0 2px 6px rgba(0,0,0,0.1); color: #374151;}
          .door-badge.open { background: #fee2e2; border-color: #ef4444; color: #b91c1c; animation: pulseRed 1.5s infinite; }
          .door-badge.open.warning { background: #fffbeb; border-color: #f59e0b; color: #d97706; animation: pulseOrange 2s infinite; }
          .door-badge ha-icon { --mdc-icon-size: 15px; }
          @keyframes pulseRed { 0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); } 70% { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); } 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); } }
          @keyframes pulseOrange { 0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.4); } 70% { box-shadow: 0 0 0 6px rgba(245, 158, 11, 0); } 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); } }
          .vf-charging-banner { display: flex; align-items: center; justify-content: space-between; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 12px 18px; border-radius: 14px; margin-bottom: 16px; animation: pulseChargeGlow 2.5s infinite;}
          .charging-title { font-size: 14px; font-weight: 800; display:flex; align-items:center; gap:6px;}
          .charging-details { font-size: 12px; margin-top: 3px; display:flex; align-items:center;}
          .charging-time { font-size: 20px; font-weight: 900; font-family: monospace;}
          @keyframes pulseChargeGlow { 0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.5); } 70% { box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); } 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); } }
          .vf-remote-bar { display: flex; justify-content: center; gap: 15px; margin-bottom: 20px; padding: 10px; background: rgba(243,244,246,0.5); border-radius: 16px;}
          .remote-btn { display: flex; align-items: center; justify-content: center; width: 45px; height: 45px; background: white; border: 1px solid #e5e7eb; border-radius: 50%; color: #4b5563; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.05); transition: all 0.2s ease;}
          .remote-btn ha-icon { --mdc-icon-size: 22px; } .remote-btn:hover { background: #eff6ff; color: #2563eb; transform: translateY(-2px);}
          .vf-stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 20px; }
          .stat-box { display: flex; align-items: center; gap: 8px; background: rgba(243, 244, 246, 0.6); padding: 10px; border-radius: 12px; border: 1px solid rgba(229, 231, 235, 0.8); transition: all 0.2s; overflow: hidden; }
          .stat-box.clickable { cursor: pointer; } .stat-box.clickable:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.08); background: white;}
          .stat-box ha-icon { flex-shrink: 0; --mdc-icon-size: 22px; }
          .stat-info { display: flex; flex-direction: column; min-width: 0; width: 100%; }
          .stat-label { font-size: 10px; font-weight: 700; color: #6b7280; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px;}
          .stat-val { font-size: 15px; font-weight: 800; color: #1f2937; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .stat-unit { font-size: 0.7em; font-weight: 600; color: #6b7280; margin-left: 3px; }
          .vf-address-bar { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 12px; font-size: 13px; font-weight: 600; color: #475569;}
          .vf-address-bar ha-icon { color: #ef4444; animation: bouncePin 2s infinite;}
          @keyframes bouncePin { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
          .map-controls { position: absolute; top: 12px; right: 12px; z-index: 400; display: flex; flex-direction: column; gap: 6px; }
          .map-btn { width: 32px; height: 32px; background: white; border: 1px solid rgba(0,0,0,0.1); border-radius: 6px; cursor: pointer; display:flex; align-items:center; justify-content:center;}
        `;
        this.appendChild(style);
        this.content = true;

        this.querySelectorAll('.stat-box.clickable').forEach(box => {
            box.addEventListener('click', () => {
                const entityId = box.getAttribute('data-entity');
                if (entityId && this._hass.states[entityId]) {
                    const event = new Event('hass-more-info', { bubbles: true, composed: true });
                    event.detail = { entityId: entityId };
                    this.dispatchEvent(event);
                }
            });
        });

        this.querySelector('#btn-locate').addEventListener('click', () => { 
          if(this._map && this._lastLat) this._map.setView([this._lastLat, this._lastLon], 15, {animate: true});
        });

        this.querySelector('#btn-stations').addEventListener('click', () => {
          this._hass.callService('button', 'press', { entity_id: `button.${p}_tim_tram_sac` });
        });
        
        const btnFilter = this.querySelector('#btn-filter-station');
        btnFilter.addEventListener('click', () => {
            if (this._stationFilter === 'ALL') { this._stationFilter = 'DC'; btnFilter.innerText = 'DC'; btnFilter.style.color = '#dc2626'; }
            else if (this._stationFilter === 'DC') { this._stationFilter = 'AC'; btnFilter.innerText = 'AC'; btnFilter.style.color = '#16a34a'; }
            else { this._stationFilter = 'ALL'; btnFilter.innerText = 'ALL'; btnFilter.style.color = '#f59e0b'; }
            this.renderStations();
        });

        const callServiceBtn = (btnId, domain, service, entityId) => {
            const btn = this.querySelector(btnId);
            if(btn) btn.addEventListener('click', () => {
                if(this._hass.states[entityId]) this._hass.callService(domain, service, { entity_id: entityId });
            });
        };
        callServiceBtn('#btn-rc-lock', 'button', 'press', `button.${p}_khoa_cua`);
        callServiceBtn('#btn-rc-unlock', 'button', 'press', `button.${p}_mo_cua`);
        callServiceBtn('#btn-rc-horn', 'button', 'press', `button.${p}_bam_coi`);
        callServiceBtn('#btn-rc-lights', 'button', 'press', `button.${p}_nhay_den`);

        const selectEl = this.querySelector('#trip-selector');
        selectEl.addEventListener('change', (e) => {
            const val = e.target.value;
            let rawPoints = [];
            if (val === "current") {
                const rs = this._hass.states[`sensor.${p}_lo_trinh_gps`];
                if (rs && rs.attributes && rs.attributes.route_points) {
                    try { rawPoints = typeof rs.attributes.route_points === 'string' ? JSON.parse(rs.attributes.route_points) : rs.attributes.route_points; } catch(e){}
                }
            } else {
                rawPoints = this._tripHistory[parseInt(val)]?.route || [];
            }
            this._selectedRouteCoords = this.cleanRouteData(rawPoints);
            this._currentPolylineString = JSON.stringify(this._selectedRouteCoords);
            
            if(this._polyline) {
                this._polyline.setLatLngs(this._selectedRouteCoords);
                if (this._selectedRouteCoords.length > 1) this._map.fitBounds(this._polyline.getBounds(), {padding: [30, 30]});
            }
        });

        const btnReplay = this.querySelector('#btn-replay');
        const iconReplay = this.querySelector('#icon-replay');
        
        btnReplay.addEventListener('click', () => {
            if (!this._map || !this._marker || !this._polyline) return;
            if (this._selectedRouteCoords.length < 2) return alert("Lộ trình quá ngắn!");

            if (this._isReplaying) {
                clearInterval(this._replayTimer);
                this._isReplaying = false;
                iconReplay.setAttribute('icon', 'mdi:play-circle');
                if(this._lastLat) this._map.setView([this._lastLat, this._lastLon], 15);
            } else {
                this._isReplaying = true;
                iconReplay.setAttribute('icon', 'mdi:stop-circle');
                
                let currentIdx = 0;
                this._replayTimer = setInterval(() => {
                    if (currentIdx >= this._selectedRouteCoords.length) {
                        clearInterval(this._replayTimer);
                        this._isReplaying = false;
                        iconReplay.setAttribute('icon', 'mdi:play-circle');
                        return;
                    }
                    const pt = this._selectedRouteCoords[currentIdx];
                    if (pt && pt.length >= 2) {
                        let angle = 0;
                        if (currentIdx < this._selectedRouteCoords.length - 1) {
                            angle = this.getBearing(pt[0], pt[1], this._selectedRouteCoords[currentIdx + 1][0], this._selectedRouteCoords[currentIdx + 1][1]);
                        } else if (currentIdx > 0) {
                            angle = this.getBearing(this._selectedRouteCoords[currentIdx - 1][0], this._selectedRouteCoords[currentIdx - 1][1], pt[0], pt[1]);
                        }
                        
                        const simGear = pt.length > 3 ? pt[3] : 4;
                        if (simGear == 2) angle = (angle + 180) % 360;

                        this._marker.setLatLng([pt[0], pt[1]]);
                        this._map.panTo([pt[0], pt[1]], { animate: true, duration: 0.25 });

                        const iconEl = this._marker.getElement();
                        if (iconEl) {
                            const svg = iconEl.querySelector('.car-dir-svg');
                            if (svg) svg.style.transform = `rotate(${angle}deg)`;
                            
                            const badge = iconEl.querySelector('.car-speed-badge');
                            if (badge) {
                                badge.style.display = pt.length > 2 ? 'block' : 'none';
                                badge.innerText = pt.length > 2 ? `${pt[2]} km/h` : '';
                            }
                        }
                    }
                    currentIdx++;
                }, 250); 
            }
        });
      }

      const name = getValidState(`sensor.${p}_ten_dinh_danh_xe`) || 'Xe VinFast';
      const statusObj = hass.states[`sensor.${p}_trang_thai_hoat_dong`];
      let statusTextRaw = statusObj ? statusObj.state : 'N/A';
      let statusText = statusTextRaw;
      
      if (statusObj && statusObj.last_changed) {
          statusText += ` ${formatTimeSince(statusObj.last_changed)}`;
      }
      
      const gear = getValidState(`sensor.${p}_vi_tri_can_so`) || 'P';
      const speed = getValidState(`sensor.${p}_toc_do_hien_tai`) || '0';
      
      this.querySelector('#vf-name').innerText = name;
      this.querySelector('#vf-status-badge').innerText = statusText;
      
      const odoRaw = getValidState(`sensor.${p}_tong_odo`);
      this.querySelector('#vf-odo-int').innerText = (odoRaw && !isNaN(odoRaw)) ? Math.floor(parseFloat(odoRaw)).toString() : '--';

      let rawImage = getValidState(`sensor.${p}_hinh_anh_xe_url`);
      const imgEl = this.querySelector('#vf-car-img');
      if (imgEl && rawImage && rawImage !== 'unknown') imgEl.src = rawImage;

      const updateTire = (id, val) => {
        const el = this.querySelector(id);
        if(el) {
          if (val !== null && val !== 'unknown' && val !== '') { el.style.display = 'block'; el.querySelector('span').innerText = val; }
          else { el.style.display = 'none'; }
        }
      };
      updateTire('#tire-fl', getValidState(`sensor.${p}_ap_suat_lop_truoc_trai`)); 
      updateTire('#tire-fr', getValidState(`sensor.${p}_ap_suat_lop_truoc_phai`)); 
      updateTire('#tire-rl', getValidState(`sensor.${p}_ap_suat_lop_sau_trai`)); 
      updateTire('#tire-rr', getValidState(`sensor.${p}_ap_suat_lop_sau_phai`));

      ['P','R','N','D'].forEach(g => {
        const el = this.querySelector(`#gear-${g}`);
        if(el) { if (gear.includes(g)) el.classList.add('active'); else el.classList.remove('active'); }
      });
      
      const speedEl = this.querySelector('#vf-speed-container');
      if (!this._isReplaying && speedEl) {
          if (gear.includes('P') || Math.round(Number(speed)) === 0) speedEl.style.display = 'none';
          else { speedEl.style.display = 'flex'; this.querySelector('#vf-speed').innerText = Math.round(Number(speed)); }
      }

      const checkSensorState = (slugs, targetState) => {
          for (let s of slugs) {
              const state = getValidState(`sensor.${p}_${s}`);
              if (state && state.toLowerCase() === targetState.toLowerCase()) return true;
          }
          return false;
      };

      const doorsConfig = [
          { slugs: ['cua_truoc_trai', 'cua_tai_xe'], name: 'Cửa lái', icon: 'mdi:car-door' },
          { slugs: ['cua_truoc_phai', 'cua_phu'], name: 'Cửa phụ', icon: 'mdi:car-door' },
          { slugs: ['cua_sau_trai'], name: 'Cửa sau T', icon: 'mdi:car-door' },
          { slugs: ['cua_sau_phai'], name: 'Cửa sau P', icon: 'mdi:car-door' },
          { slugs: ['cop_sau'], name: 'Cốp sau', icon: 'mdi:car-back' },
          { slugs: ['nap_capo', 'capo'], name: 'Capo', icon: 'mdi:car' },
          { slugs: ['cua_so_tai_xe', 'cua_so_truoc_trai'], name: 'Kính lái', icon: 'mdi:window-open' }
      ];

      const openDoors = doorsConfig.filter(d => checkSensorState(d.slugs, 'mở'));
      const isParked = statusTextRaw.toLowerCase().includes('đỗ') || gear.includes('P');
      const isUnlocked = checkSensorState(['khoa_tong', 'khoa_cua'], 'mở khóa');
      
      let hasSystemError = false;
      for (let s of ['canh_bao_loi', 'trang_thai_loi', 'loi_he_thong']) {
          const state = getValidState(`sensor.${p}_${s}`);
          if (state && state.toLowerCase() !== 'bình thường' && state.toLowerCase() !== 'khong' && state !== '0' && state !== 'unknown') {
              hasSystemError = state; break;
          }
      }

      const doorsEl = this.querySelector('#vf-doors-container');
      if (doorsEl) {
          let securityHtml = '';
          if (openDoors.length === 0 && (!isParked || !isUnlocked) && !hasSystemError) {
              securityHtml = `<div class="door-badge" style="color: #10b981; border-color: rgba(16, 185, 129, 0.3); background: rgba(255,255,255,0.7);"><ha-icon icon="mdi:shield-check-outline"></ha-icon> An toàn</div>`;
          } else {
              if (hasSystemError) securityHtml += `<div class="door-badge open" style="background: #fef2f2; border-color: #ef4444; color: #b91c1c;"><ha-icon icon="mdi:alert"></ha-icon> Lỗi: ${hasSystemError}</div>`;
              if (openDoors.length > 0) securityHtml += openDoors.map(d => `<div class="door-badge open"><ha-icon icon="${d.icon}"></ha-icon> ${d.name}</div>`).join('');
              if (isParked && isUnlocked) securityHtml += `<div class="door-badge open warning"><ha-icon icon="mdi:lock-open-alert"></ha-icon> Chưa khóa xe</div>`;
          }
          doorsEl.innerHTML = securityHtml;
      }

      const chargingBanner = this.querySelector('#vf-charging-banner');
      const isCharging = statusTextRaw && statusTextRaw.toLowerCase().includes('sạc');
      
      if (isCharging && chargingBanner) {
          chargingBanner.style.display = 'flex';
          let targetSensor = getValidState(`sensor.${p}_gioi_han_sac_muc_tieu`);
          let chargeLimit = (targetSensor && targetSensor !== 'unknown') ? targetSensor : '100';
          const chargeTimeRemain = getValidState(`sensor.${p}_thoi_gian_sac_con_lai`);
          
          this.querySelector('#vf-charge-limit').innerText = `${chargeLimit}%`;
          this.querySelector('#vf-charge-time').innerText = (chargeTimeRemain && chargeTimeRemain !== 'unknown') ? `${chargeTimeRemain} phút` : '--';
          
          if (!this._powerFetchTimer) {
              this.fetchBackendState(vinStr);
              this._powerFetchTimer = setInterval(() => this.fetchBackendState(vinStr), 10000);
          } else {
              const powerEl = this.querySelector('#vf-charge-power');
              if (powerEl && this._backendData.api_live_charge_power !== undefined) {
                  let pwr = this._backendData.api_live_charge_power;
                  powerEl.innerText = pwr > 0 ? `${pwr} kW` : 'Đang tính...';
              }
          }
      } else if (chargingBanner) {
          chargingBanner.style.display = 'none';
          if (this._powerFetchTimer) { clearInterval(this._powerFetchTimer); this._powerFetchTimer = null; }
      }

      const batt = getValidState(`sensor.${p}_phan_tram_pin`);
      const range = getValidState(`sensor.${p}_quang_duong_du_kien`);
      const eff = getValidState(`sensor.${p}_hieu_suat_tieu_thu_trung_binh_xe`);
      const trip = getValidState(`sensor.${p}_quang_duong_chuyen_di_trip`);
      const energy = getValidState(`sensor.${p}_dien_nang_tieu_thu_trip`);

      const renderStat = (id, val, unit) => {
          const el = this.querySelector(id);
          if(el) {
              if (val && val !== 'unknown' && val !== '--' && val !== '0') {
                  el.innerHTML = `${val}<span class="stat-unit">${unit}</span>`;
              } else {
                  el.innerHTML = '--';
              }
          }
      };

      renderStat('#vf-stat-batt', batt, '%');
      renderStat('#vf-stat-range', range, 'km');
      renderStat('#vf-stat-eff', eff, 'kWh/100km');
      renderStat('#vf-stat-trip', trip, 'km');
      renderStat('#vf-stat-energy', energy, 'kWh');

      const ideal = getValidState(`sensor.${p}_dai_toc_do_toi_uu_nhat`);
      const idealEl = this.querySelector('#vf-stat-ideal');
      if (idealEl) {
          if (ideal && ideal !== 'unknown' && ideal !== '--' && ideal !== '') {
              let mainSpd = ideal.split(' (')[0].replace(' km/h', '');
              let subText = ideal.includes('(') ? ideal.split('(')[1].replace(')', '') : '';
              idealEl.innerHTML = `${mainSpd}<span class="stat-unit">km/h</span><div style="font-size:9px; color:#9ca3af; font-weight:600; margin-top:2px; line-height:1;">${subText}</div>`;
          } else {
              idealEl.innerHTML = `--`;
          }
      }

      const tracker = hass.states[`device_tracker.${p}_vi_tri_gps`];
      const lat = tracker?.attributes?.latitude;
      const lon = tracker?.attributes?.longitude;
      
      const addressEl = this.querySelector('#vf-current-address');
      if (addressEl) {
          let backendAddr = this._backendData.api_current_address;
          let sensorAddress = getValidState(`sensor.${p}_dia_chi_hien_tai`) || getValidState(`sensor.${p}_vi_tri_xe`);

          let finalAddr = (backendAddr && !backendAddr.includes("Đang tải")) ? backendAddr : (sensorAddress && sensorAddress !== 'unknown' ? sensorAddress : null);

          if (finalAddr) {
               addressEl.innerText = finalAddr;
          } else if (lat && lon) {
              addressEl.innerText = `Tọa độ: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
          } else {
              addressEl.innerText = "Không có tín hiệu GPS";
          }
      }

      if (this._map && lat && lon && typeof L !== 'undefined') {
        if (!this._isReplaying) {
            if (this._marker) {
                this._marker.setOpacity(1); 
                this._marker.setLatLng([lat, lon]);
            }
            if (this._lastLat === null) {
                this._map.setView([lat, lon], 15);
            }
            this._lastLat = lat; this._lastLon = lon;
            
            const selectEl = this.querySelector('#trip-selector');
            if (selectEl && selectEl.value === "current") {
                const routeSensor = hass.states[`sensor.${p}_lo_trinh_gps`];
                if (routeSensor && routeSensor.attributes && routeSensor.attributes.route_points && this._polyline) {
                    try { 
                        const newRouteStr = typeof routeSensor.attributes.route_points === 'string' ? routeSensor.attributes.route_points : JSON.stringify(routeSensor.attributes.route_points);
                        if (this._currentPolylineString !== newRouteStr) {
                            this._currentPolylineString = newRouteStr;
                            this._selectedRouteCoords = this.cleanRouteData(JSON.parse(newRouteStr));
                            this._polyline.setLatLngs(this._selectedRouteCoords);
                        }
                    } catch(e) { }
                }
            }
        }

        const stationSensor = hass.states[`sensor.${p}_tram_sac_lan_can`];
        if (stationSensor && stationSensor.attributes && stationSensor.attributes.stations) {
            try {
                let newStations = typeof stationSensor.attributes.stations === 'string' ? JSON.parse(stationSensor.attributes.stations) : stationSensor.attributes.stations;
                if (Array.isArray(newStations) && this._currentStations.length !== newStations.length) {
                    this._currentStations = newStations;
                    this.renderStations();
                }
            } catch(e) {}
        }
      }
    } catch (error) {
        console.error("VinFast Card Crash:", error);
        this.innerHTML = `<ha-card style="padding: 20px; color: red;"><b>Lỗi JavaScript Giao Diện:</b><br><pre style="white-space: pre-wrap; font-size: 11px; margin-top:10px;">${error.stack || error.message}</pre></ha-card>`;
    }
  }
  
  getCardSize() { return 8; }
}

if (!customElements.get('vinfast-digital-twin')) {
    customElements.define('vinfast-digital-twin', VinFastDigitalTwin);
}
