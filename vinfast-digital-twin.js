class VinFastDigitalTwin extends HTMLElement {
  setConfig(config) {
    if (!config.entity_prefix) throw new Error('Cần khai báo entity_prefix');
    this.config = config;
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
  }

  loadLeaflet() {
    if (this._leafletLoaded) return;
    this._leafletLoaded = true;
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => { setTimeout(() => this.initMap(), 500); };
    document.head.appendChild(script);
  }

  async fetchTripHistory(vin) {
    if (!vin) return;
    try {
        const res = await fetch(`/local/vinfast_trips_${vin.toLowerCase()}.json?v=${new Date().getTime()}`);
        if (res.ok) {
            this._tripHistory = await res.json();
            this.renderTripSelector();
        } else {
            this.renderEmptyTripSelector();
        }
    } catch(e) { 
        this.renderEmptyTripSelector();
    }
  }

  renderEmptyTripSelector() {
      const selectEl = this.querySelector('#trip-selector');
      if (selectEl) {
          selectEl.innerHTML = `<option value="current">📍 Đang ghi Trip (Chưa có Log cũ)</option>`;
      }
  }

  renderTripSelector() {
      const selectEl = this.querySelector('#trip-selector');
      if (!selectEl || this._tripHistory.length === 0) {
          this.renderEmptyTripSelector();
          return;
      }
      
      let options = `<option value="current">📍 Chuyến đi hiện tại</option>`;
      this._tripHistory.forEach((trip, index) => {
          let shortStart = trip.start_address.split(',')[0].substring(0, 15);
          options += `<option value="${index}">🗓 ${trip.date} ${trip.start_time} - ${trip.distance}km (${shortStart}...)</option>`;
      });
      selectEl.innerHTML = options;
  }

  getBearing(startLat, startLng, destLat, destLng) {
      startLat = startLat * Math.PI / 180;
      startLng = startLng * Math.PI / 180;
      destLat = destLat * Math.PI / 180;
      destLng = destLng * Math.PI / 180;
      const y = Math.sin(destLng - startLng) * Math.cos(destLat);
      const x = Math.cos(startLat) * Math.sin(destLat) - Math.sin(startLat) * Math.cos(destLat) * Math.cos(destLng - startLng);
      let brng = Math.atan2(y, x);
      brng = brng * 180 / Math.PI;
      return (brng + 360) % 360;
  }

  getCarIcon(angle = 0, speed = null) {
      const arrowSvg = `<svg viewBox="0 0 24 24" fill="#2563eb" stroke="white" stroke-width="2" style="transform: rotate(${angle}deg); width: 28px; height: 28px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));"><path d="M12 2L22 20L12 17L2 20L12 2Z"/></svg>`;
      let speedBadge = '';
      if (speed !== null) {
          speedBadge = `<div style="position:absolute; top:-25px; left:50%; transform:translateX(-50%); background:#10b981; color:white; padding:2px 6px; border-radius:4px; font-size:11px; font-weight:bold; border:1px solid white; white-space:nowrap; box-shadow:0 2px 4px rgba(0,0,0,0.3); z-index:1001;">${speed} km/h</div>`;
      }
      return L.divIcon({ className: 'custom-directional-car', html: `<div style="position:relative; width:28px; height:28px;">${speedBadge}${arrowSvg}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
  }

  renderStations() {
      if (!this._stationLayer || !this._map) return;
      this._stationLayer.clearLayers();
      const stations = this._currentStations;
      let countRendered = 0;

      stations.forEach(st => {
          const isDC = st.power >= 30;
          if (this._stationFilter === 'DC' && !isDC) return;
          if (this._stationFilter === 'AC' && isDC) return;

          if (st.lat && st.lng) {
              countRendered++;
              const color = isDC ? '#dc2626' : '#16a34a'; 
              const iconName = isDC ? 'mdi:ev-plug-ccs2' : 'mdi:ev-plug-type2';

              const stationIcon = L.divIcon({ 
                  className: 'station-icon', 
                  html: `<ha-icon icon="${iconName}" style="--mdc-icon-size: 16px; color: white;"></ha-icon>`, 
                  iconSize: [28, 28], iconAnchor: [14, 14] 
              });
              
              stationIcon.createIcon = function (oldIcon) {
                  const div = L.DivIcon.prototype.createIcon.call(this, oldIcon);
                  div.style.backgroundColor = color; div.style.borderColor = 'white'; div.style.borderWidth = '2px'; div.style.borderStyle = 'solid'; div.style.borderRadius = '50%'; div.style.boxShadow = '0 3px 6px rgba(0,0,0,0.3)';
                  return div;
              };

              const popupHtml = `<div class="station-popup"><h3 style="margin-bottom:8px;">${st.name}</h3><p>🚗 Cách xe: <b>${st.dist.toFixed(1)} km</b></p><p style="color:${color}">⚡ C.Suất: <b>${st.power} kW (${isDC?'Nhanh DC':'Thường AC'})</b></p><p style="color:#16a34a">🔌 Trụ trống: <b>${st.avail} / ${st.total}</b></p></div>`;
              L.marker([st.lat, st.lng], {icon: stationIcon}).bindPopup(popupHtml).addTo(this._stationLayer);
          }
      });

      if (countRendered > 0 && this._stationLayer.getLayers().length > 0) {
          const group = new L.featureGroup([this._marker, ...this._stationLayer.getLayers()]);
          this._map.fitBounds(group.getBounds(), {padding: [30, 30], maxZoom: 16});
      }
  }

  initMap() {
    const mapEl = this.querySelector('#vf-map-canvas');
    if (!mapEl || typeof L === 'undefined') return;
    this._map = L.map(mapEl, { zoomControl: false, dragging: true, scrollWheelZoom: true, attributionControl: false }).setView([21.0285, 105.8542], 15);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(this._map);
    this._marker = L.marker([21.0285, 105.8542], {icon: this.getCarIcon(0, null)}).addTo(this._map);
    this._polyline = L.polyline([], {color: '#2563eb', weight: 4, opacity: 0.8}).addTo(this._map);
    this._stationLayer = L.layerGroup().addTo(this._map);

    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && this._map) { setTimeout(() => this._map.invalidateSize(), 100); }
    });
    observer.observe(mapEl);
  }

  // HÀM TÍNH TOÁN THỜI GIAN TRÔI QUA (TIME AGO)
  getTimeSince(dateString) {
      if (!dateString) return "";
      const date = new Date(dateString);
      const seconds = Math.floor((new Date() - date) / 1000);
      
      if (seconds < 60) return "vừa xong";
      
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes} phút trước`;
      
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} giờ trước`;
      
      const days = Math.floor(hours / 24);
      return `${days} ngày trước`;
  }

  set hass(hass) {
    this._hass = hass;
    const p = this.config.entity_prefix;

    const getValidState = (entityId) => {
      const stateObj = hass.states[entityId];
      if (!stateObj || stateObj.state === 'unavailable' || stateObj.state === 'unknown' || stateObj.state === '') return null;
      return stateObj.state;
    };

    if (!this.content) {
      this.loadLeaflet();
      const vinStr = p.split('_')[1];
      this.fetchTripHistory(vinStr);

      this.innerHTML = `
        <ha-card class="vf-card">
          <div class="vf-card-container">
            <div class="vf-header">
              <div class="vf-title">
                <svg viewBox="0 0 512 512" fill="currentColor"><path d="M560 3586 c-132 -28 -185 -75 -359 -321 -208 -291 -201 -268 -201 -701 0 -361 3 -383 69 -470 58 -77 133 -109 311 -134 202 -29 185 -21 199 -84 14 -62 66 -155 119 -209 110 -113 277 -165 430 -133 141 29 269 125 328 246 l29 59 1115 0 1115 0 29 -59 c60 -123 201 -226 345 -250 253 -43 499 137 543 397 34 203 -77 409 -268 500 -69 33 -89 38 -172 41 -116 5 -198 -15 -280 -67 -116 -76 -195 -193 -214 -321 -6 -36 -12 -71 -14 -77 -5 -19 -2163 -19 -2168 0 -2 6 -8 41 -14 77 -19 128 -98 245 -214 321 -82 52 -164 72 -280 67 -82 -3 -103 -8 -168 -40 -41 -19 -94 -52 -117 -72 -55 -48 -115 -139 -137 -209 -21 -68 -13 -66 -196 -37 -69 11 -128 20 -132 20 -17 0 -82 67 -94 97 -10 23 -14 86 -14 228 l0 195 60 0 c48 0 63 4 80 22 22 24 26 58 10 88 -12 22 -61 40 -111 40 l-39 0 0 43 c1 23 9 65 18 93 20 58 264 406 317 453 43 37 120 61 198 61 52 0 58 -2 53 -17 -4 -10 -48 -89 -98 -177 -70 -122 -92 -170 -95 -205 -5 -56 19 -106 67 -138 l33 -23 1511 0 c867 0 1583 -4 1680 -10 308 -18 581 -60 788 -121 109 -32 268 -103 268 -119 0 -6 -27 -10 -60 -10 -68 0 -100 -21 -100 -66 0 -63 40 -84 161 -84 l79 0 0 -214 c0 -200 -1 -215 -20 -239 -13 -16 -35 -29 -58 -33 -88 -16 -113 -102 -41 -140 81 -41 228 49 259 160 8 29 11 119 8 292 l-3 249 -32 67 c-45 96 -101 152 -197 197 -235 112 -604 187 -1027 209 l-156 9 -319 203 c-176 112 -359 223 -409 246 -116 56 -239 91 -366 104 -149 15 -1977 12 -2049 -4z m800 -341 l0 -205 -335 0 -336 0 12 23 c7 12 59 104 116 205 l105 182 219 0 219 0 0 -205z m842 15 c14 -102 27 -193 27 -202 1 -17 -23 -18 -359 -18 l-360 0 0 198 c0 109 3 202 7 205 4 4 153 6 332 5 l326 -3 27 -185z m528 157 c52 -14 125 -38 161 -55 54 -24 351 -206 489 -299 l35 -23 -516 0 -516 0 -26 188 c-15 103 -27 196 -27 206 0 18 7 19 153 13 112 -5 177 -12 247 -30z m-1541 -1132 c115 -63 176 -174 169 -305 -16 -272 -334 -402 -541 -221 -20 18 -51 63 -69 99 -28 57 -33 77 -33 142 0 65 5 85 33 142 37 76 93 128 169 159 75 30 200 23 272 -16z m3091 16 c110 -42 192 -149 207 -269 18 -159 -101 -319 -264 -352 -134 -28 -285 47 -350 174 -37 72 -43 180 -14 257 35 91 107 162 200 195 55 20 162 17 221 -5z"></path></svg>
                <span id="vf-name"></span>
              </div>
              <div class="vf-odo">
                <div class="vf-odo-label">ODOMETER</div>
                <div class="vf-odo-value"><span id="vf-odo-int"></span> <span class="vf-odo-unit" style="font-size:12px; color:#9ca3af;">km</span></div>
              </div>
            </div>

            <div class="vf-car-stage">
              <div id="vf-status-badge" class="vf-status-badge"></div>
              <img id="vf-car-img" src="" alt="VinFast Car">
              
              <div class="vf-tire vf-tire-fl" id="tire-fl" style="display:none;"><ha-icon icon="mdi:tire"></ha-icon><br><span></span> <span class="tire-unit">bar</span></div>
              <div class="vf-tire vf-tire-fr" id="tire-fr" style="display:none;"><ha-icon icon="mdi:tire"></ha-icon><br><span></span> <span class="tire-unit">bar</span></div>
              <div class="vf-tire vf-tire-rl" id="tire-rl" style="display:none;"><ha-icon icon="mdi:tire"></ha-icon><br><span></span> <span class="tire-unit">bar</span></div>
              <div class="vf-tire vf-tire-rr" id="tire-rr" style="display:none;"><ha-icon icon="mdi:tire"></ha-icon><br><span></span> <span class="tire-unit">bar</span></div>
            </div>

            <div class="vf-controls-area">
              <div class="vf-gears">
                <span class="gear" id="gear-P">P</span>
                <span class="gear" id="gear-R">R</span>
                <span class="gear" id="gear-N">N</span>
                <span class="gear" id="gear-D">D</span>
              </div>
              <div class="vf-speed" id="vf-speed-container">
                <span id="vf-speed"></span> <span class="vf-speed-unit">km/h</span>
              </div>
            </div>

            <div class="vf-doors-status" id="vf-doors-container"></div>

            <div class="vf-remote-bar" id="vf-remote-controls" style="display: none;">
                <div class="remote-btn" id="btn-rc-lock" title="Khóa cửa"><ha-icon icon="mdi:lock"></ha-icon></div>
                <div class="remote-btn" id="btn-rc-unlock" title="Mở cửa"><ha-icon icon="mdi:lock-open"></ha-icon></div>
                <div class="remote-btn" id="btn-rc-horn" title="Bấm còi"><ha-icon icon="mdi:bullhorn"></ha-icon></div>
                <div class="remote-btn" id="btn-rc-lights" title="Nháy đèn"><ha-icon icon="mdi:car-light-high"></ha-icon></div>
            </div>

            <div class="vf-stats-grid">
              <div class="stat-box clickable" data-entity="sensor.${p}_phan_tram_pin">
                <ha-icon icon="mdi:battery-charging-60" style="color: #10b981;"></ha-icon>
                <div class="stat-info">
                    <div class="stat-label" title="Mức Pin">Mức Pin</div>
                    <div class="stat-val" id="vf-stat-batt">--</div>
                </div>
              </div>
              <div class="stat-box clickable" data-entity="sensor.${p}_quang_duong_du_kien">
                <ha-icon icon="mdi:map-marker-distance" style="color: #3b82f6;"></ha-icon>
                <div class="stat-info">
                    <div class="stat-label" title="Phạm vi">Phạm vi</div>
                    <div class="stat-val" id="vf-stat-range">--</div>
                </div>
              </div>
              <div class="stat-box clickable" data-entity="sensor.${p}_hieu_suat_tieu_thu_trung_binh_xe">
                <ha-icon icon="mdi:leaf" style="color: #10b981;"></ha-icon>
                <div class="stat-info">
                    <div class="stat-label" title="Hiệu suất TB">Hiệu suất TB</div>
                    <div class="stat-val" id="vf-stat-eff">--</div>
                </div>
              </div>
              <div class="stat-box clickable" data-entity="sensor.${p}_dai_toc_do_toi_uu_nhat">
                <ha-icon icon="mdi:chart-bell-curve" style="color: #f59e0b;"></ha-icon>
                <div class="stat-info">
                    <div class="stat-label" title="Tốc độ tối ưu">Tốc độ tối ưu</div>
                    <div class="stat-val" id="vf-stat-ideal">--</div>
                </div>
              </div>
              <div class="stat-box clickable" data-entity="sensor.${p}_quang_duong_chuyen_di_trip">
                <ha-icon icon="mdi:map-marker-path" style="color: #8b5cf6;"></ha-icon>
                <div class="stat-info">
                    <div class="stat-label" title="Trip hiện tại">Trip hiện tại</div>
                    <div class="stat-val" id="vf-stat-trip">--</div>
                </div>
              </div>
              <div class="stat-box clickable" data-entity="sensor.${p}_dien_nang_tieu_thu_trip">
                <ha-icon icon="mdi:lightning-bolt" style="color: #eab308;"></ha-icon>
                <div class="stat-info">
                    <div class="stat-label" title="Điện năng Trip">Điện năng Trip</div>
                    <div class="stat-val" id="vf-stat-energy">--</div>
                </div>
              </div>
            </div>

            <div class="vf-map-container" style="position:relative; border-radius:16px; overflow:hidden; margin-top:10px; border:1px solid #e5e7eb;">
              <div style="position:absolute; top:12px; left:12px; z-index:400; width: 70%; max-width: 300px;">
                  <select id="trip-selector" style="width: 100%; background:rgba(255,255,255,0.95); backdrop-filter:blur(4px); border:2px solid #2563eb; border-radius:8px; padding:8px 10px; font-size:12px; font-weight:600; color:#1e3a8a; box-shadow:0 4px 10px rgba(0,0,0,0.2); outline:none; cursor:pointer;">
                    <option value="current">Đang tải lịch sử...</option>
                  </select>
              </div>

              <div id="vf-map-canvas" style="width: 100%; height: 350px; background: #e5e7eb; z-index: 1;"></div>
              
              <div class="map-controls">
                <button class="map-btn" id="btn-zoom-in" title="Phóng to"><ha-icon icon="mdi:plus"></ha-icon></button>
                <button class="map-btn" id="btn-zoom-out" title="Thu nhỏ"><ha-icon icon="mdi:minus"></ha-icon></button>
                <button class="map-btn" id="btn-locate" title="Vị trí xe"><ha-icon icon="mdi:crosshairs-gps"></ha-icon></button>
                <div style="height: 1px; background:#ccc; margin: 4px 0;"></div>
                <button class="map-btn" id="btn-stations" title="Tìm trạm sạc"><ha-icon icon="mdi:ev-station" style="color: #f59e0b;"></ha-icon></button>
                <button class="map-btn" id="btn-filter-station" title="Lọc trạm sạc" style="font-weight:900; font-size:11px; color:#f59e0b; font-family:sans-serif;">ALL</button>
                <div style="height: 1px; background:#ccc; margin: 4px 0;"></div>
                <button class="map-btn" id="btn-replay" title="Mô phỏng chuyến đi" style="border-color:#2563eb; background:#eff6ff;"><ha-icon id="icon-replay" icon="mdi:play-circle" style="color: #2563eb;"></ha-icon></button>
              </div>
            </div>
          </div>
        </ha-card>
      `;

      const style = document.createElement('style');
      style.textContent = `
        @import url('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
        .vf-card { isolation: isolate; border-radius: 24px; overflow: hidden; background: var(--card-background-color, #ffffff); box-shadow: 0 4px 20px rgba(0,0,0,0.05); }
        .vf-card-container { padding: 20px; font-family: var(--primary-font-family, -apple-system, sans-serif); position: relative; z-index: 1; }
        .vf-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
        .vf-title { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 700; color: var(--primary-text-color); }
        .vf-title svg { width: 24px; height: 24px; color: #2563eb; }
        .vf-odo { text-align: right; }
        .vf-odo-label { font-size: 10px; font-weight: 800; color: #2563eb; letter-spacing: 1px; }
        .vf-odo-value { font-size: 24px; font-weight: 800; font-family: monospace; color: var(--primary-text-color); }
        
        .vf-car-stage { position: relative; width: 100%; height: 220px; display: flex; justify-content: center; align-items: center; margin-bottom: 5px; }
        .vf-car-stage img { max-width: 90%; max-height: 100%; object-fit: contain; filter: drop-shadow(0 20px 20px rgba(0,0,0,0.2)); z-index: 1; }
        .vf-status-badge { position: absolute; top: -10px; right: 0; background: #2563eb; color: white; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: bold; z-index: 5;}
        
        /* Cảm biến lốp */
        .vf-tire { position: absolute; background: rgba(255,255,255,0.85); backdrop-filter: blur(8px); padding: 4px 8px; border-radius: 12px; border: 1px solid #e5e7eb; font-size: 11px; font-weight: 800; color: #1f2937; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.05); z-index: 5; }
        .vf-tire ha-icon { --mdc-icon-size: 14px; color: #6b7280; }
        .tire-unit { font-size: 9px; font-weight: 600; color: #6b7280; }
        .vf-tire-fl { bottom: 10%; left: 0; } .vf-tire-fr { top: 15%; left: 0; } .vf-tire-rl { bottom: 10%; right: 0; } .vf-tire-rr { top: 15%; right: 0; }

        /* CẦN SỐ VÀ TỐC ĐỘ */
        .vf-controls-area { display: flex; justify-content: center; gap: 16px; align-items: center; margin-bottom: 12px; }
        .vf-gears { display: flex; background: rgba(243,244,246,0.8); padding: 8px 20px; border-radius: 30px; gap: 20px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.05); }
        .gear { font-size: 16px; font-weight: 800; color: #9ca3af; transition: all 0.3s; position: relative; }
        .gear.active { color: #2563eb; transform: scale(1.2); }
        .gear.active::after { content: ''; position: absolute; bottom: -4px; left: 50%; transform: translateX(-50%); width: 4px; height: 4px; background: #2563eb; border-radius: 50%; }
        
        .vf-speed { display: flex; align-items: baseline; background: rgba(37,99,235,0.1); border: 2px solid rgba(37,99,235,0.3); padding: 6px 20px; border-radius: 30px; transition: all 0.3s ease;}
        .vf-speed span:first-child { font-size: 28px; font-weight: 900; color: #2563eb; line-height: 1; }
        .vf-speed-unit { font-size: 11px; font-weight: bold; color: #2563eb; margin-left: 4px; text-transform: uppercase; }
        .vf-speed.replaying { background: rgba(16, 185, 129, 0.1); border-color: #10b981; }
        .vf-speed.replaying span { color: #10b981; }
        
        /* CỬA VÀ CỐP (DẠNG BLOCK TIÊU CHUẨN NẰM DƯỚI CẦN SỐ) */
        .vf-doors-status { display: flex; gap: 8px; justify-content: center; width: 100%; flex-wrap: wrap; margin-bottom: 15px;}
        .door-badge { display: flex; align-items: center; gap: 4px; padding: 4px 12px; border-radius: 12px; font-size: 11px; font-weight: bold; background: rgba(255,255,255,0.95); border: 1px solid #e5e7eb; box-shadow: 0 2px 6px rgba(0,0,0,0.1); color: #374151; transition: all 0.3s;}
        .door-badge.open { background: #fee2e2; border-color: #ef4444; color: #b91c1c; animation: pulseRed 1.5s infinite; }
        .door-badge ha-icon { --mdc-icon-size: 15px; }
        @keyframes pulseRed { 0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); } 70% { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); } 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); } }

        /* THANH ĐIỀU KHIỂN TỪ XA */
        .vf-remote-bar { display: flex; justify-content: center; gap: 15px; margin-bottom: 20px; padding: 10px; background: rgba(243,244,246,0.5); border-radius: 16px;}
        .remote-btn { display: flex; align-items: center; justify-content: center; width: 45px; height: 45px; background: white; border: 1px solid #e5e7eb; border-radius: 50%; color: #4b5563; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.05); transition: all 0.2s ease;}
        .remote-btn ha-icon { --mdc-icon-size: 22px; }
        .remote-btn:hover { background: #eff6ff; color: #2563eb; border-color: #bfdbfe; transform: translateY(-2px); box-shadow: 0 6px 12px rgba(37,99,235,0.15);}
        .remote-btn:active { transform: translateY(0); box-shadow: 0 2px 4px rgba(0,0,0,0.1);}

        /* LƯỚI 2 CỘT TĨNH */
        .vf-stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 20px; }
        .stat-box { display: flex; align-items: center; gap: 8px; background: rgba(243, 244, 246, 0.6); padding: 10px; border-radius: 12px; border: 1px solid rgba(229, 231, 235, 0.8); transition: all 0.2s; overflow: hidden; }
        .stat-box.clickable { cursor: pointer; }
        .stat-box.clickable:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.08); border-color: #d1d5db; background: white;}
        .stat-box ha-icon { flex-shrink: 0; --mdc-icon-size: 22px; }
        
        .stat-info { display: flex; flex-direction: column; min-width: 0; width: 100%; }
        .stat-label { font-size: 10px; font-weight: 700; color: #6b7280; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px;}
        .stat-val { font-size: 15px; font-weight: 800; color: #1f2937; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .stat-unit { font-size: 0.7em; font-weight: 600; color: #6b7280; margin-left: 3px; }

        @media (max-width: 400px) {
            .stat-box { padding: 8px 6px; gap: 6px; }
            .stat-val { font-size: 13px; }
            .stat-box ha-icon { --mdc-icon-size: 18px; }
        }

        .map-controls { position: absolute; top: 12px; right: 12px; z-index: 400; display: flex; flex-direction: column; gap: 6px; }
        .map-btn { width: 32px; height: 32px; background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(4px); border: 1px solid rgba(0,0,0,0.1); border-radius: 6px; cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,0.15); display:flex; align-items:center; justify-content:center; transition: all 0.2s ease; padding: 0; }
        .map-btn ha-icon { --mdc-icon-size: 18px; }
        .map-btn:hover { background: #ffffff; transform: scale(1.05); }
        .map-btn:active { transform: scale(0.95); }
        
        @keyframes spin { 100% { transform: rotate(360deg); } }
        .is-loading ha-icon { animation: spin 1s linear infinite; }
        .station-popup { font-family: sans-serif; }
        .station-popup h3 { margin: 0 0 5px 0; font-size: 14px; font-weight: bold; color: #111827; }
        .station-popup p { margin: 2px 0; font-size: 12px; color: #4b5563; }
      `;
      this.appendChild(style);
      this.content = true;

      // SỰ KIỆN: Bấm vào Thẻ thông số để mở Popup Biểu đồ (More Info)
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

      // GẮN SỰ KIỆN CHO NÚT ĐIỀU KHIỂN TỪ XA
      const callServiceBtn = (btnId, domain, service, entityId) => {
          const btn = this.querySelector(btnId);
          if(btn) {
              btn.addEventListener('click', () => {
                  if(this._hass.states[entityId]) {
                      btn.style.backgroundColor = "#dbeafe";
                      setTimeout(() => btn.style.backgroundColor = "", 300);
                      this._hass.callService(domain, service, { entity_id: entityId });
                  }
              });
          }
      };
      callServiceBtn('#btn-rc-lock', 'button', 'press', `button.${p}_khoa_cua`);
      callServiceBtn('#btn-rc-unlock', 'button', 'press', `button.${p}_mo_cua`);
      callServiceBtn('#btn-rc-horn', 'button', 'press', `button.${p}_bam_coi`);
      callServiceBtn('#btn-rc-lights', 'button', 'press', `button.${p}_nhay_den`);

      this.querySelector('#btn-zoom-in').addEventListener('click', () => { if(this._map) this._map.zoomIn(); });
      this.querySelector('#btn-zoom-out').addEventListener('click', () => { if(this._map) this._map.zoomOut(); });
      this.querySelector('#btn-locate').addEventListener('click', () => { 
        if(this._map && this._lastLat && this._lastLon && !this._isReplaying) {
          this._map.setView([this._lastLat, this._lastLon], 16, {animate: true});
        }
      });
      
      const btnStation = this.querySelector('#btn-stations');
      btnStation.addEventListener('click', () => {
        btnStation.classList.add('is-loading');
        btnStation.innerHTML = `<ha-icon icon="mdi:loading" style="color: #f59e0b;"></ha-icon>`;
        this._hass.callService('button', 'press', { entity_id: `button.${p}_tim_tram_sac` });
        setTimeout(() => { 
            btnStation.classList.remove('is-loading');
            btnStation.innerHTML = `<ha-icon icon="mdi:ev-station" style="color: #f59e0b;"></ha-icon>`; 
        }, 3000);
      });

      const btnFilter = this.querySelector('#btn-filter-station');
      btnFilter.addEventListener('click', () => {
          if (this._stationFilter === 'ALL') {
              this._stationFilter = 'DC';
              btnFilter.innerText = 'DC';
              btnFilter.style.color = '#dc2626'; 
          } else if (this._stationFilter === 'DC') {
              this._stationFilter = 'AC';
              btnFilter.innerText = 'AC';
              btnFilter.style.color = '#16a34a'; 
          } else {
              this._stationFilter = 'ALL';
              btnFilter.innerText = 'ALL';
              btnFilter.style.color = '#f59e0b'; 
          }
          this.renderStations();
      });

      const selectEl = this.querySelector('#trip-selector');
      selectEl.addEventListener('change', (e) => {
          if (!this._map || !this._polyline) return;
          const val = e.target.value;
          if (val === "current") {
              const routeSensor = this._hass.states[`sensor.${p}_lo_trinh_gps`];
              let routePoints = [];
              if (routeSensor && routeSensor.attributes.route_points) {
                  try { routePoints = JSON.parse(routeSensor.attributes.route_points); } catch(e){}
              }
              this._selectedRouteCoords = routePoints;
          } else {
              const trip = this._tripHistory[parseInt(val)];
              if (trip && trip.route) {
                  this._selectedRouteCoords = trip.route;
              }
          }
          this._polyline.setLatLngs(this._selectedRouteCoords);
          if (this._selectedRouteCoords.length > 0) {
              this._map.fitBounds(this._polyline.getBounds(), {padding: [30, 30]});
          }
      });

      const btnReplay = this.querySelector('#btn-replay');
      const iconReplay = this.querySelector('#icon-replay');
      btnReplay.addEventListener('click', () => {
          if (!this._map || !this._marker) return;
          if (this._selectedRouteCoords.length === 0) {
              const routeSensor = this._hass.states[`sensor.${p}_lo_trinh_gps`];
              if (routeSensor && routeSensor.attributes.route_points) {
                  try { this._selectedRouteCoords = JSON.parse(routeSensor.attributes.route_points); } catch(e){}
              }
          }
          if (this._selectedRouteCoords.length < 2) {
              alert("Chưa đủ dữ liệu lộ trình để mô phỏng!");
              return;
          }
          if (this._isReplaying) {
              clearInterval(this._replayTimer);
              this._isReplaying = false;
              iconReplay.setAttribute('icon', 'mdi:play-circle');
              btnReplay.style.backgroundColor = "#eff6ff";
              this._marker.setIcon(this.getCarIcon(0, null));
              this._marker.setLatLng([this._lastLat, this._lastLon]);
              this.querySelector('#vf-speed-container').classList.remove('replaying');
          } else {
              this._isReplaying = true;
              iconReplay.setAttribute('icon', 'mdi:stop-circle');
              btnReplay.style.backgroundColor = "#bfdbfe"; 
              this._map.fitBounds(this._polyline.getBounds(), {padding: [30, 30]});
              let currentIdx = 0;
              const speedEl = this.querySelector('#vf-speed-container');
              const speedVal = this.querySelector('#vf-speed');
              speedEl.style.display = 'flex';
              speedEl.classList.add('replaying'); 

              this._replayTimer = setInterval(() => {
                  if (currentIdx >= this._selectedRouteCoords.length) {
                      clearInterval(this._replayTimer);
                      this._isReplaying = false;
                      iconReplay.setAttribute('icon', 'mdi:play-circle');
                      btnReplay.style.backgroundColor = "#eff6ff";
                      speedEl.classList.remove('replaying');
                      this._marker.setIcon(this.getCarIcon(0, null));
                      this._marker.setLatLng([this._lastLat, this._lastLon]);
                      return;
                  }
                  const pt = this._selectedRouteCoords[currentIdx];
                  let angle = 0;
                  if (currentIdx < this._selectedRouteCoords.length - 1) {
                      const nextPt = this._selectedRouteCoords[currentIdx + 1];
                      angle = this.getBearing(pt[0], pt[1], nextPt[0], nextPt[1]);
                  } else if (currentIdx > 0) {
                      const prevPt = this._selectedRouteCoords[currentIdx - 1];
                      angle = this.getBearing(prevPt[0], prevPt[1], pt[0], pt[1]);
                  }
                  const simSpeed = pt.length > 2 ? pt[2] : 0;
                  speedVal.innerText = simSpeed;
                  this._marker.setIcon(this.getCarIcon(angle, simSpeed));
                  this._marker.setLatLng([pt[0], pt[1]]);
                  currentIdx++;
              }, 400); 
          }
      });
    }

    const name = getValidState(`sensor.${p}_ten_dinh_danh_xe`) || 'Xe VinFast';
    
    // XỬ LÝ TRẠNG THÁI HOẠT ĐỘNG KÈM THỜI GIAN (VÍ DỤ: ĐANG ĐỖ TỪ 15 PHÚT TRƯỚC)
    const statusObj = hass.states[`sensor.${p}_trang_thai_hoat_dong`];
    let statusText = statusObj ? statusObj.state : 'N/A';
    if (statusObj && statusObj.last_changed) {
        const timeStr = this.getTimeSince(statusObj.last_changed);
        if (timeStr !== 'vừa xong') {
            statusText = `${statusText} từ ${timeStr}`;
        } else {
            statusText = `${statusText} ${timeStr}`;
        }
    }
    
    const gear = getValidState(`sensor.${p}_vi_tri_can_so`) || 'P';
    const speed = getValidState(`sensor.${p}_toc_do_hien_tai`) || '0';
    
    const batt = getValidState(`sensor.${p}_phan_tram_pin`);
    const range = getValidState(`sensor.${p}_quang_duong_du_kien`) || getValidState(`sensor.${p}_quang_duong_thuc_te_day_100_pin`);
    const eff = getValidState(`sensor.${p}_hieu_suat_tieu_thu_trung_binh_xe`);
    const ideal = getValidState(`sensor.${p}_dai_toc_do_toi_uu_nhat`);
    const trip = getValidState(`sensor.${p}_quang_duong_chuyen_di_trip`);
    const tripEnergy = getValidState(`sensor.${p}_dien_nang_tieu_thu_trip`);

    const odoRaw = getValidState(`sensor.${p}_tong_odo`);
    let odoClean = '--';
    if (odoRaw && !isNaN(odoRaw)) odoClean = Math.floor(parseFloat(odoRaw)).toString();

    this.querySelector('#vf-name').innerText = name;
    this.querySelector('#vf-status-badge').innerText = statusText; // Hiển thị Status kèm Thời gian
    this.querySelector('#vf-odo-int').innerText = odoClean;
    
    const renderStat = (id, val, unit) => {
        const el = this.querySelector(id);
        if (val && val !== '--' && val !== 'unknown') {
            el.innerHTML = `${val}<span class="stat-unit">${unit}</span>`;
        } else { el.innerHTML = '--'; }
    };

    renderStat('#vf-stat-batt', batt, '%');
    renderStat('#vf-stat-range', range, 'km');
    renderStat('#vf-stat-eff', eff, 'kWh/100km');
    renderStat('#vf-stat-trip', trip, 'km');
    renderStat('#vf-stat-energy', tripEnergy, 'kWh');

    const idealEl = this.querySelector('#vf-stat-ideal');
    if (ideal && ideal !== 'unknown') {
        let cleanIdeal = ideal.replace(' km/h', '').replace(' km/1%', '');
        let spaceIdx = cleanIdeal.indexOf(' ');
        if (spaceIdx > -1) {
            idealEl.innerHTML = `${cleanIdeal.substring(0, spaceIdx)}<span class="stat-unit">${cleanIdeal.substring(spaceIdx)}</span>`;
        } else {
            idealEl.innerHTML = cleanIdeal;
        }
    } else {
        idealEl.innerHTML = '--';
    }

    let rawImage = getValidState(`sensor.${p}_hinh_anh_xe_url`);
    if (!rawImage || rawImage.includes('unknown') || rawImage.trim() === '') {
        rawImage = 'https://shop.vinfastauto.com/on/demandware.static/-/Sites-app_vinfast_vn-Library/default/dw15d3dc68/images/PDP/vf9/M/M.png';
    }
    const imgEl = this.querySelector('#vf-car-img');
    if (imgEl.src !== rawImage) imgEl.src = rawImage;

    const updateTire = (id, val) => {
      const el = this.querySelector(id);
      if (val !== null && val !== 'unknown' && val !== '') { 
          el.style.display = 'block'; 
          el.querySelector('span').innerText = val; 
      } else { 
          el.style.display = 'none'; 
      }
    };
    updateTire('#tire-fl', getValidState(`sensor.${p}_ap_suat_lop_truoc_trai`)); 
    updateTire('#tire-fr', getValidState(`sensor.${p}_ap_suat_lop_truoc_phai`)); 
    updateTire('#tire-rl', getValidState(`sensor.${p}_ap_suat_lop_sau_trai`)); 
    updateTire('#tire-rr', getValidState(`sensor.${p}_ap_suat_lop_sau_phai`));

    const remoteBar = this.querySelector('#vf-remote-controls');
    const hasControls = ['khoa_cua', 'mo_cua', 'bam_coi', 'nhay_den'].some(cmd => hass.states[`button.${p}_${cmd}`] !== undefined);
    if (hasControls) {
        remoteBar.style.display = 'flex';
    } else {
        remoteBar.style.display = 'none';
    }

    const getDoorStatus = (slug) => getValidState(`sensor.${p}_${slug}`) === 'Mở';
    const doorsConfig = [
        { name: 'Cửa lái', open: getDoorStatus('cua_truoc_trai'), icon: 'mdi:car-door' },
        { name: 'Cửa phụ', open: getDoorStatus('cua_truoc_phai'), icon: 'mdi:car-door' },
        { name: 'Cửa sau T', open: getDoorStatus('cua_sau_trai'), icon: 'mdi:car-door' },
        { name: 'Cửa sau P', open: getDoorStatus('cua_sau_phai'), icon: 'mdi:car-door' },
        { name: 'Cốp sau', open: getDoorStatus('cop_sau'), icon: 'mdi:car-back' },
        { name: 'Capo', open: getDoorStatus('nap_capo'), icon: 'mdi:car' }
    ];
    const openDoors = doorsConfig.filter(d => d.open);
    const doorsEl = this.querySelector('#vf-doors-container');
    if (openDoors.length === 0) {
        doorsEl.innerHTML = `<div class="door-badge" style="color: #10b981; border-color: rgba(16, 185, 129, 0.3); background: rgba(255,255,255,0.7);"><ha-icon icon="mdi:shield-check-outline"></ha-icon> Đóng kín</div>`;
    } else {
        doorsEl.innerHTML = openDoors.map(d => `<div class="door-badge open"><ha-icon icon="${d.icon}"></ha-icon> ${d.name}</div>`).join('');
    }

    ['P','R','N','D'].forEach(g => {
      const el = this.querySelector(`#gear-${g}`);
      if (gear.includes(g)) el.classList.add('active');
      else el.classList.remove('active');
    });
    
    if (!this._isReplaying) {
        const speedEl = this.querySelector('#vf-speed-container');
        if (gear.includes('P') || Math.round(Number(speed)) === 0) {
          speedEl.style.display = 'none';
        } else {
          speedEl.style.display = 'flex';
          this.querySelector('#vf-speed').innerText = Math.round(Number(speed));
        }
    }

    const tracker = hass.states[`device_tracker.${p}_vi_tri_gps`];
    const lat = tracker?.attributes?.latitude;
    const lon = tracker?.attributes?.longitude;
    
    if (this._map && lat && lon) {
      if (!this._isReplaying) {
          this._marker.setIcon(this.getCarIcon(0, null));
          this._marker.setLatLng([lat, lon]);
      }
      if (this._lastLat === null) {
          this._map.setView([lat, lon], 15);
      }
      this._lastLat = lat; this._lastLon = lon;
      
      const selectEl = this.querySelector('#trip-selector');
      if (selectEl && selectEl.value === "current") {
          const routeSensor = hass.states[`sensor.${p}_lo_trinh_gps`];
          let routePoints = [];
          if (routeSensor && routeSensor.attributes.route_points) {
            try { routePoints = JSON.parse(routeSensor.attributes.route_points); } catch(e){}
          }
          this._selectedRouteCoords = routePoints;
          if (routePoints.length > 0) this._polyline.setLatLngs(routePoints);
      }

      const stationSensor = hass.states[`sensor.${p}_tram_sac_lan_can`];
      if (stationSensor && stationSensor.attributes.stations && typeof L !== 'undefined') {
          const newStations = stationSensor.attributes.stations;
          if (this._currentStations.length !== newStations.length) {
              this._currentStations = newStations;
              this.renderStations();
          }
      }
    }
  }
  
  getCardSize() { return 8; }
}
customElements.define('vinfast-digital-twin', VinFastDigitalTwin);
