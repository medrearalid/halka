# Halka tasarım dili

Arayüzdeki her değişiklik bu dosyaya uyar. Bir kural yetersiz kalırsa önce bu dosya güncellenir, sonra kod.

## İlkeler
1. **Discord alışkanlığı, Discord görüntüsü değil.** Kanallar solda kalır. Ama sahne kahramandır: kontroller tek bir yüzen dock'ta toplanır, yazışma dar bir sütunda durur, üyeler sağdan kayan bir sütunda açılır.
2. **Önce performans, ama asla eski görünüm.** Animasyon yalnızca `transform` ve `opacity` ile yapılır. Boşta döngü dönmez, pencere gizliyken hiçbir şey çizilmez. Ağır efektler GPU'da ve tek bir tuvalde yapılır.
3. **Sade ve yoğun.** Linear/Raycast tarzı: kompakt dolgu, yarı saydam 1px kenarlıklar, `tabular-nums`, `tracking-tight`, sıfır layout-shift.
4. **AI slop yok.** Mor gradyan, şişkin `rounded-2xl`, kaba gölge, dekoratif emoji, uydurma metrik kullanılmaz.

## Renk (tokenlar: `app/src/index.css` `:root`)
- **Zemin:** Grafit `--paper-0…4` (sıcak, 75° ton, çok düşük kroma).
- **Metin:** `--ink-1…3`.
- **Kenar:** `--line`, `--line-2`.
- **Sinyal:** Bakır `--copper`. Seçim, odak ve birincil eylem içindir. Ekranın %5'inden fazlasını kaplamaz.
- **Durum:** `--live` (bağlı/çevrimiçi), `--warn`, `--danger`.
- **Kural:** Bileşenlerde satır içi OKLCH, hex veya rgb yazılmaz. Yeni bir renk gerekiyorsa önce token olarak eklenir. Açık tema `prefers-color-scheme` ile aynı tokenları yeniden tanımlar.

## Cam malzeme (`.glass`)
glassdock'un imzası: üst kenarda 1px specular parlama, iki tonlu ince kenar (üst açık, alt koyu), yumuşak derinlik gölgesi, %3–4 grain.
- **Nerede:** Yalnızca **yüzen** yüzeylerde kullanılır: dock, dar ekrandaki yazışma çekmecesi, profil kartı ve diğer popover'lar. Sabit sütunlarda ve büyük panellerde kullanılmaz, çünkü `backdrop-filter` pahalıdır.
- **Tokenlar:** `--glass-bg`, `--glass-sheen`, `--glass-rim-hi`, `--glass-rim-lo`, `--glass-shadow`, `--glass-blur`, `--glass-grain-opacity`.

## Tipografi
- **Yazı tipleri:** Geist Variable (gövde ve başlık) ve Geist Mono (kısayollar, kodlar).
- **Gövde:** 13px, satır aralığı 1.45.
- **Küçük etiketler:** 11px (`text-2xs`). Bölüm etiketleri büyük harf ve geniş harf aralıklıdır.
- **Başlıklar:** Her zaman dik; italik başlık yok. Vurgu ağırlıkla ya da bakır renkle yapılır.

## Düzen
- **Karşılama:** Üstte Geist başlık ve halka seçimi, alt kenarda iki sıra halinde eşit aralıklı, tek renk çizimli büstlerden oluşan kalabalık. Komşular çiftler halinde birbirine döner; geniş ekranda bir çizim tekrar ederse en az bir düzine kişi uzakta durur. Hareket yalnızca nefes, hafif baş salınımı ve sırayla konuşan çiftlerde küçük baş hareketidir; yüz çizgileri asla bükülmez ve hareket 18 saniyelik kesintisiz bir döngüdür. Çiftler ve zamanlama ekrana her girişte çeşitlenir. Tek WebGL tuvali gizli pencerede durur, azaltılmış hareket tercihinde sahne sabittir. Sol menüde halka seçicinin yanındaki ev düğmesi karşılama ekranına döner.
- **Kenar çubuğu:** ~220px.
- **Başlık:** 44px.
- **Ses kanalı:** Sahne geniş kalır. Yazışma sağda 300px'lik bir sütundur. Container 768px'in altına inince yazışma sahnenin üstüne açılan cam bir çekmeceye dönüşür.
- **Metin kanalı:** Okuma genişliği en fazla 880px'tir, içerik ortalanır.
- **Köşe yarıçapı:** 4–10px. Dock ve haplar `rounded-full`.

