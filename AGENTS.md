## Graphify

- Projede bir şey ararken önce `graphify query "<sorgu>" --budget 1500` kullan. İki öğe arasındaki ilişki için `graphify path`, tek bir öğe için `graphify explain` kullan. Grafiğin yanıtlamadığı noktalar için aramayı ilgili dosyalarla sınırla.
- Projedeki her düzenleme grubundan sonra, işi tamamlamadan önce proje kökünde `graphify update .` çalıştır. Güncelleme başarısız olursa sonucu bildir.

## Birlikte çalışma (sahip, Claude, ChatGPT)

- Bu repoda aynı çalışma dizininde birden fazla ajan çalışıyor. Yalnızca kendi değiştirdiğin dosyaları commit'le: `git add <dosya>` ile tek tek ekle; `git add -A`, `git add .` veya `git commit -a` kullanma.
- Commit mesajının sonuna kimin yaptığını yaz (`Co-Authored-By: ...`).
- Commit, sahibin onayı demektir: yalnızca sahip istediğinde commit'le. Commit'lenen her şey bir sonraki release'e girebilir, commit'lenmemiş hiçbir şey giremez.
- Push etme, tag atma, release çıkarma; sürüm yükseltme, tag ve push Claude'un işidir.
- Başka bir ajanın commit'lenmemiş değişikliklerine dokunma; geri alma, stash'leme, yeniden yazma.

## Arayüz

- Arayüzde yapılan her değişiklik kökteki `DESIGN.md` dosyasına uyar (renk tokenları, cam malzeme, yoğunluk, orb kuralları). Yeni bir görsel karar gerekiyorsa önce `DESIGN.md` güncellenir.
