STAFF MONITOR v2.7.5 - DEVICE LIFECYCLE FIX

FIX UTAMA
1. Edit Nama PC sekarang permanen. Agent hanya memperbarui hostname Windows dan tidak menimpa nama yang dibuat admin.
2. HAPUS DEVICE sekarang = revoke + delete. PC hilang dari dashboard dan agent yang masih aktif tidak bisa mendaftarkan diri kembali.
3. Menu PC Diblokir untuk SUPER_ADMIN menampilkan UID yang dihapus. Tombol IZINKAN LAGI membuka blokir sehingga PC boleh enroll ulang.
4. revoked_devices tidak lagi dibersihkan otomatis saat migration, supaya penghapusan benar-benar bertahan setelah Railway restart.

DEPLOY
Deploy seluruh folder ini ke Railway menggantikan source sebelumnya. Variable Railway tetap gunakan nilai yang sekarang; DEVICE_ENROLL_SECRET harus sama dengan installer.

ALUR
HAPUS DEVICE -> UID diblokir -> row device/history dihapus -> agent retry mendapat 403 -> PC tidak muncul lagi.
PC Diblokir -> IZINKAN LAGI -> UID dibuka -> agent retry -> PC muncul lagi sebagai device baru.

CATATAN
Nama PC yang diedit admin disimpan di devices.name. Nama asli Windows disimpan terpisah di devices.hostname.
