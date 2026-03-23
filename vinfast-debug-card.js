class VinFastDebugCard extends HTMLElement {
  setConfig(config) {
    if (!config.entity) {
      throw new Error('Bạn cần khai báo entity của cảm biến System Debug Raw Data');
    }
    this.config = config;
    this.activeTab = 'log'; 
    this.filterText = '';
    this._logData = [];
    this._rawJsonData = {};
    
    this._aliases = JSON.parse(localStorage.getItem('vf_debug_aliases') || '{}');

    // ==============================================================
    // SIÊU TỪ ĐIỂN TỔNG HỢP TỪ TẤT CẢ CÁC DÒNG XE
    // ==============================================================
    this._dictionary = {
        "34183_00001_00009": { name: "Mức Pin (SOC %)", parse: v => `${v}%` },
        "34180_00001_00011": { name: "Mức Pin BMS (SOC %)", parse: v => `${v}%` },
        "34199_00000_00000": { name: "ODO (km)", parse: v => `${v} km` },
        "34183_00001_00003": { name: "ODO (km)", parse: v => `${v} km` },
        "34180_00001_00021": { name: "Điện áp 12V", parse: v => `${v} V` },
        "34180_00001_00014": { name: "Nhiệt độ Pin HV", parse: v => `${v} °C` },
        "34220_00001_00001": { name: "Độ chai Pin (SOH %)", parse: v => `${v}%` },
        "34193_00001_00009": { name: "Quãng đường dự kiến", parse: v => `${v} km` },
        "34193_00001_00005": { name: "Trạng thái Sạc", parse: v => v == 1 ? "Đang sạc" : (v == 2 ? "Ngắt sạc" : "Lỗi/Rút súng") },

        "34183_00000_00001": { name: "Cửa Tổng", parse: v => v == 1 ? "Mở" : "Đóng" },
        "34206_00001_00001": { name: "Khóa cửa (Lock)", parse: v => v == 1 ? "Đã khóa" : "Chưa khóa" },
        "34234_00001_00003": { name: "Cốp sau (Trunk)", parse: v => v == 1 ? "Mở" : "Đóng" },
        "34234_00001_00002": { name: "Nắp Capo (Frunk)", parse: v => v == 1 ? "Mở" : "Đóng" },
        
        "34213_00002_00003": { name: "Kính Lái (Trước Trái)", parse: v => v == 1 ? "Mở" : "Đóng" },
        "34213_00002_00004": { name: "Kính Phụ (Trước Phải)", parse: v => v == 1 ? "Mở" : "Đóng" },
        "34213_00002_00005": { name: "Kính Sau Trái", parse: v => v == 1 ? "Mở" : "Đóng" },
        "34213_00002_00006": { name: "Kính Sau Phải", parse: v => v == 1 ? "Mở" : "Đóng" },

        "34196_00001_00003": { name: "Áp suất Lốp Trước Trái", parse: v => `${(v/10).toFixed(1)} Bar` },
        "34196_00001_00005": { name: "Áp suất Lốp Trước Phải", parse: v => `${(v/10).toFixed(1)} Bar` },
        "34196_00001_00007": { name: "Áp suất Lốp Sau Trái", parse: v => `${(v/10).toFixed(1)} Bar` },
        "34196_00001_00009": { name: "Áp suất Lốp Sau Phải", parse: v => `${(v/10).toFixed(1)} Bar` },

        "10351_00006_00050": { name: "Điều hòa (AC)", parse: v => v == 1 ? "Bật" : "Tắt" },
        "10351_00006_00052": { name: "Nhiệt độ Điều hòa", parse: v => `${v} °C` },
        "10351_00006_00015": { name: "Nhiệt độ Môi trường", parse: v => `${v} °C` },
        
        "56789_00001_00005": { name: "Đèn Pha", parse: v => v == 1 ? "Bật" : "Tắt" },
        "34185_00001_00001": { name: "GPS Lat", parse: v => v },
        "34185_00001_00002": { name: "GPS Lon", parse: v => v },
        "34185_00001_00003": { name: "Tốc độ (Speed)", parse: v => `${v} km/h` },
        "34185_00001_00004": { name: "Hướng di chuyển", parse: v => `${v}°` }
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

    if (stateObj.attributes) {
        let tempRaw = {};
        for (let key in stateObj.attributes) {
            if (key !== "friendly_name" && key !== "icon" && key !== "Chi tiết") {
                tempRaw[key] = stateObj.attributes[key];
            }
        }
        this._rawJsonData = tempRaw;

        let newLogData = [];
        let nowStr = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        
        for (let [code, val] of Object.entries(this._rawJsonData)) {
            let isExists = this._logData.find(item => item.code === code);
            if (!isExists || isExists.new_value !== val) {
                newLogData.push({
                    time: nowStr,
                    code: code,
                    old_value: isExists ? isExists.new_value : "NEW",
                    new_value: val,
                    status: (this._aliases[code] || this._dictionary[code]) ? "KNOWN" : "UNKNOWN"
                });
            }
        }
        
        if (newLogData.length > 0) {
            this._logData = [...newLogData, ...this._logData].slice(0, 100);
            this.renderBody();
        }
    }
  }

  initUI() {
    this.innerHTML = `
      <ha-card class="debug-card">
        <div class="debug-header">
          <div>
            <ha-icon icon="mdi:console-network" style="color:#10b981; margin-right:8px;"></ha-icon>
            VINFAST REVERSE ENGINEER
          </div>
          <div id="debug-status-text" class="debug-status">Đang tải dữ liệu...</div>
        </div>
        
        <div class="debug-toolbar">
          <input type="text" id="debug-search" class="debug-search" placeholder="🔍 Nhập mã (VD: 34213) hoặc tên để lọc...">
          <div class="debug-tabs">
            <button id="btn-tab-log" class="debug-tab active" data-target="log">Sự kiện Live</button>
            <button id="btn-tab-raw" class="debug-tab" data-target="raw">Raw JSON</button>
            <button id="btn-tab-report" class="debug-tab" data-target="report" style="color: #f59e0b;"><ha-icon icon="mdi:github" style="width:14px;height:14px;"></ha-icon> Báo cáo</button>
          </div>
        </div>

        <div class="debug-body">
          <div id="view-log" class="debug-view"></div>
          <pre id="view-raw" class="debug-view" style="display: none;"></pre>
          <div id="view-report" class="debug-view" style="display: none;"></div>
        </div>
      </ha-card>
    `;

    const style = document.createElement('style');
    style.textContent = `
      .debug-card { background: #0f172a; color: #e2e8f0; font-family: monospace; border-radius: 12px; overflow: hidden; box-shadow: inset 0 0 20px rgba(0,0,0,0.5); border: 1px solid #1e293b;}
      .debug-header { background: #1e293b; padding: 12px 16px; font-size: 14px; font-weight: bold; border-bottom: 1px solid #334155; display:flex; align-items:center; justify-content: space-between; letter-spacing: 1px; color:#10b981;}
      .debug-status { font-size: 11px; font-weight: normal; color: #94a3b8; text-transform: none; letter-spacing: 0;}
      
      .debug-toolbar { padding: 12px; background: #0f172a; border-bottom: 1px solid #1e293b; }
      .debug-search { width: 100%; padding: 10px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: #38bdf8; font-family: monospace; font-size: 13px; outline: none; margin-bottom: 10px; transition: border 0.2s; box-sizing: border-box;}
      .debug-search:focus { border-color: #38bdf8; }
      
      .debug-tabs { display: flex; gap: 8px; }
      .debug-tab { background: #1e293b; border: 1px solid #334155; color: #94a3b8; padding: 8px 10px; border-radius: 6px; cursor: pointer; font-family: monospace; font-size: 12px; font-weight: bold; flex: 1; transition: all 0.2s; display: flex; justify-content: center; align-items: center; gap: 4px;}
      .debug-tab:hover { background: #334155; color: white;}
      .debug-tab.active { background: #38bdf8; color: #0f172a; border-color: #38bdf8;}
      .debug-tab.active[data-target="report"] { background: #f59e0b; border-color: #f59e0b; color: #0f172a;}
      
      .debug-body { padding: 12px; height: 500px; overflow-y: auto; }
      .debug-body::-webkit-scrollbar { width: 8px; }
      .debug-body::-webkit-scrollbar-track { background: #0f172a; }
      .debug-body::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
      
      /* Log Tab */
      .log-item { padding: 12px 10px; border-bottom: 1px dashed #1e293b; font-size: 13px; line-height: 1.5; display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;}
      .log-left { display: flex; flex-direction: column; flex: 1;}
      .log-time { color: #64748b; font-size: 11px; margin-bottom: 4px;}
      .log-code { color: #f43f5e; font-weight: bold; letter-spacing: 0.5px;}
      .log-name-input { background: transparent; border: 1px dashed #334155; color: #e2e8f0; font-family: monospace; font-size: 13px; padding: 4px; border-radius: 4px; width: 90%; outline: none;}
      .log-name-input:focus { border-color: #10b981; border-style: solid; background: rgba(16, 185, 129, 0.1); }
      
      .log-right { display: flex; flex-direction: column; align-items: flex-end; gap: 8px;}
      .log-val-box { background: #1e293b; padding: 4px 10px; border-radius: 20px; border: 1px solid #334155; display: flex; align-items: center;}
      .log-val-old { color: #94a3b8; text-decoration: line-through; margin: 0 4px;}
      .log-arrow { color: #10b981; margin: 0 4px;}
      .log-val-new { color: #10b981; font-weight: bold; font-size: 14px;}
      
      #view-raw { margin: 0; font-size: 13px; color: #38bdf8; white-space: pre-wrap; word-break: break-all;}

      /* Report Tab */
      .report-table { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
      .report-table th { background: #1e293b; padding: 8px; text-align: left; position: sticky; top: 0; z-index: 2; border-bottom: 2px solid #334155; color: #94a3b8;}
      .report-table td { padding: 6px 8px; border-bottom: 1px solid #1e293b; vertical-align: middle; word-wrap: break-word;}
      .report-row.unknown { background: rgba(245, 158, 11, 0.05); }
      .report-row:hover { background: rgba(255,255,255,0.05); }
      .rep-input { width: 90%; background: #0f172a; color: #38bdf8; border: 1px solid #334155; padding: 6px; border-radius: 4px; font-family: monospace; outline: none; transition: border 0.2s;}
      .rep-input:focus { border-color: #f59e0b; background: rgba(245, 158, 11, 0.1); color: #fff;}
      
      .guide-box { background: rgba(16, 185, 129, 0.1); border: 1px solid #10b981; padding: 12px; border-radius: 8px; margin-bottom: 15px; color: #e2e8f0; font-size: 13px; line-height: 1.6; }
      .guide-step { font-weight: bold; color: #10b981;}
      
      #btn-submit-github { width: 100%; padding: 12px; margin-top: 15px; background: #24292e; color: white; border: 1px solid #444; border-radius: 8px; cursor: pointer; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 8px; transition: 0.2s;}
      #btn-submit-github:hover { background: #2ea043; border-color: #2ea043;}
    `;
    this.appendChild(style);

    const tabs = this.querySelectorAll('.debug-tab');
    const views = this.querySelectorAll('.debug-view');
    tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            tabs.forEach(t => t.classList.remove('active'));
            const target = e.currentTarget.getAttribute('data-target');
            e.currentTarget.classList.add('active');
            this.activeTab = target;
            
            views.forEach(v => v.style.display = 'none');
            this.querySelector(`#view-${target}`).style.display = 'block';
            this.renderBody();
        });
    });

    this.querySelector('#debug-search').addEventListener('input', (e) => {
      this.filterText = e.target.value.toLowerCase();
      this.renderBody();
    });

    this.querySelector('.debug-body').addEventListener('input', (e) => {
        if (e.target.classList.contains('log-name-input')) {
            const code = e.target.getAttribute('data-code');
            const newName = e.target.value;
            if (newName.trim() === '') delete this._aliases[code];
            else this._aliases[code] = newName;
            localStorage.setItem('vf_debug_aliases', JSON.stringify(this._aliases));
        }
    });

    this.querySelector('.debug-body').addEventListener('click', (e) => {
        const btnSubmit = e.target.closest('#btn-submit-github');
        if (btnSubmit) {
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
                
                if (name !== "" || state !== "") {
                    markdown += `| \`${k}\` | \`${rv}\` | **${name || "_Chưa rõ_"}** | ${state || "_Chưa rõ_"} |\n`;
                    issueCount++;
                }
            });

            if (issueCount === 0) {
                alert("Hãy nhập Đề xuất Tên hoặc Trạng thái vào ít nhất 1 ô trống trước khi gửi báo cáo!");
                return;
            }

            markdown += `\n<details>\n<summary><b>JSON RAW Đính kèm (Dành cho Dev)</b></summary>\n\n`;
            markdown += `\`\`\`json\n${JSON.stringify(this._rawJsonData, null, 2)}\n\`\`\`\n`;
            markdown += `\n</details>\n`;

            // ==============================================================
            // BƯỚC 1: MỞ TAB GITHUB NGAY LẬP TỨC ĐỂ TRÁNH BỊ CHẶN POPUP
            // ==============================================================
            let issueTitle = "Bổ sung mã lệnh cảm biến mới (từ Cộng đồng)";
            let githubBaseUrl = "https://github.com/thangnd85/vinfast-connected-car/issues/new";
            let encodedBody = encodeURIComponent(markdown);
            let finalUrl = githubBaseUrl;
            
            // Github giới hạn URL khoảng 4000-8000 ký tự. Nếu ngắn, ta nhét luôn Data vào URL
            if (encodedBody.length < 4000) {
                finalUrl = `${githubBaseUrl}?title=${encodeURIComponent(issueTitle)}&body=${encodedBody}`;
            }

            // Gọi hàm window.open ĐỒNG BỘ với thao tác Click của người dùng
            let newTab = window.open(finalUrl, "_blank");

            // ==============================================================
            // BƯỚC 2: COPY DATA VÀO BỘ NHỚ TẠM & HIỆN PHẢN HỒI (Bất đồng bộ)
            // ==============================================================
            navigator.clipboard.writeText(markdown).then(() => {
                btnSubmit.style.background = "#2ea043";
                btnSubmit.innerHTML = `<ha-icon icon="mdi:check-circle"></ha-icon> ĐÃ COPY & ĐÃ MỞ TAB GITHUB!`;

                // Cảnh báo an toàn nếu trình duyệt (hoặc App HA) khóa Popup
                if (!newTab || newTab.closed || typeof newTab.closed == 'undefined') {
                    alert("Trình duyệt hoặc App Home Assistant đã chặn mở cửa sổ mới! \nDữ liệu đã được lưu vào bộ nhớ tạm. Hãy tự mở link Github và dán báo cáo nhé.");
                }

                setTimeout(() => {
                    btnSubmit.style.background = "#24292e";
                    btnSubmit.innerHTML = `BƯỚC 1: COPY MÃ <ha-icon icon="mdi:arrow-right"></ha-icon> BƯỚC 2: MỞ ISSUE TRÊN GITHUB`;
                }, 3000);
            }).catch(err => {
                alert("Lỗi khi copy vào bộ nhớ tạm: " + err);
            });
        }
    });
  }

  renderBody() {
    const headerTitle = this.querySelector('#debug-status-text');
    if (headerTitle) {
        let totalCodes = Object.keys(this._rawJsonData).length;
        if (totalCodes > 0) headerTitle.innerText = `Phát hiện ${totalCodes} mã Active`;
    }

    if (this.activeTab === 'log') {
        const viewLog = this.querySelector('#view-log');
        if (this._logData.length === 0) {
            viewLog.innerHTML = `<div style="color:#64748b; text-align:center; margin-top:20px;">[ Bật thiết bị trên xe để bắt mã... ]</div>`;
            return;
        }

        let html = '';
        this._logData.forEach((item) => {
            const alias = this._aliases[item.code] || (this._dictionary[item.code] ? this._dictionary[item.code].name : "");
            
            if (this.filterText) {
                const searchStr = `${item.time} ${item.code} ${item.old_value} ${item.new_value} ${alias}`.toLowerCase();
                if (!searchStr.includes(this.filterText)) return;
            }

            html += `
                <div class="log-item">
                    <div class="log-left">
                        <span class="log-time">🕒 ${item.time} • <span class="log-code">${item.code}</span></span>
                        <input type="text" class="log-name-input" data-code="${item.code}" value="${this._aliases[item.code] || ''}" placeholder="${alias || '✍️ Đặt tên tùy chỉnh (Lưu Local)...'}">
                    </div>
                    <div class="log-right">
                        <div class="log-val-box">
                            <span class="log-val-old">${item.old_value}</span> 
                            <span class="log-arrow">➔</span> 
                            <span class="log-val-new">${item.new_value}</span>
                        </div>
                    </div>
                </div>
            `;
        });
        viewLog.innerHTML = html || `<div style="color:#64748b; text-align:center; margin-top:20px;">[ Không tìm thấy ]</div>`;
    }

    if (this.activeTab === 'raw') {
        const viewRaw = this.querySelector('#view-raw');
        let displayJson = {};
        for (let [key, value] of Object.entries(this._rawJsonData)) {
            let dictName = this._dictionary[key] ? this._dictionary[key].name : "";
            let alias = this._aliases[key] || dictName;
            
            if (this.filterText && !key.toLowerCase().includes(this.filterText) && !String(value).toLowerCase().includes(this.filterText) && !alias.toLowerCase().includes(this.filterText)) {
                continue;
            }
            if (alias) displayJson[`${key} (${alias})`] = value;
            else displayJson[key] = value;
        }
        viewRaw.textContent = JSON.stringify(displayJson, null, 2);
    }

    if (this.activeTab === 'report') {
        const viewReport = this.querySelector('#view-report');
        let html = `
            <div class="guide-box">
                <div style="font-weight: bold; margin-bottom: 8px; color: #10b981; font-size: 14px;">
                    <ha-icon icon="mdi:bullhorn-outline" style="width: 18px; height: 18px; margin-bottom: 2px;"></ha-icon> HƯỚNG DẪN CỘNG ĐỒNG:
                </div>
                <div style="margin-bottom: 5px;"><span class="guide-step">BƯỚC 1:</span> Gõ dự đoán của bạn vào các ô trống (ưu tiên các mã <span style="color:#f59e0b; font-weight:bold;">Màu Cam</span> - chưa được giải mã).</div>
                <div style="margin-bottom: 5px;"><span class="guide-step">BƯỚC 2:</span> Bấm nút <b style="color:white;">COPY & MỞ GITHUB</b> ở cuối bảng.</div>
                <div><span class="guide-step">BƯỚC 3:</span> Trình duyệt sẽ mở tab Github Issue mới. Nếu chưa thấy nội dung được điền sẵn, hãy bấm <b style="color:#38bdf8;">Ctrl + V (Dán)</b> vào khung soạn thảo và bấm Submit!</div>
            </div>
            
            <table class="report-table">
                <thead>
                    <tr>
                        <th style="width: 20%">Mã Lệnh</th>
                        <th style="width: 25%">RAW</th>
                        <th style="width: 28%">Tên Đề xuất</th>
                        <th style="width: 27%">Trạng thái</th>
                    </tr>
                </thead>
                <tbody>
        `;

        for (let [key, val] of Object.entries(this._rawJsonData)) {
            let dictObj = this._dictionary[key];
            let dictName = dictObj ? dictObj.name : "";
            let dictState = dictObj ? dictObj.parse(val) : "";
            
            let aliasName = this._aliases[key] || "";
            let displayName = aliasName || dictName;
            let isUnknown = !dictObj ? 'unknown' : '';

            if (this.filterText && !key.toLowerCase().includes(this.filterText) && !String(val).toLowerCase().includes(this.filterText) && !displayName.toLowerCase().includes(this.filterText)) {
                continue;
            }

            let displayVal = typeof val === 'object' ? JSON.stringify(val) : val;

            html += `
                <tr class="report-row ${isUnknown}" data-key="${key}" data-raw='${displayVal}'>
                    <td style="color: #f43f5e; font-weight: bold;">${key}</td>
                    <td style="font-weight: bold; color: #e2e8f0;">${displayVal}</td>
                    <td><input type="text" class="rep-input rep-name" value="${displayName}" placeholder="Vd: Sưởi ghế..."></td>
                    <td><input type="text" class="rep-input rep-state" value="${dictState}" placeholder="Vd: Bật"></td>
                </tr>
            `;
        }

        html += `
                </tbody>
            </table>
            <button id="btn-submit-github">
                BƯỚC 1: COPY MÃ <ha-icon icon="mdi:arrow-right" style="margin:0 5px;"></ha-icon> BƯỚC 2: MỞ ISSUE TRÊN GITHUB
            </button>
        `;
        viewReport.innerHTML = html;
    }
  }

  getCardSize() { return 8; }
}

if (!customElements.get('vinfast-debug-card')) {
    customElements.define('vinfast-debug-card', VinFastDebugCard);
}