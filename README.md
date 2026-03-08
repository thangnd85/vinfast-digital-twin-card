🚗 VinFast Digital Twin Card cho Home Assistant
VinFast Digital Twin Card là một thẻ giao diện tùy chỉnh (Custom Lovelace Card) siêu việt dành riêng cho hệ sinh thái xe điện VinFast trên Home Assistant. Giao diện được thiết kế lấy cảm hứng từ màn hình trung tâm của Tesla và Rivian, mang đến trải nghiệm thị giác tuyệt đẹp và dữ liệu viễn trắc thời gian thực.

⚠️ YÊU CẦU BẮT BUỘC: Card này chỉ là phần Giao diện (Frontend). Để Card hoạt động và có dữ liệu, bạn BẮT BUỘC phải cài đặt lõi xử lý VinFast Connected Car Integration (Backend) trước.

https://github.com/thangnd85/vinfast-connected-car

✨ Tính năng Nổi bật
Thẻ được thiết kế thành một khối liền mạch (All-in-One), sử dụng công nghệ Web Components cực nhẹ, không gây giật lag cho thiết bị:

🏎️ Digital Twin (Bản sao kỹ thuật số): Tự động tải hình ảnh chiếc xe thực tế của bạn từ máy chủ VinFast. Áp suất lốp 4 góc được ghim lơ lửng ngay cạnh bánh xe.

⚡ Phân tích Động học (Analytics Grid): Hiển thị toàn bộ thông tin quan trọng nhất: % Pin, Range, Quãng đường Trip, Số kWh sạc lần cuối, và đặc biệt là "Dải tốc độ tối ưu nhất".

🎮 Điều khiển Thông minh (Dynamic Controls): Nút bấm Mở khóa, Bật điều hòa. Tích hợp AI tự động phát hiện dòng xe (VD: VF 3) để giấu đi các nút điều khiển từ xa không được hỗ trợ.

🧭 Bản đồ tĩnh tâm (Anti-Flicker Map): Tự động vẽ bản đồ OpenStreetMap thu nhỏ. Thuật toán làm tròn tọa độ thông minh giúp bản đồ không bao giờ bị nhấp nháy/tải lại khi xe đang đỗ tại chỗ.

🚨 Cảnh báo An toàn & Tốc độ: Hiển thị trực quan trạng thái Cần số (P-R-N-D). Đồng hồ tốc độ to rõ tự động phóng to khi bánh xe lăn và thu gọn khi dừng đèn đỏ. Hiển thị cảnh báo tức thì nếu cửa mở hoặc chưa khóa.

📥 Hướng dẫn Cài đặt (Qua HACS)
Cách dễ nhất và được khuyên dùng là cài đặt thông qua HACS (Home Assistant Community Store).

Mở Home Assistant, đi tới menu HACS ở cột bên trái.

Chọn tab Frontend (Giao diện).

Bấm vào biểu tượng 3 chấm ở góc trên bên phải, chọn Custom repositories (Kho lưu trữ tùy chỉnh).

Nhập các thông tin sau:

Repository: https://github.com/thangnd85/vinfast-digital-twin-card

Category: Chọn Dashboard.

Bấm Add (Thêm). Lúc này "VinFast Digital Twin Card" sẽ xuất hiện, bạn bấm vào và chọn Download.

Khi có thông báo yêu cầu tải lại tài nguyên, hãy bấm Reload (Tải lại) hoặc khởi động lại trình duyệt của bạn (Bấm Ctrl + F5 hoặc xóa Cache trên điện thoại).

💻 Cấu hình Card lên Dashboard (Lovelace)
Truy cập vào trang Dashboard của bạn, bấm vào biểu tượng Cây bút chì (Edit Dashboard) góc trên bên phải.

Chọn Thêm Thẻ (Add Card).

Cuộn xuống dưới cùng và chọn thẻ Thủ công (Manual).

Copy và dán đoạn mã YAML dưới đây vào:

YAML
``

type: custom:vinfast-digital-twin

entity_prefix: vf8_abcd12345678

``

Prefix theo quy ước: dongxe_sovin

🔍 Làm sao để tìm entity_prefix của bạn?
entity_prefix là từ khóa đại diện cho xe của bạn (giúp Card biết cần lấy dữ liệu từ chiếc xe nào nếu nhà bạn có 2 xe trở lên).

Trong Home Assistant, vào Cài đặt -> Thiết bị & Dịch vụ -> Chọn tab Thực thể (Entities).

Gõ chữ vinfast để tìm các cảm biến của xe.

Nhìn vào ID của một cảm biến bất kỳ (VD: sensor.vf8_abcd12345678_phan_tram_pin).

Bỏ chữ sensor. ở đầu và bỏ phần chức năng _phan_tram_pin ở cuối.

Đoạn còn lại ở giữa chính là prefix của bạn: 👉 vf8_abcd12345678

📸 Ảnh chụp màn hình (Screenshots)

<img width="500" alt="image" src="https://github.com/user-attachments/assets/d5b1666f-5321-4d29-8ed7-5c3807aa52fd" />
<img width="500"  alt="image" src="https://github.com/user-attachments/assets/59173aa8-d57f-4b66-93a3-149934806b94" />
<img width="500"  alt="image" src="https://github.com/user-attachments/assets/9577a9b1-3417-4d9f-87ce-ec4a8c8f3ee1" />

<p align="center">
<b>Giao diện hiển thị Gọn gàng - Responsive 100% trên cả Điện thoại và Tablet.</b>
</p>

🛠️ Xử lý sự cố (Troubleshooting)
Card báo lỗi "Custom element doesn't exist": 👉 HA chưa nhận được file JS. Hãy vào Cài đặt -> Dashboards -> Nút 3 chấm (Góc trên phải) -> Resources. Đảm bảo đường dẫn /hacsfiles/vinfast-digital-twin-card/vinfast-digital-twin.js đã được thêm vào và là loại JavaScript Module. Sau đó xóa Cache trình duyệt (Ctrl + F5).

Card hiện chữ "Đang định vị..." hoặc "Đang thu thập...":
👉 Xe đang trong trạng thái ngủ hoặc chờ tín hiệu từ MQTT. Hãy mang xe ra đường chạy một vòng hoặc cắm sạc để hệ thống phân tích động học có dữ liệu đầu vào.

Hình xe bị trống:
👉 Mở ứng dụng VinFast chính chủ trên điện thoại của bạn 1 lần để máy chủ VinFast cấp lại đường dẫn URL hình ảnh 3D cho xe.

💖 Ủng hộ dự án
Dự án này là hoàn toàn miễn phí và mã nguồn mở. Nếu bộ giao diện này giúp trải nghiệm xe điện của bạn tuyệt vời hơn, đừng ngần ngại nhấn ⭐ Star cho kho lưu trữ này và chia sẻ nó tới Cộng đồng những người sử dụng xe điện VinFast!