## Ses orb'u
- **Çizim:** Sahnedeki orb'lar `OrbStage` üzerindeki **tek bir WebGL2 tuvalinde**, tek draw call ile çizilir (`lib/orbGl.ts`). Her orb avatarın etrafında üç ince (~1px) ışıklı halkadır. Orta halka beyaza yakın bir çekirdektir, dıştaki iki halka kişinin `orb_color`'ından ±ton kayması taşır.
- **Sessiz:** Halkalar tek bir kıl çizgisinde birleşir ve yavaş nefes alır.
- **Konuşurken:** Halkalar ayrılır, genişler, düşük frekanslı gürültüyle eğilir (titremez) ve kenardan seyrek kıvılcımlar saçılır.
- **Susturulmuş / sağır:** Sabit, sönük halka.
- **Ortam ışığı:** En yüksek sesli konuşanın rengi sahnenin ortam ışığına çok hafif yansır.
- **Kare hızı:** Konuşma varken tam hız, herkes sessizken 15 fps. Pencere gizliyken ya da `prefers-reduced-motion` açıkken çizim durur; reduced-motion'da tek bir sabit kare çizilir.
- **Geri dönüş:** WebGL2 yoksa ya da bağlam kaybolursa, mini koltuklarda ve profil önizlemesinde CSS ile çizilen ince halka (`.voice-orb::before`) kullanılır.

## Etkileşim
- **Durumlar:** Her düğmenin 8 durumu vardır: default, hover, `:focus-visible` (2px bakır halka, anında görünür), active (`scale .95–.97`), disabled (%40 opaklık), loading, error, success.
- **Tooltip ve kısayol:** Tooltip'ler kısayolu Geist Mono ile gösterir.
- **Yayın bildirimi:** Yayın ilk kareyi gönderdiğinde monitör kenarında `--live` renginde, kapanırken `--danger` renginde kısa bir çerçeve belirir ve opaklığı azalarak kaybolur. Çerçeve odağı değiştirmez.
- **Geri bildirim:** Başarı sessizdir; onay diyaloğu yerine geri alınabilir eylem tercih edilir.
- **Süreler:** 150 ms (`--dur-1`) ve 200 ms (`--dur-2`). Easing için `--ease-out` kullanılır; zıplama yok.

## Ekler ve süreli mesajlar
- **Ekleme:** Yazı kutusuna yapıştırma, sohbete sürükle-bırak (kesik bakır çerçeveli "Eklemek için bırak" katmanı) ve ataş düğmesi. Ekler yazı kutusunun üstünde 48px yüksekliğinde çipler olarak durur: görselde küçük önizleme, dosyada ikon; yüklenirken altta 1px bakır ilerleme çizgisi.
- **Görseller:** Gönderilmeden önce WebP'ye çevrilir. Mesajda imzalı boyuttan ayrılan kutuda gösterilir (en fazla 400×320, dar sütunda 240 genişlik), bu yüzden yüklenirken layout-shift olmaz. Kademe sınırını aşan görsel "Görseli yükle · boyut" hapıyla bekler.
- **Dosya kartı:** 48px, ad + `tabular-nums` boyut, sağda tek eylem (İndir → Kaydet → Göster). Çalıştırılabilir dosyada ikon `--warn` olur ve Kaydet iki adımlıdır.
- **Süre:** Yazı kutusunda `Timer` ikonu; süre seçiliyse bakır renkte kısa etiket (`5 dk`). Süreli mesajın başlığında bakır `tabular-nums` geri sayım çipi durur. Süresi dolan ya da silinen mesaj yer tutucu bırakmadan kaybolur.

## Kurulum ve güncelleme
- **Installer:** Açık tema (açık `--paper-1` zemin, `--ink-1` metin, bakır ilerleme). Karşılama sayfasında solda uygulama simgesi, "Halka" yazısı ve geliştirici adı (Guney); sağda tek paragraf tanıtım. Ardından kurulum klasörü seçimi ve ilerleme sayfası gelir; bitiş sayfası yoktur, kurulum bitince uygulama kendiliğinden açılır. Alt satırda telif (© Guney) durur. Güncellemeler bu ekranları göstermez, sessiz kurulur.
- **Güncelleme hapı:** Başlık çubuğunda, pencere kontrollerinin solunda `rounded-full`, 11px bir hap. Boştayken hiç yer kaplamaz. İndirirken `tabular-nums` yüzde ve 1px bakır ilerleme çizgisi gösterir. Hazır olduğunda "Yeniden başlat" bakır renkli birincil eylemdir. Hatada `--danger` noktası ve "Tekrar dene" bulunur.
- **Neler değişti:** Güncellemeden sonraki ilk açılışta başlık çubuğunun altında, sağ üstte yüzen `.glass` bir kart çıkar. Kartta sürüm başlığı, en fazla altı madde ve tek bir "Tamam" düğmesi bulunur. Notlar `CHANGELOG.md`'den gelir; yalnızca kullanıcıya dönük Türkçe maddeler yazılır.
