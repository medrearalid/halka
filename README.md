# Halka

Sunucusuz, uçtan uca şifreli sesli sohbet, yazışma ve ekran paylaşımı. Discord'un yaptığı işi
yapar, ama arada kimsenin sunucusu yoktur. Halkayı oluşturan kişinin bilgisayarı da dahil.

- **Halka**: Discord'daki "sunucu"nun karşılığı. Metin kanalları, sesli odalar, roller ve
  yetkiler, davetler, yasaklar.
- **Sesli oda**: Bir yuvarlak masa. Herkes çemberde bir koltukta oturur. Sesler stereo olarak
  koltuğun yönünden gelir; ekranda solda gördüğün kişiyi solda duyarsın.
- **Ekran paylaşımı**: Donanım hızlandırmalı H.264 (yoksa VP9/VP8) kullanır ve doğrudan
  izleyicilere gider.
- **Bas-konuş**: Pencere arka plandayken de çalışır (oyun içinde). Fare yan tuşları da
  desteklenir.
- **Aynı ağda internetsiz çalışır**: Arkadaşlar mDNS ile bulunur.

## Çalıştırma

```bash
cd app
bun install
bun x @tauri-apps/cli@2 dev        # geliştirme
bun x @tauri-apps/cli@2 build      # kurulum dosyası: target/release/bundle/nsis/
```

Bir bilgisayarda iki ayrı kimlik açmak için: `halka.exe --profile ikinci`.

Arayüz tarayıcıda sahte bir arka uçla da çalışır: `cd app && bun run dev` → http://localhost:1420.
Testler:

```bash
cargo test --workspace        # durum makinesi, protokol, ses hattı, uçtan uca 3 düğüm
cd app && bun test tests       # akış paket formatı, koltuk/pan hesabı
cargo build --profile fastrel -p halka --features tauri/custom-protocol
bash tools/e2e/run.sh          # iki gerçek örnek: isim, halka, davet, katılma, sohbet, XSS, ses odası, ekran paylaşımı
```

## Mimari

```
app/src/          React 19 + Tailwind 4 arayüz (WebView2). Ağ ya da kripto kodu içermez.
app/src-tauri/    İnce köprü: komutlar, olaylar ve ham ikili yayın paketleri.
crates/core/      Her şeyin olduğu yer (Tauri'den bağımsız, tek başına test edilir):
  id, op, space   İmzalı işlem DAG'ı ve deterministik yetki motoru
  msg, store      İmzalı mesajlar, redb kalıcılığı
  wire, net       QUIC protokolü, kabul kapısı, senkronizasyon, ses ve yayın taşıma
  voice           cpal → sonora (AEC3, gürültü bastırma, AGC2) → Opus → jitter buffer → stereo mikser
  node            Komut yüzeyi
```

