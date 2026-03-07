🚘 Tài liệu Lập trình Giao diện: VinFast Digital Twin Card
VinFast Digital Twin là một Custom Card (Thẻ tùy chỉnh) dành cho giao diện Lovelace của Home Assistant. Thẻ này đóng vai trò là một "bản sao kỹ thuật số", hiển thị toàn bộ trạng thái thời gian thực của xe điện VinFast (VF 3, VF 5, VF 8, VF 9,...) và cung cấp bản đồ tương tác nâng cao.

Tài liệu này dành cho các nhà phát triển (Developers) muốn tùy biến, thay đổi UI/UX hoặc bổ sung thêm tính năng mới cho thẻ giao diện.

🏗 Kiến trúc Hoạt động (Architecture)
Giao diện này hoạt động độc lập ở phía Client (Trình duyệt/App) và giao tiếp với Backend thông qua đối tượng hass của Home Assistant.

Backend (Python): Lắng nghe dữ liệu MQTT từ xe, chuyển đổi các mã OMA-LWM2M thành các Entity (Cảm biến) trong Home Assistant. Đồng thời, tự động xuất lịch sử chuyến đi ra file JSON tại thư mục /config/www/.

Frontend (JavaScript): File vinfast-digital-twin.js định nghĩa một Web Component (<vinfast-digital-twin>). Nó liên tục đọc sự thay đổi trạng thái của các Entity và cập nhật (Render) lại HTML/CSS lên màn hình mà không cần load lại trang.

🛠 Hướng dẫn Tùy biến mã nguồn (vinfast-digital-twin.js)
Toàn bộ logic giao diện nằm gọn trong class VinFastDigitalTwin. Dưới đây là các phương thức quan trọng nhất mà bạn cần nắm rõ khi muốn can thiệp sửa code:

1. Hàm cấu hình ban đầu: setConfig(config)
Hàm này nhận tham số truyền vào từ giao diện Lovelace của người dùng.
Cấu hình bắt buộc: entity_prefix (Ví dụ: vf3_rln...). Frontend sẽ dùng tiền tố này để tự động nối chuỗi và tìm chính xác các cảm biến của chiếc xe đó.

2. Trái tim của Giao diện: set hass(hass)
Mỗi khi có MỘT cảm biến bất kỳ trong Home Assistant thay đổi, HA sẽ gọi lại hàm set hass(hass). Đây là nơi chứa logic cập nhật giao diện.

Cách lấy dữ liệu từ Home Assistant:
Chúng ta sử dụng một hàm helper tên là getValidState(entityId) để lấy dữ liệu an toàn (tránh lỗi khi cảm biến chưa kịp khởi động).

JavaScript
// Ví dụ: Lấy phần trăm pin
const prefix = this.config.entity_prefix; // vd: vf3_abcxyz
const batt = getValidState(`sensor.${prefix}_phan_tram_pin`); 
Cách Render HTML & CSS:
Giao diện được xây dựng bằng Template Literals nội tuyến trong khối if (!this.content) { this.innerHTML = ... }.

Nếu bạn muốn thêm một nút bấm, thẻ div, hay thay đổi màu sắc, hãy tìm đến khối this.innerHTML = ... và khối <style> ... </style> bên dưới nó.

💡 Các module tính năng cốt lõi có thể phát triển thêm
Module 1: Cụm Cảnh báo Thông minh (Smart Badges)
Hiện tại, giao diện đang hỗ trợ hiển thị trạng thái Cửa và Cốp ngay dưới hình ảnh xe thông qua mảng doorsConfig.
Cách thêm cảnh báo mới (VD: Cảnh báo chưa tắt đèn):

Thêm cấu hình vào mảng doorsConfig:

JavaScript
{ name: 'Đèn pha', open: getValidState(`sensor.${p}_den_pha`) === 'Đang Bật', icon: 'mdi:car-light-high' }
Module 2: Bảng thống kê (Stats Grid)
Giao diện sử dụng CSS Grid (grid-template-columns: repeat(3, 1fr)) để tạo ra 6 ô thông số.
Cách sửa lưới:

Nếu bạn muốn hiển thị 8 ô thông số, hãy sửa CSS thành repeat(4, 1fr).

Sau đó copy thêm khối <div class="stat-box">...</div> trong phần HTML và viết code đổ dữ liệu (như this.querySelector('#vf-stat-new').innerText = ...).

Module 3: Bản đồ Leaflet & JSON Lịch sử (Map & Trip Replay)
Bản đồ sử dụng thư viện mã nguồn mở Leaflet.js được nhúng trực tiếp qua thẻ <script>.

Trạm sạc: Dữ liệu trạm sạc được Backend đẩy vào thuộc tính (attributes) của cảm biến sensor..._tram_sac_lan_can dưới dạng chuỗi JSON. Hàm renderStations() chịu trách nhiệm phân loại DC/AC và vẽ các marker lên bản đồ.

Lịch sử chuyến đi: Frontend tự động fetch() file vinfast_trips_[vin].json trong ổ cứng của HA. Khi người dùng chọn một Trip, nó sẽ lấy mảng tọa độ và vẽ bằng L.polyline.

Ý tưởng nâng cấp cho cộng đồng:

Tích hợp thuật toán nội suy (Interpolation) để marker xe di chuyển mượt mà hơn (60fps) khi phát lại (Replay) thay vì nhảy cóc từng tọa độ.

Thêm nút "Dẫn đường đến đây" (mở Google Maps) khi click vào Trạm sạc.

⚠️ Lưu ý quan trọng cho Developers
Clear Cache (Xóa bộ nhớ đệm): Khi bạn lưu file .js, ứng dụng Home Assistant (đặc biệt là trên điện thoại) sẽ cache file cũ rất lâu. Luôn nhớ dùng tổ hợp phím Ctrl + F5 hoặc xóa bộ nhớ ứng dụng để xem thay đổi.

Không Block Main Thread: Do hàm set hass được gọi liên tục vài chục lần mỗi giây, tuyệt đối không viết các vòng lặp nặng (như parse mảng tọa độ hàng ngàn điểm) bên ngoài các câu lệnh điều kiện. Khối lượng tính toán nặng phải được bọc trong điều kiện kiểm tra sự thay đổi.

An toàn kiểu dữ liệu (Type Safety): Dữ liệu MQTT trả về đôi khi bị lỗi hoặc bị thiếu. Luôn sử dụng toán tử Optional Chaining (?.) và Try-Catch khi làm việc với JSON từ Backend.

Chúc các bạn tùy biến giao diện thật ngầu cho chiếc xe VinFast của mình! 🚗⚡
Mọi đóng góp, báo lỗi (Pull Requests / Issues) xin vui lòng chia sẻ lại cho cộng đồng.
