class VinFastDigitalTwin extends HTMLElement {
  setConfig(config) {
    this.config = config || {};
    this._map = null;
    this._polyline = null;
    this._marker = null;
    this._stationLayer = null;
    this._historyLayerGroup = null; 
    this._leafletLoaded = false;
    this._lastLat = null;
    this._lastLon = null;
    
    this._lastHeadingLat = null;
    this._lastHeadingLon = null;
    this._currentAngle = undefined; 
    
    this._isReplaying = false;
    this._isPaused = false;
    this._currentReplayIdx = 0;
    this._animationFrameId = null;
    
    this._rawRouteCoords = []; 
    this._smoothedRouteCoords = []; 

    // LƯU TRỮ VÀ KHÔI PHỤC TRẠNG THÁI BỘ LỌC TRẠM SẠC
    this._showStations = localStorage.getItem('vf_show_stations') === 'true';
    this._stationFilter = localStorage.getItem('vf_station_filter') || 'ALL'; 
    this._currentStations = []; 
    this._prevStationStr = null;
    this._chargeHistoryData = [];
    
    this._effToggleTimer = null;
    this._effToggleState = false;
    this._entityPrefix = null; 
    this._lastAiMessage = ""; 

    // BIẾN CHO CHẾ ĐỘ HISTORY
    this._tripsData = {}; 
    this._dayStats = {};  
    this._currentDate = new Date(); 
    this._todayStr = this.formatDate(this._currentDate);
    this._selectedDateStr = 'LIVE'; 
    this._addressCache = {};
  }

