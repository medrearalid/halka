# Halka sürüm notları

Her sürüm `## <sürüm>` başlığıyla başlar. Maddeler kullanıcıya dönük ve Türkçedir; uygulamadaki "Neler değişti" kartı ve GitHub sürüm sayfası bu dosyadan beslenir.

## 0.1.10

- Ses odasında herkesin kendi pingi ve bağlantısının doğrudan mı relay mi olduğu ayrı ayrı görünüyor; senin koltuğunda da kendi pingin var.
- Bağlantı etiketinin üzerine gelince sana olan bağlantı ve relay'e neden düşüldüğü yazıyor.
- Relay üzerinden izlenen yayınlarda ses artık kesilmiyor; bağlantı zorlanınca yayın kalitesi ping yükselmeden düşüyor.
- Relay şart bir halka için açılan IP gizleme, o halkadan ayrılınca bir sonraki açılışta kendiliğinden kapanıyor.

## 0.1.9

- Sesler artık daha yüksek: kısık mikrofonlar konuşma düzeyine otomatik yükseltiliyor.
- Pencere paylaşırken o uygulamanın sesi de yayına gidiyor; yalnızca yayını izleyenler duyar. Tam ekran paylaşımı şimdilik sessiz.
- Odadaki biri katıldığında, ayrıldığında, bağlantısı koptuğunda, mikrofonunu ya da kulaklığını kapatıp açtığında, yayın başlatıp bitirdiğinde bildirim sesi çalıyor.
- Davet kodu oluşturunca pencere taşmıyor.

## 0.1.8

- Sohbetteki görsele tıklayınca büyük açılıyor; dışına tıklayarak ya da Esc ile kapanıyor.

## 0.1.7

- Dosya ve görsel gönderebilirsin: ataş düğmesi, sürükle-bırak ya da panodaki ekran görüntüsünü doğrudan yapıştırma.
- Görseller indirmeye gerek kalmadan sohbette görünür; gönderilmeden önce konum gibi gizli bilgileri silinir.
- Relay'siz halkalarda 500 MB'a, relay şart halkalarda 50 MB'a kadar dosya gönderilebilir. Çalıştırılabilir dosyalar kaydedilmeden önce uyarır.
- Süreli mesajlar: mesaja süre koyabilirsin, kanalın varsayılan süresi de ayarlanabilir. Süre dolunca mesaj her yerden kalkar.
- Silinen ve süresi dolan mesajlar diskte de geri getirilemez; her mesaj kendi anahtarıyla şifrelenir ve anahtar silinir.
- Relay şart halkalarda süreli mesajlar yalnızca bellekte tutulur.

## 0.1.6

- Halka oluştururken "Relay şart" seçebilirsin: üyeler yalnızca relay üzerinden bağlanır, IP adresleri birbirinden gizli kalır.
- Kurucu relay şartını sonradan da açabilir; böyle halkaların adının yanında kalkan simgesi görünür.
- Relay'i açınca uygulama hemen yeniden başlıyor ve kaldığın yere dönüyor.
- Kurucu halkayı bütün üyeler için silebilir.
- "Halkayı yönet" artık uygulama ayarlarından ayrı; yeni Bağlantı ve Üyeler sekmeleriyle halkayı ayrıntılı yönetebilirsin.
- Relay ile doğrudan bağlantının farkı sade bir dille anlatılıyor.

## 0.1.5

- Karşılama ekranındaki kalabalık ekrana eşit dağılıyor; hareketler sade ve akıcı, yüzler artık bozulmuyor.
- Kurulum açık temada; kurulum klasörünü seçebiliyorsun.
- Arka planda güncelleme denetimi başarısız olursa artık başlık çubuğunda hata görünmüyor, kısa süre sonra yeniden deneniyor.

## 0.1.4

- Ekran paylaşımı artık Halka panelinden başlıyor; Windows yayın kısayolları eklendi.
- Tam ekran yayından çıkınca önceki pencereye, oyundaysan oyuna geri dönülüyor.
- Ses odası yenilendi; üye panelinde rol sıralama ve profil önizlemesi geliştirildi.
- Yalnızca aktarıcı ayarı, bağlantı hatasında bile IP adresini gizli tutuyor.
- Güncellemeler başlık çubuğunda görünüyor: indirme durumu, "Yeniden başlat" ve hata olursa "Tekrar dene".
- Yeni kurulum ve karşılama ekranı: açılışta halkanı seçiyorsun.

## 0.1.3

- Geliştirme sürümleri artık kurulu Halka'yı engellemiyor.