**Ağ.** [iroh](https://iroh.computer) kullanılır. Her kurulumun kimliği bir ed25519
anahtarıdır; eşler birbirini bu anahtarla arar. Bağlantı mümkünse NAT delme ile doğrudan
kurulur. Olmazsa yalnızca şifreli paketleri ileten bir relay devreye girer. Relay içeriği
okuyamaz.

Bağlantı başına üç kanal vardır:
- tek bir kontrol akışı (uzunluk önekli postcard çerçeveler),
- ses için QUIC datagramları (20 ms Opus, FEC açık),
- yayın için her GOP'a ayrı bir tek yönlü akış.

Yayında izleyici geride kalırsa eski GOP bırakılır ve bir sonraki anahtar kareden devam edilir
(Media-over-QUIC'ten esinlenildi). Böylece yavaş bir izleyici yayını herkes için bozmaz.

**Durum.** Her halka imzalı işlemlerden oluşan bir DAG'dır. İşlemler (oluştur, kanal, rol,
davet, katıl, at, yasakla…) yazarı tarafından imzalanır. Her işlemin Lamport saati
`max(ebeveyn) + 1`'e eşit olmak zorundadır, bu yüzden `(saat, id)` sırası topolojik bir
sıradır. Durum bu sırayla yeniden oynatılır ve her işlemin yetkisi o ana kadarki duruma göre
kontrol edilir. Tüm eşler aynı sonuca varır.

Eşler arasındaki fark kova özetleriyle (XOR + sayı) bulunur. Yalnızca farklı kovalarda kimlik
listesi alınıp verilir.

**"İptal kazanır" kuralı.** Atılan bir üyenin, atılma işlemiyle eşzamanlı (yani atılmayı
görmeden yazılmış) bütün işlemleri geçersiz sayılır. Bu, atılan birinin DAG'ın eski bir
noktasından geriye tarihli işlem üretip geri sızmasını engeller. Bunun testi var.

## Güvenlik modeli

| Tehdit | Önlem |
|---|---|
| Dinleme / ortadaki adam | Bütün trafik TLS 1.3 ile şifreli QUIC'tir ve eş kimliği açık anahtarın kendisidir. Relay'ler içeriği göremez. Ayarlardaki güvenlik kodunu arkadaşınla karşılaştırarak bağlandığın kişiyi doğrulayabilirsin. |
| Sahte işlem veya mesaj | Her işlem ve mesaj ed25519 ile, alana ayrılmış bağlamda (domain-separated) imzalanır; doğrulamada `verify_strict` kullanılır. Kanonik olmayan kodlamalar reddedilir. Kimlik yalnızca imzasız içeriğin hash'idir, bu yüzden imza değiştirilebilirliği kimlik çatallamaz. |
| Yetki aşımı | Her işlem yeniden oynatma sırasında rütbe ve yetkiye göre kontrol edilir. Kimse sahip olmadığı bir yetkiyi veremez, kendine eşit ya da üst rütbeye dokunamaz. Kurucu atılamaz. |
| Yabancıların bağlanması | Kabul kapısı yalnızca ortak bir halkanın üyelerini ya da geçerli bir davet kanıtı getirenleri içeri alır. Davetle gelen kişi yalnızca kendi "katıl" işlemini gönderebilir. Aynı anda en fazla 32 el sıkışma yürütülür. |
| Atılan üyenin erişimi | Bağlantı kapatılmadan önce atılma işlemi ona iletilir. Çevrimdışıyken atılan biri tekrar bağlanmaya çalıştığında, sonrasını göstermeden yalnızca atılmasının kanıtı gönderilir. |
| Gizli kanallar | Bir kanalın mesajları yalnızca o kanalı görebilen eşlerle senkronize edilir. |
| Taşkın / DoS | Her çerçeve, ayırma yapılmadan önce boyut sınırından geçer. Eş başına çerçeve, bayt, işlem ve datagram hız sınırları vardır. Bekleyen işlem havuzu sınırlıdır. İzleyici sayısı ve anahtar kare isteği sıklığı kısıtlanır. |
| XSS | Arayüz mesajları yalnızca düz metin olarak gösterir. Sıkı bir CSP uygulanır (`default-src 'self'`, uzak içerik yok). Tauri yetkileri en düşük seviyededir ve prototipler dondurulur. |
| Disk | Kimlik anahtarı Windows DPAPI ile kullanıcı hesabına mühürlenir. Halkadan ayrılınca ya da atılınca o halkanın bütün mesaj ve indeksleri silinir. |
| IP adresinin görünmesi | Doğrudan bağlantı karşı tarafa IP adresini gösterir. "IP adresimi gizle" seçeneği yalnızca relay üzerinden bağlanır. |

**Dürüst sınırlar**
- **Varsayılan altyapı.** Adres bulma (DNS/pkarr) ve relay'ler varsayılan olarak number0'ın
  herkese açık altyapısını kullanır. Bunlar engellenirse:
  - aynı ağdaki arkadaşlar mDNS ile yine bağlanır;
  - davet kodları doğrudan adres taşır, bilinen son adresler de saklanır;
  - ayarlardan kendi relay adresini girebilirsin (`iroh-relay` herhangi bir VPS'te çalışır).
- **Geriye tarihli mesajlar.** Atılan bir üye, atılmadan önce yazılmış gibi görünen mesajlar
  üretebilir. Bunları yalnızca hâlâ üye olan biri senkronize ederek yayabilir. Canlı gönderimde
  reddedilirler.
- **Gizli kanal adları.** Gizli kanalların adları ve rol yapısı bütün üyelerin işlem kaydında
  görünür. Mesajları görünmez.
- **Ölçek.** Ses tam ağ (mesh) topolojisinde akar. 8–10 kişiye kadar rahattır; daha
  kalabalık odalar için seçici yönlendirme (SFU benzeri) gerekir.
- **Platform.** Global bas-konuş ve DPAPI yalnızca Windows'ta vardır.

## Doğrulama durumu

**Bu makinede otomatik test edilenler**
- **Rust testleri: 16 birim + 5 uçtan uca.**
  - İmza ve alan ayrımı.
  - Yetki ve rütbe kuralları.
  - Geriye tarihli işlemle atılmayı ya da rütbe düşürülmeyi atlatma girişiminin reddi.
  - Sıra bağımsız yakınsama.
  - Ses hattı: kayıp gizleme ve stereo panlama.
  - Uçtan uca 3 düğüm: katılma, sohbet, düzenle/sil, atma, ekran paylaşımı.
  - Yeniden başlatma sonrası kalıcılık.
- **Yankı engelleme:** hoparlörden mikrofona sızan konuşma benzeri sinyalin yaklaşık 50 dB'i siliniyor; AEC kapalıyken bu oran 3 dB.
- **Gerçek mikrofon, ağ üzerinden:** AMD mikrofon dizisinin gerçek oda sesi yakalandı, kodlandı, gönderildi ve karşıda −78 dBFS olarak çözüldü. Kendi mikrofonunla tekrarlamak için: `HALKA_TEST_MIC="<aygıt adı>" cargo test --test e2e real_mic -- --ignored`.
- **Kurulum:** sessiz kurulum, üzerine kurulum ve kaldırma çalışıyor. Etkileşimli sihirbaz da Hoş geldin → Kur → Bitir adımlarıyla dosyaları, Başlat menüsünü ve kaldırma kaydını oluşturdu; Bitir'e basınca 0 koduyla kapanıp Halka'yı başlattı.
- **Gerçek ses, ağ üzerinden.** A'nın mikrofonu yerine 440 Hz test tonu verildi; B tonu doğrudan bağlantıda 0,77, yalnızca public relay üzerinden 0,72 seviyesinde duydu. İkinci ölçüm aynı zamanda relay'lere bu makineden (Türkiye) erişimi doğruluyor; gidiş-dönüş süresi yaklaşık 240 ms.
- **Gerçek uygulamanın iki örneği arasında, gerçek fare ve klavye girdisiyle:**
  - isim, halka oluşturma, davet kodu ve katılma;
  - iki yönlü sohbet; `<img onerror>` denemesi düz metin kalıyor;
  - rol oluşturma ve sağ tık menüsünden atama; "herkes" rolünden yetki kaldırma;
  - gizli kanal; mesaj düzenleme ve silme;
  - ayar kaydı ve halkadan atma;
  - aynı profil ikinci kez açılınca sessizce kapanma;
  - ekran paylaşımı: 1920×1080 kareler karşıda çiziliyor, pencere simge durumundayken de yaklaşık 29 fps sürüyor.

**Henüz doğrulanmayanlar**
- **Bir insanın sesi ve kulakla dinleme.** Bu makinedeki kulaklık mikrofonu test sırasında kapalıydı; ses hattı test tonu ve gerçek oda sesiyle ölçüldü.
- **İki ayrı evden doğrudan bağlantı (NAT delme).** Doğrudan bağlantı yalnızca aynı makinede, relay yolu ise internet üzerinden test edildi; doğrudan kurulamazsa relay devreye girer.
- **İlk açılışta Windows Güvenlik Duvarı izni.** Windows izin ister. İzin verilirse doğrudan bağlantı kurulabilir, verilmezse relay kullanılır.