  safeParseJSON(str) {
      if (!str) return [];
      if (typeof str !== 'string') return str;
      try { return JSON.parse(str); }
      catch(e) {
          try { 
              let fixedStr = str.replace(/'/g, '"').replace(/True/g, 'true').replace(/False/g, 'false').replace(/None/g, 'null');
              return JSON.parse(fixedStr); 
          }
          catch(e2) { return []; }
      }
  }

  getDistanceFromLatLonInM(lat1, lon1, lat2, lon2) {
      const R = 6371000; 
      const dLat = (lat2-lat1) * Math.PI / 180;
      const dLon = (lon2-lon1) * Math.PI / 180; 
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2); 
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  formatMins(totalMins) {
      if (totalMins < 60) return `${totalMins}p`;
      const h = Math.floor(totalMins / 60);
      const m = totalMins % 60;
      return m > 0 ? `${h}g ${m}p` : `${h}g`;
  }

  formatDate(dateObj) {
      const y = dateObj.getFullYear();
      const m = String(dateObj.getMonth() + 1).padStart(2, '0');
      const d = String(dateObj.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
  }

  async getAddressFromCoords(lat, lon) {
      const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
      if (this._addressCache[cacheKey]) return this._addressCache[cacheKey];
      try {
          const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=16`);
          if (!response.ok) throw new Error("API Error");
          const data = await response.json();
          let address = data.display_name || "Không xác định";
          const parts = address.split(', ');
          if (parts.length > 3) address = parts.slice(0, 3).join(', ');
          this._addressCache[cacheKey] = address;
          return address;
      } catch (e) { return `${lat.toFixed(4)}, ${lon.toFixed(4)}`; }
  }

  loadLeaflet() {
    if (this._leafletLoaded) return;
    this._leafletLoaded = true;
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => { setTimeout(() => this.initMap(), 200); };
    document.head.appendChild(script);
  }

  async fetchChargeHistory(vin) {
      if (!vin) return;
      try {
          const res = await fetch(`/local/vinfast_charge_history_${vin.toLowerCase()}.json?v=${new Date().getTime()}`);
          if (res.ok) {
              this._chargeHistoryData = await res.json();
              const box = this.querySelector('#box-charge');
              if (box && box.classList.contains('active-box')) this.renderChargeHistory();
          }
      } catch(e) {}
  }

  async fetchTripHistory(vin) {
    let rawTrips = null;
    const urlsToTry = [
        this.config.json_url,
        `/local/vinfast_trips_${(vin || '').toLowerCase()}.json`,
        `/local/vinfast_trips_rlnvbl9k1rh742246.json` 
    ].filter(Boolean);

    for (let url of urlsToTry) {
        try {
            const res = await fetch(`${url}?v=${new Date().getTime()}`);
            if (res.ok) { rawTrips = await res.json(); break; }
        } catch(e) { }
    }

    if (rawTrips) {
        let groupedData = {};
        rawTrips.forEach(trip => {
            let ts = trip.id || trip.start_time || trip.timestamp;
            let d = new Date(ts > 1e11 ? ts : ts * 1000);
            let dateStr = this.formatDate(d);
            if (!groupedData[dateStr]) groupedData[dateStr] = [];

            if (trip.route && trip.route.length > 0) {
                groupedData[dateStr].push({
                    time: ts, duration: trip.duration || 0, distance: trip.distance || 0,
                    start_time_str: trip.start_time || "", end_time_str: trip.end_time || "",
                    route: trip.route
                });
            }
        });

        this._tripsData = {};
        this._dayStats = {};

        for (let day in groupedData) {
            groupedData[day].sort((a, b) => a.time - b.time);
            let dayTrips = groupedData[day];
            
            let drivingMins = 0; let totalDistance = 0; let pauseSecs = 0; let parkingSecs = 0; let maxSpeed = 0;
            let startTime = dayTrips[0].start_time_str; let endTime = dayTrips[dayTrips.length - 1].end_time_str;
            let mergedSegments = []; let currentSeg = null;

            dayTrips.forEach((trip, i) => {
                drivingMins += trip.duration; totalDistance += trip.distance;
                trip.route.forEach(pt => { if (pt.length > 2 && pt[2] > maxSpeed) maxSpeed = pt[2]; });

                if (!currentSeg) {
                    currentSeg = { time: trip.time, endTime: trip.time + (trip.duration * 60), route: [...trip.route], pauseAfter: 0 };
                } else {
                    let timeGap = trip.time - currentSeg.endTime;
                    let lastPt = currentSeg.route[currentSeg.route.length - 1]; let firstPt = trip.route[0];
                    let distGap = this.getDistanceFromLatLonInM(lastPt[0], lastPt[1], firstPt[0], firstPt[1]);

                    if (timeGap < 900 || distGap < 300) {
                        currentSeg.route = currentSeg.route.concat(trip.route); currentSeg.endTime = trip.time + (trip.duration * 60);
                    } else {
                        currentSeg.pauseAfter = timeGap; 
                        mergedSegments.push(currentSeg);
                        currentSeg = { time: trip.time, endTime: trip.time + (trip.duration * 60), route: [...trip.route], pauseAfter: 0 };
                    }
                }

                if (i < dayTrips.length - 1) {
                    let gapSecs = dayTrips[i+1].time - (trip.time + (trip.duration * 60));
                    if (gapSecs < 0) gapSecs = 0;
                    if (gapSecs < 900) pauseSecs += gapSecs; else parkingSecs += gapSecs; 
                }
            });

            if (currentSeg) {
                currentSeg.pauseAfter = 0;
                mergedSegments.push(currentSeg);
            }
            this._tripsData[day] = mergedSegments;
            this._dayStats[day] = {
                startTime, endTime, drivingMins, totalDistance: totalDistance.toFixed(1),
                pauseMins: Math.round(pauseSecs / 60), parkingMins: Math.round(parkingSecs / 60), maxSpeed: Math.round(maxSpeed)
            };
        }
    }
    
    this.renderCalendar();
    this.switchMode();
  }

  cleanRouteData(points) {
      if (!points || !Array.isArray(points) || points.length === 0) return [];
      return points.map(p => [p[0], p[1], p[2] || 0]); 
  }

  _smoothRouteData(points) {
      if (!points || points.length < 2) return points;
      let filtered = [points[0]];
      for (let i = 1; i < points.length; i++) {
          let prev = filtered[filtered.length - 1];
          let curr = points[i];
          let dist = this.getDistanceFromLatLonInM(prev[0], prev[1], curr[0], curr[1]);
          if (dist > 2.0 || curr[2] > 0) { filtered.push(curr); }
      }
      return filtered;
  }

  getBearing(startLat, startLng, destLat, destLng) {
      startLat = startLat * Math.PI / 180; startLng = startLng * Math.PI / 180;
      destLat = destLat * Math.PI / 180; destLng = destLng * Math.PI / 180;
      const y = Math.sin(destLng - startLng) * Math.cos(destLat);
      const x = Math.cos(startLat) * Math.sin(destLat) - Math.sin(startLat) * Math.cos(destLat) * Math.cos(destLng - startLng);
      let brng = Math.atan2(y, x);
      return (brng * 180 / Math.PI + 360) % 360;
  }

  _smoothRotation(targetAngle) {
      if (this._currentAngle === undefined) { this._currentAngle = targetAngle; return targetAngle; }
      let diff = targetAngle - (this._currentAngle % 360);
      diff = ((diff + 540) % 360) - 180;
      this._currentAngle += diff;
      return this._currentAngle;
  }

  getCarIcon(angle = 0, speed = null) {
      if(typeof L === 'undefined') return null;
      const arrowSvg = `<svg class="car-dir-svg" viewBox="0 0 24 24" fill="#2563eb" stroke="white" stroke-width="2" style="position: absolute; top: 0; left: 0; transform: rotate(${angle}deg); transform-origin: center; transition: transform 0.05s linear; width: 28px; height: 28px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5)); z-index: 1000;"><path d="M12 2L22 20L12 17L2 20L12 2Z"/></svg>`;
      let speedDisplay = speed !== null && speed > 0 ? 'block' : 'none';
      let speedVal = speed !== null ? Math.round(speed) : 0;
      const speedBadge = `<div class="car-speed-badge" style="position: absolute; bottom: 32px; left: 50%; transform: translateX(-50%); background: #10b981; color: white; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: bold; border: 1px solid white; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.3); z-index: 1001; display: ${speedDisplay}; transition: all 0.1s;">${speedVal} km/h</div>`;
      return L.divIcon({ className: '', html: `<div style="position: relative; width: 28px; height: 28px;">${arrowSvg}${speedBadge}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
  }

  checkAndShowSmartSuggestion(soc, heading) {
      const suggestCard = this.querySelector('#vf-smart-suggestion');
      if (!suggestCard || !this._currentStations || this._currentStations.length === 0) return;
      if (soc > 30 || heading === null) { suggestCard.style.display = 'none'; return; }
      
      const modelState = this._hass && this._entityPrefix ? this._hass.states[`sensor.${this._entityPrefix}_ten_dong_xe`] : null;
      const carModel = modelState ? (modelState.state || "").toUpperCase() : "";

      let validStations = this._currentStations;
      if (carModel.includes("VF3") || carModel.includes("VF 3")) {
          validStations = validStations.filter(st => st.power >= 20); 
      }

      let bestStation = null;
      for (let st of validStations) {
          if (st.avail > 0 && st.dist < 20) {
              let stationBearing = this.getBearing(this._lastLat, this._lastLon, st.lat, st.lng);
              let diff = Math.abs(stationBearing - heading);
              if (diff > 180) diff = 360 - diff;
              if (diff < 45 || st.dist < 3.0) {
                  if (!bestStation || st.dist < bestStation.dist) bestStation = st;
              }
          }
      }
      
      if (bestStation) {
          const elName = this.querySelector('#vf-suggest-name');
          const elDist = this.querySelector('#vf-suggest-dist');
          const elPower = this.querySelector('#vf-suggest-power');
          const elAvail = this.querySelector('#vf-suggest-avail');
          
          if(elName) elName.innerText = bestStation.name;
          
          let exactDist = bestStation.dist;
          if (this._lastLat && this._lastLon && this._map) {
              let distMeters = this._map.distance([this._lastLat, this._lastLon], [bestStation.lat, bestStation.lng]);
              exactDist = (distMeters / 1000).toFixed(1);
          }
          if(elDist) elDist.innerText = exactDist;
          if(elPower) elPower.innerText = bestStation.power;
          if(elAvail) elAvail.innerText = `${bestStation.avail}/${bestStation.total}`;
          
          const navUrl = `https://www.google.com/maps/dir/?api=1&origin=${this._lastLat},${this._lastLon}&destination=${bestStation.lat},${bestStation.lng}&travelmode=driving`;
          const btnNav = this.querySelector('#btn-suggest-nav');
          if (btnNav) btnNav.onclick = () => window.open(navUrl, '_blank');
          
          suggestCard.style.display = 'block';
      } else { suggestCard.style.display = 'none'; }
  }

  renderStations() {
      if (!this._stationLayer || !this._map || typeof L === 'undefined') return;
      this._stationLayer.clearLayers();
      if (!this._showStations || !Array.isArray(this._currentStations) || this._selectedDateStr !== 'LIVE') return; 

      const modelState = this._hass && this._entityPrefix ? this._hass.states[`sensor.${this._entityPrefix}_ten_dong_xe`] : null;
      const carModel = modelState ? (modelState.state || "").toUpperCase() : "";

      let validStations = this._currentStations;
      if (carModel.includes("VF3") || carModel.includes("VF 3")) {
          validStations = validStations.filter(st => st.power >= 20); 
      }

      validStations.forEach(st => {
          const isDC = st.power >= 20;
          if (this._stationFilter === 'DC' && !isDC) return;
          if (this._stationFilter === 'AC' && isDC) return;

          if (st.lat && st.lng) {
              let exactDist = st.dist; 
              if (this._lastLat && this._lastLon) {
                  let distMeters = this._map.distance([this._lastLat, this._lastLon], [st.lat, st.lng]);
                  exactDist = (distMeters / 1000).toFixed(1); 
              }

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

              const navUrl = `https://www.google.com/maps/dir/?api=1${(this._lastLat && this._lastLon)?`&origin=${this._lastLat},${this._lastLon}`:''}&destination=${st.lat},${st.lng}&travelmode=driving`;
              const popupContent = `
                  <div style="font-family:sans-serif; min-width: 170px;">
                      <b style="font-size: 13px; color: #1e3a8a;">${st.name}</b><br>
                      <div style="margin-top: 6px; font-size: 12px;">
                          🚗 Cách xe: <b style="color: #ef4444;">${exactDist} km</b><br>
                          ⚡ Công suất: <b>${st.power} kW</b><br>
                          🔌 Trụ trống: <b style="color:${pinColor}; font-size:14px;">${st.avail} / ${st.total}</b>
                      </div>
                      <a href="${navUrl}" target="_blank" style="display: flex; align-items: center; justify-content: center; gap: 4px; margin-top: 10px; background: #2563eb; color: white; padding: 8px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 12px; transition: background 0.2s;">
                          Chỉ đường
                      </a>
                  </div>
              `;
              L.marker([st.lat, st.lng], {icon: stationIcon}).bindPopup(popupContent).addTo(this._stationLayer);
          }
      });
  }

  renderCalendar() {
      const year = this._currentDate.getFullYear();
      const month = this._currentDate.getMonth();
      const monthNames = ["Tháng 1", "Tháng 2", "Tháng 3", "Tháng 4", "Tháng 5", "Tháng 6", "Tháng 7", "Tháng 8", "Tháng 9", "Tháng 10", "Tháng 11", "Tháng 12"];
      
      const elMonthYear = this.querySelector('#cal-month-year');
      if(elMonthYear) elMonthYear.innerText = `${monthNames[month]} ${year}`;

      const firstDay = new Date(year, month, 1).getDay(); 
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      
      let gridHtml = `
          <div class="cal-day-name">CN</div><div class="cal-day-name">T2</div><div class="cal-day-name">T3</div>
          <div class="cal-day-name">T4</div><div class="cal-day-name">T5</div><div class="cal-day-name">T6</div><div class="cal-day-name">T7</div>
      `;

      for (let i = 0; i < firstDay; i++) { gridHtml += `<div class="cal-day disabled"></div>`; }

      for (let day = 1; day <= daysInMonth; day++) {
          const checkDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          let classes = "cal-day";
          if (checkDateStr === this._todayStr) classes += " today";
          if (checkDateStr === this._selectedDateStr) classes += " active";
          if (this._tripsData[checkDateStr] && this._tripsData[checkDateStr].length > 0) classes += " has-trip";

          gridHtml += `<div class="cal-day ${classes}" data-date="${checkDateStr}">${day}</div>`;
      }

      const gridEl = this.querySelector('#cal-grid');
      if(gridEl) gridEl.innerHTML = gridHtml;

      const days = this.querySelectorAll('.cal-day:not(.disabled)');
      days.forEach(el => {
          el.addEventListener('click', (e) => {
              this._selectedDateStr = e.target.getAttribute('data-date');
              this.renderCalendar(); 
              this.switchMode();
              this.querySelector('#cal-dropdown').style.display = 'none';
          });
      });
  }

  changeMonth(offset) {
      this._currentDate.setMonth(this._currentDate.getMonth() + offset);
      this.renderCalendar();
  }

  switchMode() {
      const statsPanel = this.querySelector('#stats-panel');
      const liveTools = this.querySelector('#live-tools');
      const historyTools = this.querySelector('#history-tools');
      
      const liveIndicator = this.querySelector('#icon-live-indicator');
      const calIcon = this.querySelector('#icon-cal-mode');

      this._historyLayerGroup.clearLayers();

      if (this._selectedDateStr === 'LIVE') {
          if(statsPanel) statsPanel.style.display = 'none';
          if(liveTools) liveTools.style.display = 'contents';
          if(historyTools) historyTools.style.display = 'none';
          
          if(liveIndicator) liveIndicator.style.display = 'block';
          if(calIcon) calIcon.style.color = '#334155';

          if (this._marker) this._marker.setOpacity(1);
          
          if (this._hass && this._entityPrefix) {
              const s = this._hass.states[`sensor.${this._entityPrefix}_lo_trinh_gps`];
              const routeJsonStr = s && s.attributes ? s.attributes.route_json : null;
              if (routeJsonStr) {
                  let parsedData = this.safeParseJSON(routeJsonStr);
                  this._rawRouteCoords = this.cleanRouteData(parsedData);
                  this._smoothedRouteCoords = this._smoothRouteData(this._rawRouteCoords);
                  this._polyline.setLatLngs(this._smoothedRouteCoords.map(p => [p[0], p[1]]));
              }
          }
          this.renderStations();
          if (this._lastLat && this._map) this._map.setView([this._lastLat, this._lastLon], 15);
      } else {
          if(statsPanel) statsPanel.style.display = 'flex';
          if(liveTools) liveTools.style.display = 'none'; 
          if(historyTools) historyTools.style.display = 'contents'; 
          
          if(liveIndicator) liveIndicator.style.display = 'none';
          if(calIcon) calIcon.style.color = '#2563eb';

          if (this._marker) this._marker.setOpacity(0); 
          this._polyline.setLatLngs([]); 
          if (this._stationLayer) this._stationLayer.clearLayers(); 

          const dailySegments = this._tripsData[this._selectedDateStr];
          if (!dailySegments || dailySegments.length === 0) {
              if(statsPanel) statsPanel.style.display = 'none';
              return;
          }

          let chargeDuration = 0;
          if (this._chargeHistoryData) {
              const [y, m, d] = this._selectedDateStr.split('-');
              const matchDate1 = `${d}/${m}/${y}`;
              const matchDate2 = `${d}-${m}-${y}`;
              this._chargeHistoryData.forEach(c => {
                  if (c.date && (c.date === matchDate1 || c.date === matchDate2 || c.date.includes(matchDate1))) {
                      chargeDuration += parseInt(c.duration || 0);
                  }
              });
          }

          const stats = this._dayStats[this._selectedDateStr];
          if (stats) {
              this.querySelector('#stat-time-a').innerText = stats.startTime || '--:--';
              this.querySelector('#stat-time-b').innerText = stats.endTime || '--:--';
              this.querySelector('#stat-dist').innerText = `${stats.totalDistance} km`; 
              this.querySelector('#stat-drive').innerText = this.formatMins(stats.drivingMins);
              this.querySelector('#stat-pause').innerText = this.formatMins(stats.pauseMins);
              this.querySelector('#stat-park').innerText = this.formatMins(stats.parkingMins);
              this.querySelector('#stat-speed').innerText = `${stats.maxSpeed} km/h`;
              
              const chargeMetric = this.querySelector('#metric-charge');
              const statCharge = this.querySelector('#stat-charge');
              if (chargeDuration > 0 && chargeMetric && statCharge) {
                  chargeMetric.style.display = 'flex';
                  statCharge.innerText = this.formatMins(chargeDuration);
              } else if (chargeMetric) {
                  chargeMetric.style.display = 'none';
              }
          }

          const elAddrA = this.querySelector('#stat-addr-a');
          const elAddrB = this.querySelector('#stat-addr-b');
          elAddrA.innerText = "Đang dịch tọa độ...";
          elAddrB.innerText = "Đang dịch tọa độ...";

          const firstRoute = dailySegments[0];
          const lastRoute = dailySegments[dailySegments.length - 1];
          this.getAddressFromCoords(firstRoute.route[0][0], firstRoute.route[0][1]).then(addr => elAddrA.innerText = addr);
          this.getAddressFromCoords(lastRoute.route[lastRoute.route.length-1][0], lastRoute.route[lastRoute.route.length-1][1]).then(addr => elAddrB.innerText = addr);

          let bounds = L.latLngBounds();
          let flatCoordsForReplay = [];

          dailySegments.forEach((segmentObj, index) => {
              const segment = segmentObj.route;
              if (segment.length < 2) return;
              flatCoordsForReplay.push(...segment); 

              const latlngs = segment.map(pt => [pt[0], pt[1]]);
              L.polyline(latlngs, { color: '#2563eb', weight: 5, opacity: 0.8, lineJoin: 'round' }).addTo(this._historyLayerGroup);
              latlngs.forEach(ll => bounds.extend(ll));

              if (index === 0) {
                  L.marker(latlngs[0], { icon: L.divIcon({ className: 'marker-start' }) }).addTo(this._historyLayerGroup);
              }
              
              if (index < dailySegments.length - 1) {
                  let pauseMins = Math.round(segmentObj.pauseAfter / 60);
                  let isParking = pauseMins >= 15;
                  let iconClass = isParking ? 'marker-park' : 'marker-pause';
                  let iconHtml = isParking ? 'P' : '';
                  
                  let marker = L.marker(latlngs[latlngs.length - 1], { icon: L.divIcon({ className: iconClass, html: iconHtml }) }).addTo(this._historyLayerGroup);
                  let popupHtml = `
                      <div style="font-family:sans-serif; text-align:center; min-width: 140px;">
                          <div style="font-size:11px; font-weight:800; color:${isParking ? '#ef4444' : '#f59e0b'}; margin-bottom:6px; border-bottom:1px solid #e2e8f0; padding-bottom:4px;">
                              <ha-icon icon="${isParking ? 'mdi:parking' : 'mdi:timer-sand'}" style="--mdc-icon-size:14px; margin-bottom:-2px;"></ha-icon> 
                              ${isParking ? 'ĐIỂM ĐỖ XE' : 'ĐIỂM DỪNG CHỜ'}
                          </div>
                          <div style="font-size:12px; color:#475569; font-weight:600;">
                              Dừng tại đây:<br><span style="color:#0f172a; font-weight:900; font-size:14px;">${this.formatMins(pauseMins)}</span>
                          </div>
                      </div>
                  `;
                  marker.bindPopup(popupHtml);
              }
              
              if (index === dailySegments.length - 1) {
                  const lastPt = segment[segment.length - 1];
                  const speed = lastPt.length > 2 ? lastPt[2] : 0;
                  let endIcon = speed > 2.0 ? L.divIcon({ className: 'marker-continue', html: '❯' }) : L.divIcon({ className: 'marker-end-flag', html: '🏁' });
                  L.marker(latlngs[latlngs.length - 1], { icon: endIcon }).addTo(this._historyLayerGroup);
              }
          });

          this._smoothedRouteCoords = flatCoordsForReplay;
          
          if (bounds.isValid()) {
              this._map.fitBounds(bounds, { padding: [40, 40] }); 
          } 
      }
      
      this.updateDynamicTripStats();
  }

  updateDynamicTripStats() {
    const speedElTarget = this.querySelector('#vf-stat-speed');
    const dtSpeedChart = this.querySelector('#dt-speed-chart');
    const speedLbl = this.querySelector('#lbl-speed-title');
    
    const p = this._entityPrefix;
    const speedSensor = this._hass ? (this._hass.states[`sensor.${p}_dai_toc_do_toi_uu_nhat`] || this._hass.states[`sensor.${p}_toc_do_toi_uu_nhat`]) : null;
    let speedBandStr = speedSensor ? speedSensor.state : '--';
    if (!speedSensor || speedBandStr === 'unknown' || speedBandStr === 'unavailable' || speedBandStr.length > 20) {
        speedBandStr = '--';
    }

    if (speedElTarget && speedBandStr !== '--') { 
        let spd = String(speedBandStr).split(' ')[0]; 
        speedElTarget.innerHTML = `${spd}<span class="stat-unit">km/h</span>`; 
        if(speedLbl) speedLbl.innerText = "TỐC ĐỘ TỐI ƯU";
    } 

    if (dtSpeedChart) {
        let htmlChart = ''; let maxVal = 0; let bars = []; 
        let hasSensorData = false;
        
        const sObj = speedSensor || (this._hass ? this._hass.states[`sensor.${p}_co_van_xe_dien_ai`] : null);
        if (sObj && sObj.attributes) {
            for (let key in sObj.attributes) {
                let lowerKey = key.toLowerCase();
                if (lowerKey.includes('dải') || lowerKey.includes('dai_') || lowerKey.includes('km/h') || lowerKey.match(/^[0-9]+(-|_)[0-9]+/)) { 
                    let valStr = String(sObj.attributes[key]); 
                    let num = parseFloat(valStr.split(' ')[0]); 
                    if (!isNaN(num)) {
                        if (num > maxVal) maxVal = num; 
                        let label = key.replace(/Dải|dải|km\/h|_/ig, ' ').trim();
                        if(label.includes('-') || label.includes('>')) {
                             bars.push({label: label, val: num}); 
                             hasSensorData = true;
                        }
                    }
                }
            }
        }
        
        if (!hasSensorData) {
            let speedBands = { "0-30": 0, "30-50": 0, "50-70": 0, "70-90": 0, ">90": 0 };
            let coordsToAnalyze = [];
            if (this._selectedDateStr === 'LIVE') {
                if (this._smoothedRouteCoords && this._smoothedRouteCoords.length > 0) coordsToAnalyze = [this._smoothedRouteCoords];
            } else {
                let flatHistory = [];
                (this._tripsData[this._selectedDateStr] || []).forEach(seg => { flatHistory.push(...seg.route); });
                coordsToAnalyze = [flatHistory];
            }
            
            let foundData = false;
            coordsToAnalyze.forEach(segment => {
                for (let i = 0; i < segment.length - 1; i++) {
                    let ptA = segment[i]; let ptB = segment[i+1];
                    let dist = this.getDistanceFromLatLonInM(ptA[0], ptA[1], ptB[0], ptB[1]) / 1000;
                    let spd = ptB[2] || 0;
                    if (spd > 2) {
                        foundData = true;
                        if (spd < 30) speedBands["0-30"] += dist;
                        else if (spd < 50) speedBands["30-50"] += dist;
                        else if (spd < 70) speedBands["50-70"] += dist;
                        else if (spd < 90) speedBands["70-90"] += dist;
                        else speedBands[">90"] += dist;
                    }
                }
            });
            
            if (foundData) {
                let bestBand = "0-30"; let maxDist = 0;
                for (let key in speedBands) {
                    if (speedBands[key] > maxDist) { maxDist = speedBands[key]; bestBand = key; }
                }
                if (speedBandStr === '--' && speedElTarget) {
                    speedElTarget.innerHTML = `${bestBand}<span class="stat-unit">km/h</span>`;
                    if(speedLbl) speedLbl.innerText = "TỐC ĐỘ PHỔ BIẾN";
                }
                
                bars = []; maxVal = 0;
                for (let key in speedBands) {
                    let d = parseFloat(speedBands[key].toFixed(1));
                    if (d > maxVal) maxVal = d;
                    bars.push({ label: key, val: d, unit: 'km' }); 
                }
                hasSensorData = true; 
            } else if (speedBandStr === '--' && speedElTarget) {
                speedElTarget.innerHTML = '--';
            }
        }
        
        if (hasSensorData && bars.length > 0) {
            bars.sort((a,b) => {
               let aNum = parseInt(a.label.split('-')[0].replace('>', '')) || 0;
               let bNum = parseInt(b.label.split('-')[0].replace('>', '')) || 0;
               return aNum - bNum;
            });
            bars.forEach(b => {
                let pct = maxVal > 0 ? Math.round((b.val / maxVal) * 100) : 0;
                let displayVal = b.unit ? `${b.val} km` : b.val;
                htmlChart += `<div style="display:flex; align-items:center; gap:8px;"><div style="width:35px; font-size:10px; text-align:right; font-weight:bold; color:var(--secondary-text-color, #475569);">${b.label}</div><div style="flex:1; background:var(--divider-color, #e2e8f0); height:8px; border-radius:4px; overflow:hidden;"><div style="width:${pct}%; height:100%; background:${pct === 100 ? '#eab308' : '#3b82f6'}; transition: width 0.5s;"></div></div><div style="width:40px; font-size:10px; font-weight:bold; color:var(--primary-text-color, #1e3a8a);">${displayVal}</div></div>`;
            });
            dtSpeedChart.innerHTML = htmlChart;
        } else {
            dtSpeedChart.innerHTML = `<div style="text-align:center; padding:10px; color:#94a3b8; font-size:11px;">Chưa có dữ liệu chuyến đi</div>`;
        }
    }
  }

  initMap() {
    const mapEl = this.querySelector('#vf-map-canvas');
    if (!mapEl || typeof L === 'undefined' || this._map) return;
    
    this._map = L.map(mapEl, { zoomControl: false });
    L.control.zoom({ position: 'topleft', zoomInTitle: 'Phóng to', zoomOutTitle: 'Thu nhỏ' }).addTo(this._map);
    
    const zoomCtrl = mapEl.querySelector('.leaflet-control-zoom');
    if(zoomCtrl) { zoomCtrl.style.marginTop = '45px'; zoomCtrl.style.marginLeft = '12px'; zoomCtrl.style.border = 'none'; zoomCtrl.style.boxShadow = '0 4px 10px rgba(0,0,0,0.1)'; }
    
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(this._map);
    
    this._marker = L.marker([0, 0], {icon: this.getCarIcon(0, 0), opacity: 0, zIndexOffset: 1000}).addTo(this._map);
    this._polyline = L.polyline([], { color: '#2563eb', weight: 6, opacity: 0.85, lineCap: 'round', lineJoin: 'round', smoothFactor: 2.5 }).addTo(this._map);
    this._stationLayer = L.layerGroup().addTo(this._map);
    this._historyLayerGroup = L.layerGroup().addTo(this._map);
    
    new IntersectionObserver((entries) => { 
        if (entries[0].isIntersecting && this._map) setTimeout(() => this._map.invalidateSize(), 100); 
    }).observe(mapEl);
  }

  set hass(hass) {
    this._hass = hass;

    if (!this._entityPrefix) {
        for (let key in hass.states) {
            if (key.startsWith('sensor.') && key.endsWith('_trang_thai_hoat_dong')) {
                this._entityPrefix = key.replace('sensor.', '').replace('_trang_thai_hoat_dong', '');
                break;
            }
        }
    }
    const p = this._entityPrefix;
    if (!p) return; 
    
    const vinStr = p.includes('_') ? p.split('_')[1] : p;

    const getValidState = (suffix) => {
        const s = hass.states[`sensor.${p}_${suffix}`];
        return (s && s.state !== 'unavailable' && s.state !== 'unknown' && s.state !== '') ? s.state : null;
    };
    
    const getAttr = (suffix, attrKey) => {
        const s = hass.states[`sensor.${p}_${suffix}`];
        return (s && s.attributes && s.attributes[attrKey]) ? s.attributes[attrKey] : null;
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
      this.content = true;
      
      // ==========================================
      // LƯU Ý: CẤU TRÚC HTML SẠCH SẼ - KHÔNG BỊ TRÙNG LẶP ID
      // ==========================================
      this.innerHTML = `
        <ha-card class="vf-card">
          <div class="vf-card-container">
            <div class="vf-header">
              <div class="vf-title">
                <svg viewBox="0 0 512 512" fill="currentColor"><path d="M560 3586 c-132 -28 -185 -75 -359 -321 -208 -291 -201 -268 -201 -701 0 -361 3 -383 69 -470 58 -77 133 -109 311 -134 202 -29 185 -21 199 -84 14 -62 66 -155 119 -209 110 -113 277 -165 430 -133 141 29 269 125 328 246 l29 59 1115 0 1115 0 29 -59 c60 -123 201 -226 345 -250 253 -43 499 137 543 397 34 203 -77 409 -268 500 -69 33 -89 38 -172 41 -116 5 -198 -15 -280 -67 -116 -76 -195 -193 -214 -321 -6 -36 -12 -71 -14 -77 -5 -19 -2163 -19 -2168 0 -2 6 -8 41 -14 77 -19 128 -98 245 -214 321 -82 52 -164 72 -280 67 -82 -3 -103 -8 -168 -40 -41 -19 -94 -52 -117 -72 -55 -48 -115 -139 -137 -209 -21 -68 -13 -66 -196 -37 -69 11 -128 20 -132 20 -17 0 -82 67 -94 97 -10 23 -14 86 -14 228 l0 195 60 0 c48 0 63 4 80 22 24 26 58 10 88 -12 22 -61 40 -111 40 l-39 0 0 43 c1 23 9 65 18 93 20 58 264 406 317 453 43 37 120 61 198 61 52 0 58 -2 53 -17 -4 -10 -48 -89 -98 -177 -70 -122 -92 -170 -95 -205 -5 -56 19 -106 67 -138 l33 -23 1511 0 c867 0 1583 -4 1680 -10 308 -18 581 -60 788 -121 109 -32 268 -103 268 -119 0 -6 -27 -10 -60 -10 -68 0 -100 -21 -100 -66 0 -63 40 -84 161 -84 l79 0 0 -214 c0 -200 -1 -215 -20 -239 -13 -16 -35 -29 -58 -33 -88 -16 -113 -102 -41 -140 81 -41 228 49 259 160 8 29 11 119 8 292 l-3 249 -32 67 c-45 96 -101 152 -197 197 -235 112 -604 187 -1027 209 l-156 9 -319 203 c-176 112 -359 223 -409 246 -116 56 -239 91 -366 104 -149 15 -1977 12 -2049 -4z m800 -341 l0 -205 -335 0 -336 0 12 23 c7 12 59 104 116 205 l105 182 219 0 219 0 0 -205z m842 15 c14 -102 27 -193 27 -202 1 -17 -23 -18 -359 -18 l-360 0 0 198 c0 109 3 202 7 205 4 4 153 6 332 5 l326 -3 27 -185z m528 157 c52 -14 125 -38 161 -55 54 -24 351 -206 489 -299 l35 -23 -516 0 -516 0 -26 188 c-15 103 -27 196 -27 206 0 18 7 19 153 13 112 -5 177 -12 247 -30z m-1541 -1132 c115 -63 176 -174 169 -305 -16 -272 -334 -402 -541 -221 -20 18 -51 63 -69 99 -28 57 -33 77 -33 142 0 65 5 85 33 142 37 76 93 128 169 159 75 30 200 23 272 -16z m3091 16 c110 -42 192 -149 207 -269 18 -159 -101 -319 -264 -352 -134 -28 -285 47 -350 174 -37 72 -43 180 -14 257 35 91 107 162 200 195 55 20 162 17 221 -5z"></path></svg>
                <span id="vf-name">Đang tải...</span>
              </div>
              <div class="vf-odo"><div class="vf-odo-label">ODOMETER</div><div class="vf-odo-value"><span id="vf-odo-int"></span> <span class="vf-odo-unit">km</span></div></div>
            </div>

            <div class="vf-car-stage" id="vf-car-stage">
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
                <div class="charging-left">
                    <div class="charging-title"><ha-icon icon="mdi:ev-plug-type2"></ha-icon><span id="vf-charge-status-text">Hệ thống đang sạc</span></div>
                    <div class="charging-details">Giới hạn: <span id="vf-charge-limit" style="font-weight:bold; margin-left:4px;">--%</span><span style="margin:0 8px;opacity:0.5;">|</span>Công suất: <span id="vf-charge-power" style="font-weight:bold; margin-left:4px;">-- kW</span></div>
                </div>
                <div class="charging-right">
                    <span id="vf-charge-time" class="charging-time">--</span>
                    <div class="charging-time-label"><span>phút</span><span>còn lại</span></div>
                </div>
            </div>

            <div class="vf-remote-bar" id="vf-remote-controls">
                <div class="remote-btn" id="btn-rc-lock" title="Khóa cửa"><ha-icon icon="mdi:lock"></ha-icon></div>
                <div class="remote-btn" id="btn-rc-unlock" title="Mở cửa"><ha-icon icon="mdi:lock-open"></ha-icon></div>
                <div class="remote-btn" id="btn-rc-horn" title="Bấm còi"><ha-icon icon="mdi:bullhorn"></ha-icon></div>
                <div class="remote-btn" id="btn-rc-lights" title="Nháy đèn"><ha-icon icon="mdi:car-light-high"></ha-icon></div>
            </div>

            <div class="vf-stats-grid">
              <div class="stat-box clickable" id="box-batt-range">
                <div class="box-main">
                  <ha-icon id="icon-batt-range" icon="mdi:battery-charging-60" style="color: #10b981;"></ha-icon>
                  <div class="stat-info"><div class="stat-label" id="lbl-batt-range">MỨC PIN</div><div class="stat-val" id="vf-stat-batt-range">--</div></div>
                </div>
              </div>
              <div class="stat-box clickable" id="box-sensors">
                <div class="box-main">
                  <ha-icon icon="mdi:car-cog" style="color: #8b5cf6;"></ha-icon>
                  <div class="stat-info"><div class="stat-label">CẢM BIẾN</div><div class="stat-val" id="vf-stat-sensors" style="font-size: 13px;">--</div></div>
                </div>
              </div>

              <div class="stat-detail-container" id="detail-container-1">
                  <div class="stat-detail-content" id="detail-batt-range">
                      <div class="detail-row"><span>Sức khỏe Pin (SOH):</span> <b id="dt-soh" style="color:#10b981;">--</b></div>
                      <div class="detail-row"><span>Hiệu suất sạc cuối:</span> <b id="dt-charge-eff" style="color:#f59e0b;">--</b></div>
                      <div class="detail-row"><span>Thực tế (Đầy 100%):</span> <b id="dt-range-ai" style="color:#3b82f6;">--</b></div>
                      <div class="detail-row" style="border-bottom:none; padding-bottom:0;">
                          <div style="display:flex; flex-direction:column; gap:8px; width:100%; margin-top:5px;">
                              <div style="display:flex; justify-content:space-between; align-items:center; background:var(--primary-background-color, white); padding:8px 12px; border-radius:8px; border:1px solid var(--divider-color, #e2e8f0);">
                                  <div style="display:flex; align-items:center; gap:6px; color:var(--secondary-text-color, #475569);"><ha-icon icon="mdi:leaf-off" style="color:#ef4444; --mdc-icon-size:16px;"></ha-icon>Hao hụt dự kiến:</div>
                                  <b id="dt-range-drop-trip" style="font-size:13px; color:#ef4444;">--</b>
                              </div>
                          </div>
                      </div>
                  </div>
                  <div class="stat-detail-content" id="detail-sensors" style="padding:10px;">
                      <div id="sensor-list-container" style="max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;"></div>
                  </div>
              </div>

              <div class="stat-box clickable" id="box-eff">
                <div class="box-main">
                  <ha-icon icon="mdi:leaf" style="color: #10b981;"></ha-icon>
                  <div class="stat-info"><div class="stat-label" id="lbl-eff">HIỆU SUẤT TB</div><div class="stat-val" id="vf-stat-eff">--</div></div>
                </div>
              </div>
              <div class="stat-box clickable" id="box-speed">
                <div class="box-main">
                  <ha-icon icon="mdi:chart-bell-curve" style="color: #eab308;"></ha-icon>
                  <div class="stat-info"><div class="stat-label" id="lbl-speed-title">TỐC ĐỘ TỐI ƯU</div><div class="stat-val" id="vf-stat-speed">--</div></div>
                </div>
              </div>

              <div class="stat-detail-container" id="detail-container-2">
                  <div class="stat-detail-content" id="detail-eff">
                      <div class="detail-row"><span>Tổng điện vòng đời:</span> <b id="dt-total-kwh" style="color:#f59e0b;">--</b></div>
                      <div class="detail-row"><span>Tổng tiền sạc:</span> <b id="dt-total-cost">--</b></div>
                  </div>
                  <div class="stat-detail-content" id="detail-speed">
                      <div style="font-size:10px; color:var(--secondary-text-color, #64748b); margin-bottom:6px;">Phân tích theo dải tốc độ:</div>
                      <div id="dt-speed-chart" style="display:flex; flex-direction:column; gap:4px;">Chưa đủ dữ liệu AI</div>
                  </div>
              </div>
              
              <div class="stat-box clickable" id="box-trip">
                <div class="box-main">
                  <ha-icon icon="mdi:map-marker-path" style="color: #8b5cf6;"></ha-icon>
                  <div class="stat-info"><div class="stat-label">TRIP HIỆN TẠI</div><div class="stat-val" id="vf-stat-trip">--</div></div>
                </div>
              </div>
              <div class="stat-box clickable" id="box-charge">
                <div class="box-main">
                  <ha-icon icon="mdi:ev-station" style="color: #f59e0b;"></ha-icon>
                  <div class="stat-info"><div class="stat-label">LỊCH SỬ SẠC</div><div class="stat-val" id="vf-stat-charge-count">--</div></div>
                </div>
              </div>
              
              <div class="stat-detail-container" id="detail-container-3">
                  <div class="stat-detail-content" id="detail-trip">
                      <div class="detail-row"><span>Tốc độ trung bình:</span> <b id="dt-trip-avg-speed">--</b></div>
                      <div class="detail-row"><span>Tiêu thụ chuyến:</span> <b id="dt-trip-energy" style="color:#eab308;">--</b></div>
                  </div>
                  <div class="stat-detail-content" id="detail-charge" style="padding:0; overflow:hidden;">
                      <div style="padding:15px; border-bottom:1px solid var(--divider-color, #e2e8f0); display:flex; gap:10px; background:var(--secondary-background-color, #f8fafc);">
                          <div style="flex:1; background:var(--primary-background-color, white); padding:10px; border-radius:8px; border:1px solid var(--divider-color, #e2e8f0); text-align:center;">
                              <div style="font-size:10px; color:var(--secondary-text-color, #64748b); font-weight:bold;">SẠC TRẠM</div>
                              <div style="font-size:18px; font-weight:900; color:#2563eb;" id="inline-pub-sessions">--</div>
                          </div>
                          <div style="flex:1; background:var(--primary-background-color, white); padding:10px; border-radius:8px; border:1px solid var(--divider-color, #e2e8f0); text-align:center;">
                              <div style="font-size:10px; color:var(--secondary-text-color, #64748b); font-weight:bold;">SẠC NHÀ</div>
                              <div style="font-size:18px; font-weight:900; color:#10b981;"><span id="inline-home-sessions">--</span><span style="font-size:11px; font-weight:normal; color:var(--secondary-text-color, #64748b);"> lần</span></div>
                              <div style="font-size:10px; color:#10b981; font-weight:bold; margin-top:2px;"><span id="inline-home-kwh">--</span> kWh</div>
                          </div>
                      </div>
                      <div style="padding:10px 15px; font-size:11px; font-weight:bold; color:var(--secondary-text-color, #94a3b8); text-transform:uppercase; background:var(--primary-background-color, white);">Lần sạc gần nhất</div>
                      <div id="vf-inline-charge-list" style="max-height: 200px; overflow-y: auto; background:var(--primary-background-color, white); padding:0 15px 10px 15px;"></div>
                  </div>
              </div>
            </div> 

            <div id="vf-ai-advisor-container" style="display: none; background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); border-radius: 16px; padding: 15px; margin-bottom: 16px; color: white; box-shadow: 0 4px 15px rgba(37,99,235,0.2); transition: all 0.3s ease;">
                <div id="vf-ai-header" style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
                    <div style="display: flex; align-items: center; gap: 8px; font-weight: bold; font-size: 14px;">
                        <ha-icon icon="mdi:robot-outline" style="color: #60a5fa;"></ha-icon>
                        Chuyên gia AI Đánh giá
                    </div>
                    <ha-icon id="vf-ai-chevron" icon="mdi:chevron-up" style="transition: transform 0.3s ease;"></ha-icon>
                </div>
                <div id="vf-ai-content" style="max-height: 200px; margin-top: 8px; overflow: hidden; transition: all 0.5s ease;">
                    <div id="vf-ai-text" style="font-size: 12px; line-height: 1.5; color: #e2e8f0; font-style: italic;">
                        Đang chờ phân tích chuyến đi...
                    </div>
                </div>
            </div>

            <div class="vf-address-bar" id="vf-address-container">
                <ha-icon icon="mdi:map-marker-radius" style="color: #ef4444; flex-shrink: 0;"></ha-icon>
                <span id="vf-current-address" style="font-weight: 600; color: var(--primary-text-color, #1f2937); font-size: 13px;">Đang tải vị trí hiện tại...</span>
            </div>

            <div class="map-and-cal-wrapper">
              <div class="cal-toggle-btn glass-panel" id="btn-toggle-cal" title="Xem Lịch sử hành trình">
                  <ha-icon id="icon-cal-mode" icon="mdi:calendar-month" style="color: #334155; --mdc-icon-size:20px;"></ha-icon>
                  <ha-icon id="icon-live-indicator" icon="mdi:record-circle" style="color: #ef4444; position: absolute; top: -2px; right: -2px; animation: pulseRed 2s infinite; --mdc-icon-size:12px;"></ha-icon>
              </div>

              <div class="cal-dropdown" id="cal-dropdown">
                  <button id="btn-live-mode" style="width:100%; background:#ef4444; color:white; border:none; padding:10px; border-radius:10px; font-weight:bold; cursor:pointer; margin-bottom:10px; display:flex; justify-content:center; align-items:center; gap:6px;">
                      <ha-icon icon="mdi:record-circle-outline" style="--mdc-icon-size:18px;"></ha-icon> TRỞ VỀ LIVE
                  </button>
                  <div class="cal-header">
                      <button class="cal-btn" id="btn-prev-month"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
                      <span id="cal-month-year">Đang tải...</span>
                      <button class="cal-btn" id="btn-next-month"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
                  </div>
                  <div class="cal-grid" id="cal-grid"></div>
              </div>

              <div class="vf-map-container">
                  <div id="vf-map-canvas" style="width:100%; height:100%; background:var(--secondary-background-color, #e5e7eb); z-index:1;"></div>
                  
                  <div class="map-controls glass-panel" id="map-controls">
                    <button class="map-btn" id="btn-locate" title="Định vị xe"><ha-icon icon="mdi:crosshairs-gps"></ha-icon></button>
                    
                    <div id="live-tools" style="display:contents;">
                        <div class="map-divider"></div>
                        <div style="position:relative; display:flex; flex-direction:column; align-items:center;">
                            <button class="map-btn" id="btn-stations" title="Tắt/Bật Trạm sạc"><ha-icon icon="mdi:ev-station" style="color:#2563eb;"></ha-icon></button>
                            <button class="map-btn text-btn" id="btn-filter-station" style="display:none; height:18px; margin-top:2px;" title="Lọc trạm AC/DC">ALL</button>
                        </div>
                    </div>

                    <div id="history-tools" style="display:none; flex-direction:column; gap:4px;">
                        <div class="map-divider"></div>
                        <button class="map-btn" id="btn-replay" title="Phát lại Lộ trình"><ha-icon id="icon-replay" icon="mdi:play-circle" style="color:#10b981;"></ha-icon></button>
                        <div class="map-divider"></div>
                        <button class="map-btn" id="btn-fix-map" title="Nắn lại bản đồ bằng AI"><ha-icon icon="mdi:magic-staff" style="color:#8b5cf6;"></ha-icon></button>
                    </div>
                  </div>

                  <div id="vf-smart-suggestion" style="display:none; position:absolute; bottom:12px; left:50%; transform:translateX(-50%); background:var(--card-background-color, rgba(255,255,255,0.95)); backdrop-filter:blur(10px); padding:12px; border-radius:12px; box-shadow:0 10px 25px rgba(0,0,0,0.2); width:85%; z-index:1000; border:2px solid #f59e0b;">
                     <div style="font-size:11px; color:#f59e0b; font-weight:800; margin-bottom:4px; display:flex; align-items:center; gap:4px;"><ha-icon icon="mdi:alert" style="--mdc-icon-size:14px;"></ha-icon> PIN THẤP - GỢI Ý SẠC TRÊN TUYẾN</div>
                     <div id="vf-suggest-name" style="font-size:14px; font-weight:bold; color:var(--primary-text-color, #1e3a8a); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">--</div>
                     <div style="font-size:12px; color:var(--secondary-text-color, #475569); margin-top:2px;">Phía trước <b id="vf-suggest-dist">--</b> km • <b id="vf-suggest-power">--</b> kW • Trống: <b id="vf-suggest-avail" style="color:#16a34a;">--</b></div>
                     <button id="btn-suggest-nav" style="margin-top:8px; width:100%; background:#2563eb; color:white; border:none; border-radius:8px; padding:6px; font-weight:bold; cursor:pointer;">Dẫn đường ngay</button>
                  </div>
              </div>
            </div>

            <div class="stats-panel" id="stats-panel" style="display:none;">
                <div class="stat-endpoint">
                    <div class="endpoint-icon icon-a">A</div>
                    <div class="endpoint-info">
                        <div class="endpoint-time" id="stat-time-a">--:--</div>
                        <div class="endpoint-address" id="stat-addr-a">Đang lấy vị trí...</div>
                    </div>
                </div>
                
                <div class="stat-trip-metrics">
                    <div class="metric-item" title="Quãng đường"><ha-icon icon="mdi:road-variant" style="color:#8b5cf6;"></ha-icon> <div class="metric-text"><span id="stat-dist">0 km</span><span>Quãng đường</span></div></div>
                    <div class="metric-item" title="Thời gian lái xe"><ha-icon icon="mdi:steering" style="color:#2563eb;"></ha-icon> <div class="metric-text"><span id="stat-drive">0p</span><span>Lái xe</span></div></div>
                    <div class="metric-item" title="Dừng chờ (<15p)"><ha-icon icon="mdi:timer-sand" style="color:#f59e0b;"></ha-icon> <div class="metric-text"><span id="stat-pause">0p</span><span>Dừng chờ</span></div></div>
                    <div class="metric-item" title="Đỗ xe (>15p)"><ha-icon icon="mdi:parking" style="color:#ef4444;"></ha-icon> <div class="metric-text"><span id="stat-park">0p</span><span>Đỗ xe</span></div></div>
                    <div class="metric-item" id="metric-charge" style="display: none;" title="Thời gian sạc"><ha-icon icon="mdi:ev-plug-type2" style="color:#10b981;"></ha-icon> <div class="metric-text"><span id="stat-charge">0p</span><span>Sạc pin</span></div></div>
                    <div class="metric-item" title="Tốc độ tối đa"><ha-icon icon="mdi:speedometer" style="color:#64748b;"></ha-icon> <div class="metric-text"><span id="stat-speed">0 km/h</span><span>Max Speed</span></div></div>
                </div>

                <div class="stat-endpoint">
                    <div class="endpoint-icon icon-b">B</div>
                    <div class="endpoint-info">
                        <div class="endpoint-time" id="stat-time-b">--:--</div>
                        <div class="endpoint-address" id="stat-addr-b">Đang lấy vị trí...</div>
                    </div>
                </div>
            </div>

          </div>
        </ha-card>
      `;

      const style = document.createElement('style');
      style.textContent = `
        @import url('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
        .leaflet-control-attribution { display: none !important; }
        .vf-card { isolation: isolate; border-radius: 24px; background: var(--card-background-color, #ffffff); box-shadow: 0 4px 20px rgba(0,0,0,0.05); font-family: -apple-system, sans-serif;}
        .vf-card-container { padding: 20px; }
        .vf-header { display: flex; justify-content: space-between; margin-bottom: 10px; }
        .vf-title { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 700; color: var(--primary-text-color, #1f2937);} .vf-title svg {width: 24px; color: #2563eb;}
        .vf-odo { text-align: right; } .vf-odo-label {font-size: 10px; font-weight: 800; color: #2563eb;} .vf-odo-value {font-size: 24px; font-weight: 800; color: var(--primary-text-color, #1f2937);}
        .vf-car-stage { position: relative; height: 220px; display: flex; justify-content: center; align-items: center; margin-bottom: 5px; transition: filter 0.3s;}
        .vf-car-stage.low-battery { filter: drop-shadow(0 0 15px rgba(239,68,68,0.3)); }
        .vf-car-stage img { max-width: 90%; max-height: 100%; filter: drop-shadow(0 20px 20px rgba(0,0,0,0.2)); z-index: 1;}
        .vf-status-badge { position: absolute; top: -10px; right: 0; background: #2563eb; color: white; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: bold; z-index: 5;}
        .vf-tire { position: absolute; background: var(--card-background-color, rgba(255,255,255,0.85)); backdrop-filter: blur(8px); padding: 4px 8px; border-radius: 12px; border: 1px solid var(--divider-color, #e5e7eb); font-size: 11px; font-weight: 800; color: var(--primary-text-color, #1f2937); text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.05); z-index: 5; }
        .vf-tire ha-icon { --mdc-icon-size: 14px; color: var(--secondary-text-color, #6b7280); } .tire-unit { font-size: 9px; font-weight: 600; color: var(--secondary-text-color, #6b7280); }
        .vf-tire-fl { bottom: 10%; left: 0; } .vf-tire-fr { top: 15%; left: 0; } .vf-tire-rl { bottom: 10%; right: 0; } .vf-tire-rr { top: 15%; right: 0; }
        .vf-controls-area { display: flex; justify-content: center; gap: 16px; margin-bottom: 12px; align-items: center;}
        .vf-gears { display: flex; background: var(--secondary-background-color, rgba(243,244,246,0.8)); padding: 8px 20px; border-radius: 30px; gap: 20px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.05);}
        .gear { font-size: 16px; font-weight: 800; color: var(--secondary-text-color, #9ca3af); transition: all 0.3s; position: relative;} 
        .gear.active {color: #2563eb; transform: scale(1.2);} .gear.active::after { content: ''; position: absolute; bottom: -4px; left: 50%; transform: translateX(-50%); width: 4px; height: 4px; background: #2563eb; border-radius: 50%; }
        .vf-speed { display: flex; align-items: baseline; background: rgba(37,99,235,0.1); border: 2px solid rgba(37,99,235,0.3); padding: 6px 20px; border-radius: 30px;}
        .vf-speed span:first-child { font-size: 28px; font-weight: 900; color: #2563eb; } .vf-speed-unit { font-size: 11px; font-weight: bold; color: #2563eb; margin-left: 4px;}
        .vf-doors-status { display: flex; gap: 8px; justify-content: center; width: 100%; flex-wrap: wrap; margin-bottom: 15px;}
        .door-badge { display: flex; align-items: center; gap: 4px; padding: 4px 12px; border-radius: 12px; font-size: 11px; font-weight: bold; background: var(--card-background-color, rgba(255,255,255,0.95)); border: 1px solid var(--divider-color, #e5e7eb); box-shadow: 0 2px 6px rgba(0,0,0,0.1); color: var(--primary-text-color, #374151);}
        .door-badge.open { background: rgba(239, 68, 68, 0.1); border-color: #ef4444; color: #ef4444; animation: pulseRed 1.5s infinite; }
        .door-badge.open.warning { background: rgba(245, 158, 11, 0.1); border-color: #f59e0b; color: #f59e0b; animation: pulseOrange 2s infinite; }
        .door-badge ha-icon { --mdc-icon-size: 15px; }
        @keyframes pulseRed { 0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); } 70% { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); } 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); } }
        @keyframes pulseOrange { 0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.4); } 70% { box-shadow: 0 0 0 6px rgba(245, 158, 11, 0); } 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); } }
        
        .vf-charging-banner { display: flex; align-items: center; justify-content: space-between; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 15px 20px; border-radius: 16px; margin-bottom: 16px; animation: pulseChargeGlow 2.5s infinite; }
        .charging-left { display: flex; flex-direction: column; gap: 4px; }
        .charging-title { font-size: 15px; font-weight: 800; display:flex; align-items:center; gap:8px; line-height: 1.2;}
        .charging-title ha-icon { --mdc-icon-size: 20px; }
        .charging-details { font-size: 12px; display:flex; align-items:center; opacity: 0.9;}
        .charging-right { display: flex; align-items: baseline; gap: 4px; text-align: right;}
        .charging-time { font-size: 28px; font-weight: 900; line-height: 1;}
        .charging-time-label { font-size: 11px; display: flex; flex-direction: column; text-align: left; line-height: 1.2; opacity: 0.9;}
        @keyframes pulseChargeGlow { 0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.5); } 70% { box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); } 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); } }

        .vf-remote-bar { display: flex; justify-content: center; gap: 15px; margin-bottom: 20px; padding: 10px; background: var(--secondary-background-color, rgba(243,244,246,0.5)); border-radius: 16px;}
        .remote-btn { display: flex; align-items: center; justify-content: center; width: 45px; height: 45px; background: var(--card-background-color, white); border: 1px solid var(--divider-color, #e5e7eb); border-radius: 50%; color: var(--primary-text-color, #4b5563); cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.05); transition: all 0.2s ease;}
        .remote-btn ha-icon { --mdc-icon-size: 22px; } .remote-btn:hover { background: rgba(37,99,235,0.1); color: #2563eb; transform: translateY(-2px);}
        
        .vf-stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 20px; }
        .stat-box { display: flex; align-items: center; gap: 8px; background: var(--secondary-background-color, rgba(243, 244, 246, 0.6)); padding: 10px; border-radius: 12px; border: 1px solid var(--divider-color, rgba(229, 231, 235, 0.8)); transition: all 0.2s; cursor: pointer; height: 60px; box-sizing: border-box; }
        .stat-box:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.08); background: var(--card-background-color, white); }
        .stat-box.active-box { border-color: #2563eb; background: var(--card-background-color, white); box-shadow: 0 4px 12px rgba(37,99,235,0.15); transform: translateY(-2px); }
        
        .box-main { display: flex; align-items: center; gap: 8px; width: 100%; }
        .box-main ha-icon { flex-shrink: 0; --mdc-icon-size: 22px; }
        .stat-info { display: flex; flex-direction: column; min-width: 0; width: 100%; justify-content: center; overflow: hidden; height: 40px; }
        .stat-label { font-size: 10px; font-weight: 700; color: var(--secondary-text-color, #6b7280); text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; transition: color 0.3s;}
        .stat-val { font-size: 14px; font-weight: 800; color: var(--primary-text-color, #1f2937); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: opacity 0.3s ease-in-out; line-height: 1.2; display: block; }
        .stat-unit { font-size: 0.7em; font-weight: 600; color: var(--secondary-text-color, #6b7280); margin-left: 3px; }
        
        .stat-detail-container { grid-column: 1 / -1; display: none; animation: slideDown 0.2s ease-out; transform-origin: top; margin-top: -5px; }
        .stat-detail-content { background: var(--secondary-background-color, #f8fafc); border-radius: 12px; padding: 15px; border: 1px solid var(--divider-color, #93c5fd); box-shadow: inset 0 2px 4px rgba(0,0,0,0.02); display: none; color: var(--primary-text-color, #1f2937);}
        .detail-row { display: flex; justify-content: space-between; font-size: 12px; color: var(--primary-text-color, #475569); padding: 6px 0; border-bottom: 1px dashed var(--divider-color, #e2e8f0); }
        .detail-row:last-child { border-bottom: none; padding-bottom: 0; }
        @keyframes slideDown { from { opacity: 0; transform: scaleY(0.95); } to { opacity: 1; transform: scaleY(1); } }
        
        .vf-address-bar { background: var(--secondary-background-color, #f3f4f6); border-radius: 12px; padding: 12px 16px; margin-bottom: 16px; display: flex; align-items: center; gap: 10px; border: 1px solid var(--divider-color, #e5e7eb);}
        .map-and-cal-wrapper { position: relative; z-index: 2; margin-bottom: 12px; }
        .vf-map-container { position:relative; border-radius:16px; overflow:hidden; border:1px solid var(--divider-color, #e5e7eb); width: 100%; height: 45vh; min-height: 350px; z-index: 1;}
        
        .glass-panel { background: rgba(255, 255, 255, 0.75); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.5); box-shadow: 0 4px 10px rgba(0,0,0,0.1); border-radius: 10px; display: flex; }
        
        .cal-toggle-btn { position: absolute; top: 10px; left: 10px; z-index: 1000; padding: 6px; cursor: pointer; align-items: center; justify-content: center; transition: 0.2s;}
        .cal-toggle-btn:hover { background: rgba(255,255,255,1); transform: scale(1.05); }
        
        .cal-dropdown { position: absolute; top: 50px; left: 10px; z-index: 1001; background: white; border-radius: 14px; padding: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); width: calc(100% - 20px); max-width: 320px; display: none; flex-direction: column; border: 1px solid #e2e8f0; box-sizing: border-box;}
        .cal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-weight: 700; color: #0f172a; font-size: 15px;}
        .cal-btn { background: transparent; border: none; cursor: pointer; font-size: 16px; padding: 6px; border-radius: 8px; display: flex; align-items: center; justify-content: center;}
        .cal-btn:hover { background: #f1f5f9; }
        .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; text-align: center;}
        .cal-day-name { font-weight: 700; color: #64748b; font-size: 11px; margin-bottom: 4px; display: flex; align-items: center; justify-content: center;}
        .cal-day { padding: 0; margin: 0; width: 100%; border-radius: 50%; cursor: pointer; position: relative; color: #334155; aspect-ratio: 1; display: flex; align-items: center; justify-content: center; box-sizing: border-box; font-weight: 600; font-size: clamp(11px, 3.5vw, 13px); border: 2px solid transparent;}
        .cal-day:hover { background: #e0f2fe; }
        .cal-day.disabled { color: #cbd5e1; cursor: default; } .cal-day.disabled:hover { background: transparent; }
        .cal-day.today { border-color: #f59e0b; color: #d97706; font-weight: 700; } 
        .cal-day.active { background: #2563eb; color: white; font-weight: 700; border-color: #2563eb; box-shadow: 0 4px 10px rgba(37, 99, 235, 0.4);}
        .cal-day.has-trip::after { content: ''; position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%); width: 4px; height: 4px; background-color: #10b981; border-radius: 50%; }
        .cal-day.active.has-trip::after { background-color: white; }

        .stats-panel { background: var(--card-background-color, #ffffff); border-radius: 16px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); display: none; flex-direction: column; gap: 4px; border: 1px solid var(--divider-color, #e5e7eb); margin-bottom: 16px;}
        .stat-endpoint { display: flex; align-items: center; gap: 12px; }
        .endpoint-icon { width: 28px; height: 28px; border-radius: 50%; color: white; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 13px; flex-shrink: 0; }
        .icon-a { background: #10b981; box-shadow: 0 2px 5px rgba(16, 185, 129, 0.3); }
        .icon-b { background: #ef4444; box-shadow: 0 2px 5px rgba(239, 68, 68, 0.3); }
        .endpoint-info { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
        .endpoint-time { font-weight: 800; font-size: 14px; color: #0f172a; line-height: 1.2;}
        .endpoint-address { font-size: 12px; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        
        .stat-trip-metrics { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 0; margin: 4px 0 4px 13px; border-left: 2px dashed #cbd5e1; padding-left: 24px; }
        .metric-item { flex: 1 1 calc(33.333% - 8px); min-width: 80px; display: flex; align-items: center; gap: 8px; background: #f8fafc; padding: 8px; border-radius: 8px; border: 1px solid #e2e8f0; }
        .metric-item ha-icon { --mdc-icon-size: 18px; }
        .metric-text { display: flex; flex-direction: column; }
        .metric-text span:first-child { font-weight: 800; font-size: 13px; color: #0f172a; line-height: 1.2;}
        .metric-text span:last-child { font-size: 10px; color: #64748b; }

        .map-controls { position: absolute; top: 12px; right: 12px; z-index: 400; flex-direction: column; gap: 4px; padding: 6px; }
        .map-btn { width: 34px; height: 34px; background: transparent; border: none; border-radius: 8px; cursor: pointer; display:flex; align-items:center; justify-content:center; color: #334155; transition: 0.2s;}
        .map-btn:hover { background: rgba(255,255,255,1); transform: scale(1.1); }
        .map-btn ha-icon { --mdc-icon-size: 18px; }
        
        .text-btn { font-size: 10px; font-weight: 800; color: #f59e0b; width: 100%; padding: 0; height: 20px; background: rgba(255,255,255,0.6); border-radius: 4px; margin-top: -2px;}
        .map-divider { height: 1px; background: rgba(0,0,0,0.1); margin: 2px 6px; }

        /* TÙY CHỈNH POPUP LEAFLET */
        .leaflet-popup-content-wrapper { border-radius: 12px !important; padding: 0 !important; box-shadow: 0 10px 25px rgba(0,0,0,0.2) !important; border: 1px solid #e2e8f0;}
        .leaflet-popup-content { margin: 12px !important; line-height: 1.4; }
        .leaflet-popup-tip { background: white !important; }

        .marker-start { background: #10b981; border: 2px solid white; border-radius: 50%; box-shadow: 0 3px 6px rgba(0,0,0,0.3); width: 14px !important; height: 14px !important; margin-top:-7px; margin-left:-7px;}
        .marker-park { background: #ef4444; border: 2px solid white; border-radius: 50%; color: white; display: flex; justify-content: center; align-items: center; font-size: 10px; font-weight: bold; width: 18px !important; height: 18px !important; margin-top:-9px; margin-left:-9px; box-shadow: 0 3px 6px rgba(0,0,0,0.3);}
        .marker-pause { background: #f59e0b; border: 2px solid white; border-radius: 50%; width: 12px !important; height: 12px !important; margin-top:-6px; margin-left:-6px; box-shadow: 0 3px 6px rgba(0,0,0,0.3);}
        .marker-end-flag { font-size: 20px; line-height: 1; filter: drop-shadow(0 3px 3px rgba(0,0,0,0.3)); margin-top:-20px; margin-left:-10px;}
        .marker-continue { background: #3b82f6; border: 2px solid white; border-radius: 50%; color: white; display: flex; justify-content: center; align-items: center; font-size: 10px; font-weight: bold; width: 18px !important; height: 18px !important; margin-top:-9px; margin-left:-9px; box-shadow: 0 3px 6px rgba(0,0,0,0.3);}
      `;
      this.appendChild(style);

      const toggleBtn = this.querySelector('#btn-toggle-cal');
      const dropdown = this.querySelector('#cal-dropdown');
      if (toggleBtn && dropdown) {
          toggleBtn.onclick = () => { dropdown.style.display = dropdown.style.display === 'flex' ? 'none' : 'flex'; };
      }
      const mapCanvas = this.querySelector('#vf-map-canvas');
      if (mapCanvas) {
          mapCanvas.onclick = () => { if (dropdown) dropdown.style.display = 'none'; };
      }
      
      const btnLiveMode = this.querySelector('#btn-live-mode');
      if (btnLiveMode) {
          btnLiveMode.onclick = () => {
              this._selectedDateStr = 'LIVE';
              this.renderCalendar();
              this.switchMode();
              dropdown.style.display = 'none';
          }
      }

      this.querySelector('#btn-prev-month').addEventListener('click', () => this.changeMonth(-1));
      this.querySelector('#btn-next-month').addEventListener('click', () => this.changeMonth(1));

      this.toggleExpand = (boxId, detailId, containerId) => {
          const box = this.querySelector(boxId); const detail = this.querySelector(detailId); const container = this.querySelector(containerId);
          if (!box || !detail || !container) return;
          const isExpanded = box.classList.contains('active-box');
          this.querySelectorAll('.stat-box').forEach(el => el.classList.remove('active-box'));
          this.querySelectorAll('.stat-detail-container').forEach(el => el.style.display = 'none');
          this.querySelectorAll('.stat-detail-content').forEach(el => el.style.display = 'none');
          
          if (!isExpanded) {
              box.classList.add('active-box'); container.style.display = 'block'; detail.style.display = 'block';
              if (boxId === '#box-charge') this.renderChargeHistory();
          }
      };

      const aiHeader = this.querySelector('#vf-ai-header');
      const aiContent = this.querySelector('#vf-ai-content');
      const aiChevron = this.querySelector('#vf-ai-chevron');

      if (aiHeader) {
          aiHeader.onclick = () => {
              const isCollapsed = aiContent.style.maxHeight === '0px';
              if (isCollapsed) {
                  aiContent.style.maxHeight = '200px'; aiContent.style.marginTop = '8px'; aiChevron.style.transform = 'rotate(0deg)';
              } else {
                  aiContent.style.maxHeight = '0px'; aiContent.style.marginTop = '0px'; aiChevron.style.transform = 'rotate(180deg)';
              }
          };
      }

      this.renderChargeHistory = () => {
          const listEl = this.querySelector('#vf-inline-charge-list');
          if (!listEl) return;
          let html = '';
          if (this._chargeHistoryData && this._chargeHistoryData.length > 0) {
              this._chargeHistoryData.forEach(c => {
                  html += `<div style="padding:8px 0; border-bottom:1px solid var(--divider-color, #e5e7eb);">
                      <div style="font-weight:bold; font-size:11px; color:var(--primary-text-color, #1e3a8a); margin-bottom:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${c.address}</div>
                      <div style="display:flex; justify-content:space-between; font-size:10px; color:var(--secondary-text-color, #475569);"><span>${c.date}</span><span style="color:#d97706; font-weight:bold;">${c.kwh} kWh</span><span>${c.duration}p</span></div>
                  </div>`;
              });
          } else { html = `<div style="padding:10px; text-align:center; color:var(--secondary-text-color, #6b7280); font-size:11px;">Chưa có dữ liệu sạc trạm.</div>`; }
          
          const pSessions = this.querySelector('#inline-pub-sessions'); const hSessions = this.querySelector('#inline-home-sessions'); const hKwh = this.querySelector('#inline-home-kwh');
          if(pSessions) pSessions.innerText = getValidState('so_lan_sac_tai_tram') || 0;
          if(hSessions) hSessions.innerText = getValidState('so_lan_sac_tai_nha') || 0;
          if(hKwh) hKwh.innerText = getValidState('dien_nang_sac_tai_nha') || 0;
          listEl.innerHTML = html;
      };

      const attachClick = (boxId, detailId, containerId) => {
          const el = this.querySelector(boxId);
          if (el) el.onclick = () => this.toggleExpand(boxId, detailId, containerId);
      };
      
      attachClick('#box-batt-range', '#detail-batt-range', '#detail-container-1');
      attachClick('#box-sensors', '#detail-sensors', '#detail-container-1');
      attachClick('#box-eff', '#detail-eff', '#detail-container-2');
      attachClick('#box-speed', '#detail-speed', '#detail-container-2'); 
      attachClick('#box-trip', '#detail-trip', '#detail-container-3');
      attachClick('#box-charge', '#detail-charge', '#detail-container-3'); 

      const btnLocate = this.querySelector('#btn-locate');
      if (btnLocate) btnLocate.onclick = () => { 
        if(this._map && this._lastLat) this._map.setView([this._lastLat, this._lastLon], 15, {animate: true});
      };

      const btnStations = this.querySelector('#btn-stations');
      const btnFilter = this.querySelector('#btn-filter-station');

      if (btnFilter) {
          btnFilter.innerText = this._stationFilter;
          if (this._stationFilter === 'DC') btnFilter.style.color = '#dc2626';
          else if (this._stationFilter === 'AC') btnFilter.style.color = '#16a34a';
          else btnFilter.style.color = '#f59e0b';
          btnFilter.style.display = this._showStations ? 'flex' : 'none';
      }

      if (btnStations) {
          btnStations.onclick = () => {
              if (this._selectedDateStr !== 'LIVE') return;
              this._showStations = !this._showStations;
              localStorage.setItem('vf_show_stations', this._showStations);
              
              if(btnFilter) btnFilter.style.display = this._showStations ? 'flex' : 'none';
              
              if (this._showStations) {
                  this.renderStations();
                  if (this._map && this._currentStations && this._currentStations.length > 0) {
                      const lats = this._currentStations.map(s => s.lat);
                      const lngs = this._currentStations.map(s => s.lng);
                      if (this._lastLat && this._lastLon) { lats.push(this._lastLat); lngs.push(this._lastLon); }
                      const bounds = [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]];
                      this._map.fitBounds(bounds, {padding: [40, 40], maxZoom: 15});
                  }
              } else {
                  this._stationLayer.clearLayers();
              }
          };
      }
      
      if(btnFilter) {
          btnFilter.onclick = () => {
              if (this._selectedDateStr !== 'LIVE' || !this._showStations) return;
              if (this._stationFilter === 'ALL') { this._stationFilter = 'DC'; btnFilter.style.color = '#dc2626'; }
              else if (this._stationFilter === 'DC') { this._stationFilter = 'AC'; btnFilter.style.color = '#16a34a'; }
              else { this._stationFilter = 'ALL'; btnFilter.style.color = '#f59e0b'; }
              
              btnFilter.innerText = this._stationFilter;
              localStorage.setItem('vf_station_filter', this._stationFilter);
              this.renderStations();
          };
      }

      const callServiceBtn = (btnId, domain, service, entityId) => {
          const btn = this.querySelector(btnId);
          if(btn) btn.onclick = () => { if(this._hass.states[entityId]) this._hass.callService(domain, service, { entity_id: entityId }); };
      };
      callServiceBtn('#btn-rc-lock', 'button', 'press', `button.${p}_khoa_cua`);
      callServiceBtn('#btn-rc-unlock', 'button', 'press', `button.${p}_mo_cua`);
      callServiceBtn('#btn-rc-horn', 'button', 'press', `button.${p}_bam_coi`);
      callServiceBtn('#btn-rc-lights', 'button', 'press', `button.${p}_nhay_den`);

      const btnReplay = this.querySelector('#btn-replay');
      const iconReplay = this.querySelector('#icon-replay');
      
      if(btnReplay && iconReplay) {
          btnReplay.onclick = () => {
              if (!this._map || !this._marker || !this._polyline) return;
              if (this._smoothedRouteCoords.length < 2) return alert("Lộ trình hiện tại quá ngắn để phát lại!");

              if (this._isReplaying && !this._isPaused) {
                  this._isPaused = true; cancelAnimationFrame(this._animationFrameId); iconReplay.setAttribute('icon', 'mdi:play-circle');
              } else if (this._isReplaying && this._isPaused) {
                  this._isPaused = false; iconReplay.setAttribute('icon', 'mdi:pause-circle');
                  this._lastReplayTime = performance.now(); this._animationFrameId = requestAnimationFrame(this._runAnimation);
              } else {
                  this._isReplaying = true; this._isPaused = false; this._currentReplayIdx = 0; this._replayProgress = 0.0;
                  iconReplay.setAttribute('icon', 'mdi:pause-circle');
                  
                  this._marker.setOpacity(1); 
                  
                  if(this._smoothedRouteCoords[0]) this._map.setView([this._smoothedRouteCoords[0][0], this._smoothedRouteCoords[0][1]], 15);
                  this._lastReplayTime = performance.now(); this._animationFrameId = requestAnimationFrame(this._runAnimation);
              }
          };
      }

      const btnFixMap = this.querySelector('#btn-fix-map');
      if (btnFixMap) {
          btnFixMap.onclick = () => {
              if (confirm("Chạy ngầm AI (Mapbox/Stadia/OSRM) nắn thẳng lộ trình?")) {
                  const iconWand = btnFixMap.querySelector('ha-icon');
                  if(iconWand) iconWand.style.animation = 'pulseOrange 1s infinite';
                  btnFixMap.disabled = true;
                  if (this._hass && this._entityPrefix) {
                      this._hass.callService("button", "press", { entity_id: `button.${this._entityPrefix}_fix_map` })
                      .then(() => { alert("Đã gửi lệnh nắn đường! Vui lòng chờ vài phút."); setTimeout(() => { if(iconWand) iconWand.style.animation = 'none'; btnFixMap.disabled = false; }, 5000); })
                      .catch((err) => { alert("Lỗi: " + err); if(iconWand) iconWand.style.animation = 'none'; btnFixMap.disabled = false; });
                  }
              }
          };
      }
      
      this._runAnimation = (timestamp) => {
          if (!this._isReplaying || this._isPaused) return;
          let dt = (timestamp - this._lastReplayTime) / 1000.0; 
          this._lastReplayTime = timestamp;
          if (dt > 0.1) dt = 0.1; 

          if (this._currentReplayIdx >= this._smoothedRouteCoords.length - 1) {
              this._isReplaying = false; this._isPaused = false; iconReplay.setAttribute('icon', 'mdi:play-circle');
              if (this._selectedDateStr !== 'LIVE') setTimeout(() => this._marker.setOpacity(0), 2000); 
              return;
          }

          let ptA = this._smoothedRouteCoords[this._currentReplayIdx];
          let ptB = this._smoothedRouteCoords[this._currentReplayIdx + 1];

          let distAB = this.getDistanceFromLatLonInM(ptA[0], ptA[1], ptB[0], ptB[1]);
          let speedKmh = ptA[2] || 15; if (speedKmh < 15) speedKmh = 15;
          let playbackMultiplier = 15.0; let moveDist = (speedKmh / 3.6) * playbackMultiplier * dt;

          if (distAB > 0) this._replayProgress += moveDist / distAB;
          else this._replayProgress = 1.1; 

          while (this._replayProgress >= 1.0) {
              this._currentReplayIdx++; this._replayProgress -= 1.0;
              if (this._currentReplayIdx >= this._smoothedRouteCoords.length - 1) { this._replayProgress = 0; break; }
              ptA = this._smoothedRouteCoords[this._currentReplayIdx]; ptB = this._smoothedRouteCoords[this._currentReplayIdx + 1];
              distAB = this.getDistanceFromLatLonInM(ptA[0], ptA[1], ptB[0], ptB[1]);
              speedKmh = ptA[2] || 15; if (speedKmh < 15) speedKmh = 15;
              moveDist = (speedKmh / 3.6) * playbackMultiplier * dt;
              if (distAB === 0) this._replayProgress += 1.0; 
          }

          if (this._currentReplayIdx >= this._smoothedRouteCoords.length - 1) {
              let finalPt = this._smoothedRouteCoords[this._smoothedRouteCoords.length - 1];
              this._marker.setLatLng([finalPt[0], finalPt[1]]);
              this._isReplaying = false; this._isPaused = false; iconReplay.setAttribute('icon', 'mdi:play-circle');
              if (this._selectedDateStr !== 'LIVE') setTimeout(() => this._marker.setOpacity(0), 2000);
              return;
          }

          let currentLat = ptA[0] + (ptB[0] - ptA[0]) * this._replayProgress;
          let currentLon = ptA[1] + (ptB[1] - ptA[1]) * this._replayProgress;
          let currentSpeed = ptA[2] + (ptB[2] - ptA[2]) * this._replayProgress;
          let targetAngle = this.getBearing(ptA[0], ptA[1], ptB[0], ptB[1]);
          let smoothedAngle = this._smoothRotation(targetAngle);

          this._marker.setIcon(this.getCarIcon(smoothedAngle, currentSpeed));
          this._marker.setLatLng([currentLat, currentLon]);
          this._map.panTo([currentLat, currentLon], { animate: false }); 

          this._animationFrameId = requestAnimationFrame(this._runAnimation);
      };
      
      this.loadLeaflet();
      this.fetchTripHistory(vinStr);
      this.fetchChargeHistory(vinStr); 
    }

    const lat = parseFloat(getValidState('vi_do_latitude') || 0);
    const lon = parseFloat(getValidState('kinh_do_longitude') || 0);
    let name = getValidState('bien_so_ten_xe_phu');
    if (!name || name === "0" || name === "1" || name.toLowerCase() === "unknown" || name === "none" || name.toLowerCase() === "vinfast") name = getValidState('ten_dinh_danh_xe');
    if (!name || name === "0" || name === "1" || name.toLowerCase() === "unknown" || name === "none" || name.toLowerCase() === "vinfast") name = getValidState('ten_dinh_danh_xe_mqtt');
    if (!name || name === "0" || name === "1" || name.toLowerCase() === "unknown" || name === "none" || name.toLowerCase() === "vinfast") name = getValidState('ten_dong_xe');
    if (!name || name === "0" || name === "1" || name.toLowerCase() === "unknown" || name === "none" || name.toLowerCase() === "vinfast") name = 'Xe VinFast';

    const statusObj = hass.states[`sensor.${p}_trang_thai_hoat_dong`];
    let statusTextRaw = statusObj ? statusObj.state : 'N/A'; let statusText = statusTextRaw;
    if (statusObj && statusObj.last_changed) statusText += ` ${formatTimeSince(statusObj.last_changed)}`;
    
    const gear = getValidState('vi_tri_can_so') || 'P';
    const speed = getValidState('toc_do_hien_tai') || '0'; const speedNum = Math.round(Number(speed));
    const carModel = getValidState('ten_dong_xe') || "";
    
    const nameEl = this.querySelector('#vf-name');
    const weatherCondition = getValidState('thoi_tiet_hien_tai'); const outsideTemp = getValidState('nhiet_do_ngoai_troi_gps');

    if(nameEl) {
        if (weatherCondition && outsideTemp && outsideTemp !== '--') {
            nameEl.innerHTML = `<div style="display: flex; align-items: center; gap: 6px; font-size: 15px; font-weight: bold; color: var(--secondary-text-color, #64748b);"><ha-icon icon="mdi:weather-partly-cloudy" style="--mdc-icon-size: 20px; color: #00bcd4;"></ha-icon><span>${outsideTemp}°C | ${weatherCondition}</span></div>`;
        } else nameEl.innerText = name;
    }

    const statBadgeEl = this.querySelector('#vf-status-badge');
    if(statBadgeEl) statBadgeEl.innerText = statusText;
    
    const odoRaw = getValidState('tong_odo_mqtt') || getValidState('tong_odo');
    const odoEl = this.querySelector('#vf-odo-int');
    if(odoEl) odoEl.innerText = (odoRaw && !isNaN(odoRaw)) ? Math.floor(parseFloat(odoRaw)).toString() : '--';

    let rawImage = getValidState('hinh_anh_xe_url');
    const imgEl = this.querySelector('#vf-car-img');
    if (imgEl && rawImage && rawImage !== 'unknown') imgEl.src = rawImage;

    const updateTire = (id, val) => {
      const el = this.querySelector(id);
      if(el) { if (val !== null && val !== 'unknown' && val !== '') { el.style.display = 'block'; el.querySelector('span').innerText = val; } else el.style.display = 'none'; }
    };
    updateTire('#tire-fl', getValidState('ap_suat_lop_truoc_trai')); updateTire('#tire-fr', getValidState('ap_suat_lop_truoc_phai')); 
    updateTire('#tire-rl', getValidState('ap_suat_lop_sau_trai')); updateTire('#tire-rr', getValidState('ap_suat_lop_sau_phai'));

    ['P','R','N','D'].forEach(g => {
      const el = this.querySelector(`#gear-${g}`);
      if(el) { if (gear.includes(g)) el.classList.add('active'); else el.classList.remove('active'); }
    });
    
    const speedEl = this.querySelector('#vf-speed-container');
    if (!this._isReplaying && speedEl) {
        const speedDisplayEl = this.querySelector('#vf-speed');
        if (gear.includes('P') || speedNum === 0) speedEl.style.display = 'none';
        else { speedEl.style.display = 'flex'; if (speedDisplayEl) speedDisplayEl.innerText = speedNum; }
    }

    const checkSensorState = (slugs, targetState) => {
        for (let s of slugs) { const state = getValidState(s); if (state && state.toLowerCase() === targetState.toLowerCase()) return true; }
        return false;
    };

    const doorsConfig = [
        { slugs: ['cua_tai_xe'], name: 'Cửa lái', icon: 'mdi:car-door' }, { slugs: ['cua_phu'], name: 'Cửa phụ', icon: 'mdi:car-door' },
        { slugs: ['cua_sau_tai_xe', 'cua_sau_trai'], name: 'Cửa sau T', icon: 'mdi:car-door' }, { slugs: ['cua_sau_phu', 'cua_sau_phai'], name: 'Cửa sau P', icon: 'mdi:car-door' },
        { slugs: ['cop_sau'], name: 'Cốp sau', icon: 'mdi:car-back' }, { slugs: ['nap_capo'], name: 'Capo', icon: 'mdi:car' },
        { slugs: ['kinh_tai_xe', 'cua_so_tai_xe'], name: 'Kính lái', icon: 'mdi:window-open' }
    ];

    const openDoors = doorsConfig.filter(d => checkSensorState(d.slugs, 'mở') || checkSensorState(d.slugs, 'đang mở'));
    const isParked = statusTextRaw.toLowerCase().includes('đỗ') || gear.includes('P');
    const isUnlocked = checkSensorState(['khoa_tong'], 'mở khóa');
    const doorsEl = this.querySelector('#vf-doors-container');
    if (doorsEl) {
        let securityHtml = '';
        if (openDoors.length === 0 && (!isParked || !isUnlocked)) securityHtml = `<div class="door-badge" style="color: #10b981; border-color: rgba(16, 185, 129, 0.3); background: rgba(255,255,255,0.7);"><ha-icon icon="mdi:shield-check-outline"></ha-icon> An toàn</div>`;
        else {
            if (openDoors.length > 0) securityHtml += openDoors.map(d => `<div class="door-badge open"><ha-icon icon="${d.icon}"></ha-icon> ${d.name}</div>`).join('');
            if (isParked && isUnlocked) securityHtml += `<div class="door-badge open warning"><ha-icon icon="mdi:lock-open-alert"></ha-icon> Chưa khóa xe</div>`;
        }
        doorsEl.innerHTML = securityHtml;
    }

    const batt = getValidState('phan_tram_pin');
    let range = getValidState('quang_duong_du_kien');
    if (!range || range === '0' || range === '0.0' || range === '--' || range === 'unknown') {
        range = getValidState('quang_duong_con_lai_theo_hieu_suat');
        if (!range || range === '0' || range === '0.0' || range === '--' || range === 'unknown') range = getValidState('quang_duong_cong_bo_max');
    }
    const trip = getValidState('quang_duong_chuyen_di_trip');
    const tripEnergy = getValidState('dien_nang_tieu_thu_trip');
    const effKwh = getValidState('hieu_suat_tieu_thu_trung_binh_xe') || '--';
    const effRangePerPercent = getValidState('quang_duong_di_duoc_moi_1_pin') || '--';

    if (!this._effToggleTimer) {
        this._effToggleTimer = setInterval(() => {
            this._effToggleState = !this._effToggleState;
            const elements = [
                { el: this.querySelector('#vf-stat-eff'), lbl: this.querySelector('#lbl-eff') },
                { el: this.querySelector('#vf-stat-batt-range'), lbl: this.querySelector('#lbl-batt-range'), icon: this.querySelector('#icon-batt-range') }
            ];
            elements.forEach(item => {
                if (item.el) {
                    item.el.style.opacity = '0'; 
                    setTimeout(() => {
                        if (item.lbl && item.lbl.id === 'lbl-eff') {
                            if (this._effToggleState) { item.el.innerHTML = `${effRangePerPercent}<span class="stat-unit">km/1%</span>`; item.lbl.innerText = "Mỗi 1% Pin"; item.lbl.style.color = "#3b82f6"; } 
                            else { item.el.innerHTML = `${effKwh}<span class="stat-unit">kWh/100km</span>`; item.lbl.innerText = "Hiệu suất TB"; item.lbl.style.color = "#6b7280"; }
                        } else if (item.lbl) {
                            if (this._effToggleState) { item.el.innerHTML = `${range && range!=='--' ? range : '--'}<span class="stat-unit">km</span>`; item.lbl.innerText = "PHẠM VI"; item.lbl.style.color = "#3b82f6"; if(item.icon) { item.icon.setAttribute('icon', 'mdi:map-marker-distance'); item.icon.style.color = "#3b82f6"; } } 
                            else { item.el.innerHTML = `${batt && batt!=='--' ? batt : '--'}<span class="stat-unit">%</span>`; item.lbl.innerText = "MỨC PIN"; item.lbl.style.color = "#10b981"; if(item.icon) { item.icon.setAttribute('icon', 'mdi:battery-charging-60'); item.icon.style.color = "#10b981"; } }
                        }
                        item.el.style.opacity = '1';
                    }, 300);
                }
            });
        }, 5000);
    }

    const renderStat = (id, val, unit) => { const el = this.querySelector(id); if(el) { if (val && val !== 'unknown' && val !== '--') el.innerHTML = `${val}<span class="stat-unit">${unit}</span>`; else el.innerHTML = '--'; } };
    renderStat('#vf-stat-batt-range', batt, '%'); renderStat('#vf-stat-trip', trip, 'km');
    
    let phanhTay = getValidState('phanh_tay') || getValidState('phanh_tay_dien_tu');
    if (carModel.toUpperCase().includes('VF3') || carModel.toUpperCase().includes('VF 3')) {
        if (gear.includes('P')) phanhTay = 'Kéo phanh tay'; else if (gear.includes('D') || gear.includes('R') || gear.includes('N')) phanhTay = 'Nhả phanh tay';
    }

    const sensorsToWatch = [
        { name: "Pin 12V", state: getValidState('pin_12v_ac_quy'), icon: "mdi:car-battery", unit: "%" }, { name: "Khóa tổng", state: getValidState('khoa_tong'), icon: "mdi:lock" },
        { name: "An ninh", state: getValidState('trang_thai_an_ninh'), icon: "mdi:shield-car" }, { name: "Phanh tay", state: phanhTay, icon: "mdi:car-brake-parking" },
        { name: "Cảnh báo", state: getValidState('den_nhay_canh_bao'), icon: "mdi:car-light-alert" }, { name: "Điều hòa", state: getValidState('trang_thai_dieu_hoa'), icon: "mdi:air-conditioner" },
        { name: "Cắm trại", state: getValidState('che_do_cam_trai_camp'), icon: "mdi:tent" }, { name: "Thú cưng", state: getValidState('che_do_thu_cung_pet'), icon: "mdi:paw" },
        { name: "Giao xe (Valet)", state: getValidState('che_do_giao_xe_valet'), icon: "mdi:account-tie-hat" }
    ];

    let sensorHtml = ''; let warningCount = 0;
    sensorsToWatch.forEach(s => {
        if (s.state && s.state !== '--' && s.state !== 'unknown') {
            let color = '#475569'; const stLower = s.state.toLowerCase();
            if (stLower.includes('mở khóa') || stLower.includes('tắt an ninh') || stLower.includes('nhả phanh tay') || (stLower.includes('bật') && s.name==='Cảnh báo') || (s.name==='Pin 12V' && parseFloat(s.state) < 40)) { color = '#ef4444'; if (s.name !== 'Điều hòa') warningCount++; } 
            else if (stLower.includes('khóa') || stLower.includes('bật an ninh') || stLower.includes('kéo phanh tay') || stLower.includes('đang bật')) { color = '#10b981'; }
            sensorHtml += `<div style="display:flex; justify-content:space-between; align-items:center; background:var(--primary-background-color, white); padding:8px 12px; border-radius:8px; border:1px solid var(--divider-color, #e2e8f0);"><div style="display:flex; align-items:center; gap:8px; color:var(--secondary-text-color, #475569);"><ha-icon icon="${s.icon}" style="color:${color}; --mdc-icon-size:18px;"></ha-icon><span style="font-size:12px; font-weight:600;">${s.name}</span></div><b style="font-size:12px; color:${color};">${s.state} ${s.unit||''}</b></div>`;
        }
    });

    const sensorListEl = this.querySelector('#sensor-list-container');
    if (sensorListEl) sensorListEl.innerHTML = sensorHtml || `<div style="text-align:center; padding:10px; color:#94a3b8; font-size:12px;">Không có cảm biến khả dụng</div>`;
    const sensorSummaryEl = this.querySelector('#vf-stat-sensors');
    if (sensorSummaryEl) sensorSummaryEl.innerHTML = warningCount > 0 ? `<span style="color:#ef4444; font-size:14px;">${warningCount} Cảnh báo</span>` : `<span style="color:#10b981; font-size:14px;">Bình thường</span>`;

    const tripEff = parseFloat(getValidState('hieu_suat_tieu_thu_trip')) || 0;
    const capacity = parseFloat(getValidState('dung_luong_pin_thiet_ke')) || 0;
    const maxRange = parseFloat(getValidState('quang_duong_cong_bo_max')) || 0;
    const isTripActive = parseFloat(trip) > 0.5;

    let tripDegradationHtml = '--';
    if (isTripActive && tripEff > 0 && capacity > 0 && maxRange > 0) {
        const tripMaxRange = capacity / (tripEff / 100); let dropPct = ((maxRange - tripMaxRange) / maxRange) * 100; if (dropPct < 0) dropPct = 0; 
        tripDegradationHtml = `${dropPct.toFixed(1)}% <span style="font-size:10px; color:#94a3b8; font-weight:normal;">(Theo Trip)</span>`;
    } else {
        tripDegradationHtml = `${getValidState('kha_nang_chai_pin_theo_range_tham_khao') || '--'}% <span style="font-size:10px; color:#94a3b8; font-weight:normal;">(Vòng đời)</span>`;
    }

    const dtRangeDropTripEl = this.querySelector('#dt-range-drop-trip'); if (dtRangeDropTripEl) dtRangeDropTripEl.innerHTML = tripDegradationHtml;
    
    const pubSessions = parseInt(getValidState('so_lan_sac_tai_tram')) || 0; 
    const homeSessions = parseInt(getValidState('so_lan_sac_tai_nha')) || 0; 
    const totalSessions = parseInt(getValidState('tong_so_lan_sac')) || (pubSessions + homeSessions);
    
    const chargeCountEl = this.querySelector('#vf-stat-charge-count'); 
    if(chargeCountEl) chargeCountEl.innerHTML = `${totalSessions}<span class="stat-unit">lần</span>`;

    const speedBandStr = getValidState('dai_toc_do_toi_uu_nhat');
    const speedElTarget = this.querySelector('#vf-stat-speed');
    if (speedElTarget) {
        if (speedBandStr && speedBandStr !== 'unknown' && speedBandStr !== '--') {
            let spd = speedBandStr.split(' ')[0];
            speedElTarget.innerHTML = `${spd}<span class="stat-unit">km/h</span>`;
        } else speedElTarget.innerHTML = '--';
    }

    const dtSohEl = this.querySelector('#dt-soh'); if (dtSohEl) dtSohEl.innerText = getValidState('suc_khoe_pin_soh_tinh_toan') ? `${getValidState('suc_khoe_pin_soh_tinh_toan')}%` : '--';
    const dtChargeEffEl = this.querySelector('#dt-charge-eff'); if (dtChargeEffEl) dtChargeEffEl.innerText = getValidState('hieu_suat_sac_thuc_te_lan_cuoi') ? `${getValidState('hieu_suat_sac_thuc_te_lan_cuoi')}%` : '--';
    const dtChargeSocStartEl = this.querySelector('#dt-charge-soc-start'); if (dtChargeSocStartEl) dtChargeSocStartEl.innerText = `${getValidState('pin_luc_cam_sac_lan_cuoi') || '--'}%`;
    
    const dtChargeSocEndEl = this.querySelector('#dt-charge-soc-end');
    if (dtChargeSocEndEl) { 
        let endSoc = getValidState('pin_luc_rut_sac_lan_cuoi'); 
        if (isCharging) endSoc = batt; 
        dtChargeSocEndEl.innerText = `${endSoc || '--'}%`; 
    }
    
    const dtRangeMaxEl = this.querySelector('#dt-range-max'); if (dtRangeMaxEl) dtRangeMaxEl.innerText = `${getValidState('quang_duong_cong_bo_max') || '--'} km`;
    const dtRangeAiEl = this.querySelector('#dt-range-ai'); if (dtRangeAiEl) dtRangeAiEl.innerText = `${getValidState('quang_duong_thuc_te_day_100_pin') || '--'} km`;
    const dtTotalKwhEl = this.querySelector('#dt-total-kwh'); if (dtTotalKwhEl) dtTotalKwhEl.innerText = `${getValidState('tong_dien_nang_da_sac') || '--'} kWh`;
    const dtTotalCostEl = this.querySelector('#dt-total-cost'); if (dtTotalCostEl) dtTotalCostEl.innerText = `${getValidState('tong_chi_phi_sac_quy_doi') || '--'} VNĐ`;
    const dtTripAvgSpeedEl = this.querySelector('#dt-trip-avg-speed'); if (dtTripAvgSpeedEl) dtTripAvgSpeedEl.innerText = `${getValidState('toc_do_tb_chuyen_di') || '--'} km/h`;
    const dtTripEnergyEl = this.querySelector('#dt-trip-energy'); if (dtTripEnergyEl) dtTripEnergyEl.innerText = `${tripEnergy || '--'} kWh`;

    const dtSpeedChart = this.querySelector('#dt-speed-chart');
    if (dtSpeedChart) {
        let htmlChart = '';
        let maxVal = 0;
        let bars = [];
        const sObj = hass.states[`sensor.${p}_dai_toc_do_toi_uu_nhat`];
        if (sObj && sObj.attributes) {
            for (let key in sObj.attributes) {
                if (key.includes('Dải')) {
                    let valStr = sObj.attributes[key];
                    let num = parseFloat(valStr.split(' ')[0]);
                    if (num > maxVal) maxVal = num;
                    bars.push({label: key.replace('Dải ', '').replace(' km/h', ''), val: num});
                }
            }
        }
        if (bars.length > 0) {
            bars.forEach(b => {
                let pct = Math.round((b.val / maxVal) * 100);
                htmlChart += `<div style="display:flex; align-items:center; gap:8px;">
                    <div style="width:40px; font-size:10px; text-align:right; font-weight:bold; color:var(--secondary-text-color, #475569);">${b.label}</div>
                    <div style="flex:1; background:var(--divider-color, #e2e8f0); height:8px; border-radius:4px; overflow:hidden;">
                        <div style="width:${pct}%; height:100%; background:${pct === 100 ? '#eab308' : '#3b82f6'}; transition: width 0.5s;"></div>
                    </div>
                    <div style="width:35px; font-size:10px; font-weight:bold; color:var(--primary-text-color, #1e3a8a);">${b.val}</div>
                </div>`;
            });
            dtSpeedChart.innerHTML = htmlChart;
        } else {
             dtSpeedChart.innerHTML = `<div style="text-align:center; padding:10px; color:#94a3b8; font-size:11px;">Chưa đủ dữ liệu AI</div>`;
        }
    }

    const aiAdvisor = getValidState('co_van_xe_dien_ai');
    const aiContainer = this.querySelector('#vf-ai-advisor-container');
    const aiTextEl = this.querySelector('#vf-ai-text');
    const aiContentEl = this.querySelector('#vf-ai-content');
    const aiChevron = this.querySelector('#vf-ai-chevron');
    
    if (aiContainer && aiTextEl) {
        if (!aiAdvisor || aiAdvisor === 'DISABLED' || aiAdvisor === 'unavailable') aiContainer.style.display = 'none'; 
        else if (!aiAdvisor.includes('Hệ thống AI đang chờ') && !aiAdvisor.includes('Vui lòng nhập Google') && !aiAdvisor.includes('waiting')) {
            aiTextEl.innerText = aiAdvisor; aiContainer.style.display = 'block'; 
            if (this._lastAiMessage !== aiAdvisor) {
                this._lastAiMessage = aiAdvisor;
                if (aiContentEl) { aiContentEl.style.maxHeight = '500px'; aiContentEl.style.marginTop = '8px'; if (aiChevron) aiChevron.style.transform = 'rotate(0deg)'; }
            }
        } else aiContainer.style.display = 'none'; 
    }

    const addressEl = this.querySelector('#vf-current-address');
    if (addressEl) {
        let sensorAddress = getValidState('vi_tri_xe_dia_chi');
        if (sensorAddress && sensorAddress !== 'unknown') addressEl.innerText = sensorAddress;
        else if (lat && lon && lat > 0) addressEl.innerText = `Tọa độ: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        else addressEl.innerText = "Đang tìm vị trí...";
    }

    if (this._map && lat && lon && typeof L !== 'undefined') {
      if (!this._isReplaying && this._selectedDateStr === 'LIVE') {
          let targetAngle = this._currentAngle || 0;
          if (this._lastHeadingLat === null) { this._lastHeadingLat = lat; this._lastHeadingLon = lon; } 
          else {
              const distToLastHeading = this._map.distance([this._lastHeadingLat, this._lastHeadingLon], [lat, lon]);
              if (distToLastHeading > 2.5 && speedNum > 0) {
                  targetAngle = this.getBearing(this._lastHeadingLat, this._lastHeadingLon, lat, lon);
                  if (gear.includes('R') || gear === '2') targetAngle = (targetAngle + 180) % 360;
                  this._lastHeadingLat = lat; this._lastHeadingLon = lon; this._currentAngle = targetAngle;
              }
          }

          if (this._marker) {
              this._marker.setOpacity(1); 
              this._marker.setLatLng([lat, lon]);
              const iconEl = this._marker.getElement();
              if (iconEl) {
                  const smoothedAngle = this._smoothRotation(targetAngle);
                  const svg = iconEl.querySelector('.car-dir-svg'); if (svg) svg.style.transform = `rotate(${smoothedAngle}deg)`;
                  const badge = iconEl.querySelector('.car-speed-badge');
                  if (badge) { badge.style.display = (!gear.includes('P') && speedNum > 0) ? 'block' : 'none'; badge.innerText = `${speedNum} km/h`; }
              }
          }

          if (this._lastLat === null) this._map.setView([lat, lon], 15);
          this._lastLat = lat; this._lastLon = lon;
          
          const routeJsonStr = getAttr('lo_trinh_gps', 'route_json');
          if (routeJsonStr && this._polyline) {
              if (this._currentPolylineString !== routeJsonStr) {
                  this._currentPolylineString = routeJsonStr;
                  let parsedData = this.safeParseJSON(routeJsonStr);
                  this._rawRouteCoords = this.cleanRouteData(parsedData);
                  this._smoothedRouteCoords = this._smoothRouteData(this._rawRouteCoords);
                  const latLngsOnly = this._smoothedRouteCoords.map(p => [p[0], p[1]]);
                  this._polyline.setLatLngs(latLngsOnly);
              }
          }
      }

      if (this._selectedDateStr === 'LIVE') {
          const stationsStr = getAttr('tram_sac_lan_can', 'stations');
          if (stationsStr && stationsStr !== this._prevStationStr) {
              this._prevStationStr = stationsStr;
              let newStations = this.safeParseJSON(stationsStr);
              if (Array.isArray(newStations)) { this._currentStations = newStations; this.renderStations(); }
          }
          
          const liveIndicator = this.querySelector('#icon-live-indicator');
          const calIcon = this.querySelector('#icon-cal-mode');
          if(liveIndicator) liveIndicator.style.display = 'block';
          if(calIcon) calIcon.style.color = '#334155';
      } else {
          if (this._stationLayer) this._stationLayer.clearLayers();
          
          const liveIndicator = this.querySelector('#icon-live-indicator');
          const calIcon = this.querySelector('#icon-cal-mode');
          if(liveIndicator) liveIndicator.style.display = 'none';
          if(calIcon) calIcon.style.color = '#2563eb';
      }
    }
  }
  getCardSize() { return 8; }
}

if (!customElements.get('vinfast-digital-twin')) customElements.define('vinfast-digital-twin', VinFastDigitalTwin);

class VinFastDebugCard extends HTMLElement {
  setConfig(config) {
    if (!config.entity) {
      throw new Error('Bạn cần khai báo entity của cảm biến System Debug Raw Data');
    }
    this.config = config;
    this._rawJsonData = {};
    
    // Khôi phục dữ liệu người dùng đã sửa từ LocalStorage
    this._aliases = JSON.parse(localStorage.getItem('vf_debug_aliases') || '{}');
    this._stateAliases = JSON.parse(localStorage.getItem('vf_debug_state_aliases') || '{}');

    // ==============================================================
    // SIÊU TỪ ĐIỂN TỔNG HỢP TỪ TẤT CẢ CÁC DÒNG XE (VF3 -> VF9)
    // ==============================================================
    this._dictionary = {
        "00006_00001_00000": { name: "Vĩ độ (Latitude)", parse: v => v },
        "00006_00001_00001": { name: "Kinh độ (Longitude)", parse: v => v },
        "00006_00001_00002": { name: "Độ cao (Altitude)", parse: v => `${v} m` },
        "00005_00001_00030": { name: "Phiên bản Phần mềm (FRP)", parse: v => v },
        "34196_00001_00004": { name: "Phiên bản T-Box", parse: v => v },
        "34181_00001_00007": { name: "Biển số / Tên xe phụ", parse: v => v },
        "34213_00001_00003": { name: "Khóa tổng", parse: v => v == 1 ? "Đã Khóa" : "Mở Khóa" },
        "34234_00001_00003": { name: "Trạng thái An ninh", parse: v => (v == 1 || v == 2) ? "Đã Bật" : "Đã Tắt" },
        "34186_00005_00004": { name: "Đèn nháy cảnh báo", parse: v => v == 1 ? "Đang bật" : "Tắt" },
        "34205_00001_00001": { name: "Chế độ Giao xe (Valet)", parse: v => v == 1 ? "Bật" : "Tắt" },
        "34206_00001_00001": { name: "Cắm trại(Khác) / Khóa(VF6)", parse: v => v == 1 ? "Bật / Khóa" : "Tắt / Mở" },
        "34207_00001_00001": { name: "Chế độ Thú cưng (Pet)", parse: v => v == 1 ? "Bật" : "Tắt" },
        "10351_00002_00050": { name: "Cửa tài xế", parse: v => v == 1 ? "Mở" : "Đóng" },
        "10351_00001_00050": { name: "Cửa phụ", parse: v => v == 1 ? "Mở" : "Đóng" },
        "10351_00006_00050": { name: "Cốp sau", parse: v => v == 1 ? "Mở" : "Đóng" },
        "10351_00005_00050": { name: "Nắp Capo", parse: v => v == 1 ? "Mở" : "Đóng" },
        "10351_00004_00050": { name: "Cửa sau tài xế", parse: v => v == 1 ? "Mở" : "Đóng" },
        "10351_00003_00050": { name: "Cửa sau phụ", parse: v => v == 1 ? "Mở" : "Đóng" },
        "34215_00002_00002": { name: "Kính tài xế", parse: v => v == 2 ? "Mở" : "Đóng" },
        "34215_00001_00002": { name: "Kính phụ", parse: v => v == 2 ? "Mở" : "Đóng" },
        "34215_00004_00002": { name: "Kính sau tài xế", parse: v => v == 2 ? "Mở" : "Đóng" },
        "34215_00003_00002": { name: "Kính sau phụ", parse: v => v == 2 ? "Mở" : "Đóng" },
        "34213_00003_00003": { name: "Trạng thái Mô-tơ Kính", parse: v => v },
        "34213_00002_00003": { name: "Trạng thái Mô-tơ Cốp", parse: v => v },
        "34213_00004_00003": { name: "Trạng thái nháy đèn pha", parse: v => v == 1 ? "Nháy pha" : "Tắt" },
        "34184_00001_00004": { name: "Trạng thái điều hòa", parse: v => v == 1 ? "Bật" : "Tắt" },
        "34184_00001_00011": { name: "Chế độ lấy gió", parse: v => v == 1 ? "Lấy gió trong" : "Lấy gió ngoài" },
        "34184_00001_00012": { name: "Hướng gió điều hòa", parse: v => v == 1 ? "Mặt" : (v == 2 ? "Mặt & Chân" : (v == 3 ? "Chân" : (v == 4 ? "Kính & Chân" : "Auto"))) },
        "34184_00001_00009": { name: "Sấy kính", parse: v => v == 1 ? "Bật" : "Tắt" },
        "34184_00001_00025": { name: "Mức quạt gió", parse: v => `Mức ${v}` },
        "34184_00001_00041": { name: "Mức độ làm lạnh", parse: v => `Mức ${v}` },
        "34183_00001_00009": { name: "Phần trăm Pin (Plat A)", parse: v => `${v} %` },
        "34180_00001_00011": { name: "Phần trăm Pin (Plat B)", parse: v => `${v} %` },
        "34183_00001_00011": { name: "Quãng đường dự kiến (A)", parse: v => `${v} km` },
        "34180_00001_00007": { name: "Quãng đường dự kiến (B)", parse: v => `${v} km` },
        "34183_00001_00001": { name: "Vị trí cần số (A)", parse: v => v == 1 ? "P (Đỗ)" : (v == 2 ? "R (Lùi)" : (v == 3 ? "N (Mo)" : (v == 4 ? "D (Đi)" : v))) },
        "34187_00000_00000": { name: "Vị trí cần số (B)", parse: v => v == 1 ? "P (Đỗ)" : (v == 2 ? "R (Lùi)" : (v == 3 ? "N (Mo)" : (v == 4 ? "D (Đi)" : v))) },
        "34183_00001_00002": { name: "Tốc độ hiện tại (A)", parse: v => `${v} km/h` },
        "34188_00000_00000": { name: "Tốc độ hiện tại (B)", parse: v => `${v} km/h` },
        "34183_00001_00003": { name: "Tổng ODO (A)", parse: v => `${v} km` },
        "34199_00000_00000": { name: "Tổng ODO (B)", parse: v => `${v} km` },
        "34183_00001_00010": { name: "Trạng thái Lái (Ready A)", parse: v => v == 3 ? "Sẵn sàng chạy" : "Chưa sẵn sàng" },
        "34180_00001_00010": { name: "Trạng thái Lái (Ready B)", parse: v => v == 3 ? "Sẵn sàng chạy" : "Chưa sẵn sàng" },
        "34183_00001_00029": { name: "Phanh tay điện tử", parse: v => v == 1 ? "Kéo phanh" : "Nhả phanh" },
        "34183_00001_00035": { name: "Công tắc Phanh chân", parse: v => v },
        "34183_00001_00005": { name: "Pin 12V (A)", parse: v => `${v} %` },
        "34181_00000_00000": { name: "Pin 12V (B)", parse: v => `${v} %` },
        "34220_00001_00001": { name: "Sức khỏe pin (SOH)", parse: v => `${v} %` },
        "34193_00001_00031": { name: "Cắm súng sạc (A)", parse: v => v == 1 ? "Đã cắm" : "Chưa cắm" },
        "34183_00000_00004": { name: "Cắm súng sạc (B)", parse: v => v == 1 ? "Đã cắm" : "Chưa cắm" },
        "34193_00001_00005": { name: "Trạng thái sạc (A)", parse: v => v == 1 ? "Đang sạc" : (v == 2 ? "Đầy" : "Không sạc") },
        "34183_00000_00001": { name: "Trạng thái sạc (B)", parse: v => v == 1 ? "Đang sạc" : (v == 2 ? "Đầy" : "Không sạc") },
        "34193_00001_00007": { name: "Tgian sạc còn lại (A)", parse: v => `${v}p` },
        "34183_00000_00009": { name: "Tgian sạc còn lại (B)", parse: v => `${v}p` },
        "34193_00001_00026": { name: "Tgian sạc ước tính", parse: v => `${v}p` },
        "34193_00001_00013": { name: "Giờ hoàn tất sạc", parse: v => v },
        "34193_00001_00032": { name: "Relay hệ thống sạc", parse: v => v },
        "34193_00001_00016": { name: "Mã phiên sạc", parse: v => v },
        "34183_00000_00012": { name: "Công suất sạc (B)", parse: v => `${v} kW` },
        "34183_00001_00007": { name: "Nhiệt độ ngoài trời (A)", parse: v => `${v} °C` },
        "34189_00000_00000": { name: "Nhiệt độ ngoài trời (B)", parse: v => `${v} °C` },
        "34183_00001_00015": { name: "Nhiệt độ trong xe (A)", parse: v => `${v} °C` },
        "34190_00000_00000": { name: "Nhiệt độ trong xe (B)", parse: v => `${v} °C` },
        "34224_00001_00005": { name: "Nhiệt độ ĐH cài đặt", parse: v => `${v} °C` },
        "56789_00001_00005": { name: "Đèn Pha", parse: v => v == 1 ? "Bật" : "Tắt" },
        "34196_00001_00003": { name: "Áp suất Lốp Trước Trái", parse: v => `${(v/10).toFixed(1)} Bar` },
        "34196_00001_00005": { name: "Áp suất Lốp Trước Phải", parse: v => `${(v/10).toFixed(1)} Bar` },
        "34196_00001_00007": { name: "Áp suất Lốp Sau Trái", parse: v => `${(v/10).toFixed(1)} Bar` },
        "34196_00001_00009": { name: "Áp suất Lốp Sau Phải", parse: v => `${(v/10).toFixed(1)} Bar` },
        "56789_00001_00007": { name: "Trạng thái mạng", parse: v => v }
    };
  }

  set hass(hass) {
    this._hass = hass;
    const entityId = this.config.entity;
    const stateObj = hass.states[entityId];

    if (!stateObj) {
      this.innerHTML = `<ha-card><div style="padding: 20px; color: red;">Không tìm thấy thực thể: ${entityId}</div></ha-card>`;
      return;
    }

    if (!this.content) {
      this.initUI();
      this.content = true;
    }

    // Lấy toàn bộ thuộc tính của sensor "System Debug Raw"
    if (stateObj.attributes) {
        let tempRaw = {};
        for (let key in stateObj.attributes) {
            // Lọc bỏ các thuộc tính hệ thống của HA
            if (key !== "friendly_name" && key !== "icon" && key !== "Chi tiết" && key !== "Trạng thái") {
                tempRaw[key] = stateObj.attributes[key];
            }
        }
        
        // Nếu số lượng mã nhận được nhiều hơn số đang hiển thị, hoặc có sự thay đổi giá trị
        if (Object.keys(tempRaw).length !== Object.keys(this._rawJsonData).length || JSON.stringify(tempRaw) !== JSON.stringify(this._rawJsonData)) {
            this._rawJsonData = tempRaw;
            this.updateTable();
        }
    }
  }

  initUI() {
    this.innerHTML = `
      <ha-card class="debug-card">
        <div class="debug-header">
          <div style="display:flex; align-items:center;">
            <ha-icon icon="mdi:console-network" style="color:#10b981; margin-right:8px;"></ha-icon>
            VINFAST REVERSE ENGINEER
          </div>
          <div id="debug-status-text" class="debug-status">Đang tải dữ liệu...</div>
        </div>

        <div class="debug-body">
          <table class="report-table">
            <thead>
                <tr>
                    <th style="width: 28%">Mã Lệnh</th>
                    <th style="width: 22%">RAW</th>
                    <th style="width: 25%">Tên Đề xuất</th>
                    <th style="width: 25%">Trạng thái</th>
                </tr>
            </thead>
            <tbody id="debug-table-body">
                </tbody>
          </table>
          
          <button id="btn-submit-github">
              <ha-icon icon="mdi:github" style="margin-right: 6px;"></ha-icon>
              GỬI ĐÓNG GÓP (MỞ GITHUB)
          </button>
        </div>
      </ha-card>
    `;

    const style = document.createElement('style');
    style.textContent = `
      .debug-card { background: #0f172a; color: #e2e8f0; font-family: monospace; border-radius: 12px; overflow: hidden; box-shadow: inset 0 0 20px rgba(0,0,0,0.5); border: 1px solid #1e293b;}
      .debug-header { background: #1e293b; padding: 12px 16px; font-size: 14px; font-weight: bold; border-bottom: 1px solid #334155; display:flex; align-items:center; justify-content: space-between; letter-spacing: 1px; color:#10b981;}
      .debug-status { font-size: 11px; font-weight: normal; color: #94a3b8; text-transform: none; letter-spacing: 0;}
      
      .debug-body { padding: 0; max-height: 600px; overflow-y: auto; position: relative;}
      .debug-body::-webkit-scrollbar { width: 8px; }
      .debug-body::-webkit-scrollbar-track { background: #0f172a; }
      .debug-body::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
      
      .report-table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
      .report-table th { background: #1e293b; padding: 10px 8px; text-align: left; position: sticky; top: 0; z-index: 2; border-bottom: 2px solid #334155; color: #94a3b8;}
      .report-table td { padding: 8px 8px; border-bottom: 1px solid #1e293b; vertical-align: middle; word-wrap: break-word;}
      
      .report-row:hover { background: rgba(255,255,255,0.03); }
      
      .rep-input { width: 90%; background: #0f172a; color: #38bdf8; border: 1px solid #334155; padding: 6px 8px; border-radius: 6px; font-family: monospace; outline: none; transition: border 0.2s; box-sizing: border-box;}
      .rep-input:focus { border-color: #10b981; background: rgba(16, 185, 129, 0.05); color: #fff;}
      
      #btn-submit-github { width: calc(100% - 24px); padding: 12px; margin: 12px; background: #24292e; color: white; border: 1px solid #444; border-radius: 8px; cursor: pointer; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 8px; transition: 0.2s;}
      #btn-submit-github:hover { background: #2ea043; border-color: #2ea043;}
    `;
    this.appendChild(style);

    // Xử lý LƯU DATA trực tiếp khi người dùng gõ
    this.querySelector('#debug-table-body').addEventListener('input', (e) => {
        const tr = e.target.closest('tr');
        if (!tr) return;
        const code = tr.getAttribute('data-key');
        const rawVal = tr.getAttribute('data-raw');

        if (e.target.classList.contains('rep-name')) {
            const newName = e.target.value;
            if (newName.trim() === '') delete this._aliases[code];
            else this._aliases[code] = newName;
            localStorage.setItem('vf_debug_aliases', JSON.stringify(this._aliases));
        }

        if (e.target.classList.contains('rep-state')) {
            const newState = e.target.value;
            if (!this._stateAliases[code]) this._stateAliases[code] = {};
            
            if (newState.trim() === '') delete this._stateAliases[code][rawVal];
            else this._stateAliases[code][rawVal] = newState;
            localStorage.setItem('vf_debug_state_aliases', JSON.stringify(this._stateAliases));
        }
    });

    // Xử lý gửi báo cáo Github
    this.querySelector('#btn-submit-github').addEventListener('click', (e) => {
        let markdown = `### Báo cáo Giải mã Lệnh / Cảm biến mới\n\n`;
        markdown += `Tôi phát hiện một số mã lệnh mới từ thẻ Debug Card:\n\n`;
        markdown += `| Device Key | Giá trị RAW | Đề xuất Tên (Name) | Đề xuất Trạng thái |\n`;
        markdown += `| :--- | :--- | :--- | :--- |\n`;
        
        let issueCount = 0;
        const rows = this.querySelectorAll('.report-row');
        rows.forEach(row => {
            let k = row.getAttribute('data-key');
            let rv = row.getAttribute('data-raw');
            let name = row.querySelector('.rep-name').value.trim();
            let state = row.querySelector('.rep-state').value.trim();
            
            // Lọc những ô mà người dùng có nhập liệu (Khác rỗng và khác placeholder)
            if ((name !== "" && !name.includes("Vd:")) || (state !== "" && !state.includes("Vd:"))) {
                markdown += `| \`${k}\` | \`${rv}\` | **${name || "_Chưa rõ_"}** | ${state || "_Chưa rõ_"} |\n`;
                issueCount++;
            }
        });

        if (issueCount === 0) {
            alert("Hãy sửa tên hoặc trạng thái của ít nhất 1 dòng trước khi gửi đóng góp nhé!");
            return;
        }

        markdown += `\n<details>\n<summary><b>JSON RAW Đính kèm (Dành cho Dev)</b></summary>\n\n`;
        markdown += `\`\`\`json\n${JSON.stringify(this._rawJsonData, null, 2)}\n\`\`\`\n`;
        markdown += `\n</details>\n`;

        const btnSubmit = e.currentTarget;
        navigator.clipboard.writeText(markdown).then(() => {
            btnSubmit.style.background = "#2ea043";
            btnSubmit.innerHTML = `<ha-icon icon="mdi:check-circle"></ha-icon> ĐÃ COPY! ĐANG MỞ GITHUB...`;
            
            let issueTitle = "Bổ sung mã lệnh cảm biến mới (từ Cộng đồng)";
            let githubBaseUrl = "https://github.com/thangnd85/vinfast-connected-car/issues/new";
            let finalUrl = `${githubBaseUrl}?title=${encodeURIComponent(issueTitle)}&body=${encodeURIComponent("Dán (Ctrl+V) nội dung đã được copy tự động vào đây...")}`;
            window.open(finalUrl, "_blank");

            setTimeout(() => {
                btnSubmit.style.background = "#24292e";
                btnSubmit.innerHTML = `<ha-icon icon="mdi:github" style="margin-right: 6px;"></ha-icon> GỬI ĐÓNG GÓP (MỞ GITHUB)`;
            }, 3000);
        }).catch(err => {
            alert("Lỗi khi copy vào bộ nhớ tạm: " + err);
        });
    });
  }

  updateTable() {
    const tbody = this.querySelector('#debug-table-body');
    if (!tbody) return;

    const headerTitle = this.querySelector('#debug-status-text');
    if (headerTitle) {
        headerTitle.innerText = `${Object.keys(this._rawJsonData).length} thông số`;
    }

    for (let [key, rawVal] of Object.entries(this._rawJsonData)) {
        let displayRawVal = typeof rawVal === 'object' ? JSON.stringify(rawVal) : String(rawVal);
        
        let dictObj = this._dictionary[key];
        
        // 1. Lấy Name: Ưu tiên Custom Alias -> Dictionary Name
        let defaultName = dictObj ? dictObj.name : "";
        let currentName = this._aliases[key] || defaultName;

        // 2. Lấy State: Ưu tiên Custom State (dựa trên raw) -> Dictionary Parse -> Raw
        let defaultState = dictObj ? dictObj.parse(rawVal) : displayRawVal;
        let currentState = (this._stateAliases[key] && this._stateAliases[key][displayRawVal]) ? this._stateAliases[key][displayRawVal] : defaultState;

        // Tìm row xem đã tồn tại chưa
        let tr = tbody.querySelector(`tr[data-key="${key}"]`);
        
        if (tr) {
            // CẬP NHẬT ROW CŨ (Không làm mất focus của input)
            if (tr.getAttribute('data-raw') !== displayRawVal) {
                tr.setAttribute('data-raw', displayRawVal);
                tr.querySelector('.raw-val-td').innerText = displayRawVal;
                
                // Cập nhật lại input trạng thái nếu user không đang focus vào ô đó
                let stateInput = tr.querySelector('.rep-state');
                if (document.activeElement !== stateInput) {
                    stateInput.value = currentState;
                }
            }
        } else {
            // THÊM ROW MỚI
            let newTr = document.createElement('tr');
            newTr.className = 'report-row';
            newTr.setAttribute('data-key', key);
            newTr.setAttribute('data-raw', displayRawVal);
            
            newTr.innerHTML = `
                <td style="color: #f43f5e; font-weight: bold;">${key}</td>
                <td class="raw-val-td" style="font-weight: bold; color: #e2e8f0;">${displayRawVal}</td>
                <td><input type="text" class="rep-input rep-name" value="${currentName}" placeholder="Vd: Model xe"></td>
                <td><input type="text" class="rep-input rep-state" value="${currentState}" placeholder="Vd: Bật"></td>
            `;
            tbody.appendChild(newTr);
        }
    }
  }

  getCardSize() { return 8; }
}

if (!customElements.get('vinfast-debug-card')) {
    customElements.define('vinfast-debug-card', VinFastDebugCard);
}
