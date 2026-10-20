# Mobile Pick/Pack UX and Barcode Scanning for a Web-Based ERP (as of Oct 2026)

Scope: Freeze Pipe ERP (React 18 + Vite + TS + Tailwind/shadcn on Vercel, Supabase backend), 2-5 warehouse staff using own iPhones/Android phones; ShipStation for labels. Research date 2026-10-19. Sourcing note: search tools returned mostly vendor/reseller pages; prices are retail snapshots and several vendor claims conflict (flagged inline). Items in "Inferences" are my engineering judgement, not sourced facts.

---

## 1. App delivery: PWA vs Capacitor vs plain mobile web; iOS/Android capabilities; session/login

### Takeaway
A PWA (installed to Home Screen) is viable for a small team: iOS 16.4+/18.4+ supports installed-PWA Web Push, Screen Wake Lock, badging and getUserMedia, but iOS still lacks Vibration, Web Bluetooth/HID/Serial/NFC and any Background Sync, and has long-standing camera-stream bugs in standalone mode (stream lost / re-prompted on route changes). A Capacitor wrapper is only unavoidable if you need native camera scanning (ML Kit), iOS haptics, NFC badge on iOS, or Bluetooth SDK integration.

### Cited Findings
- firt.dev (last updated 13 Oct 2026) iOS PWA table: getUserMedia supported since iOS 13.0; Screen Wake Lock since 16.4 and fully for installed PWAs since 18.4; Web Push since 16.4 only for installed Home Screen apps (not in Safari tab); Declarative Web Push since 18.4 (no service worker needed); App Badging since 16.4 installed-only; Persistent storage since 15.2, Storage Quota since 17; login cookies copied into installed app since 17.2. — [firt.dev iOS PWA compatibility](https://firt.dev/notes/pwa-ios/)
- Same table: iOS Vibration API NOT supported; Background Sync, Periodic Background Sync, Background Fetch NOT supported; Web Bluetooth, WebSerial, WebHID, WebNFC NOT supported. — [firt.dev](https://firt.dev/notes/pwa-ios/)
- iOS 26 (26.0): every website can be installed as a web app; opens as a web app by default even without manifest or `apple-mobile-web-app-capable` meta. — [firt.dev](https://firt.dev/notes/pwa-ios/)
- Standalone-mode camera issues are long-standing WebKit bugs: a 2020 report says the getUserMedia stream is stopped whenever the main route changes in standalone mode (WebKit engineer reproduced; Safari tab unaffected); a 2024 report describes stream failing in standalone on iOS 17.4.1; a June 2025 Apple Developer thread reports intermittent repeated permission prompts in a Next.js app. Workaround reported: avoid hash/route changes (e.g., router in abstract/in-memory mode) or keep the video element/stream mounted in a persistent component. — [WebKit bug 215884](https://bugs.webkit.org/show_bug.cgi?id=215884), [WebKit bug 273938](https://bugs.webkit.org/show_bug.cgi?id=273938), [Apple Dev Forums thread 788518](https://developer.apple.com/forums/thread/788518), [Apple Dev Forums thread 724683](https://developer.apple.com/forums/thread/724683)
- I found no iOS 17/18/26 release note confirming a fix to the above; status unconfirmed. — (search result summary of the links above)
- Web NFC (NDEFReader) is supported in Chrome for Android (89+), Opera Android, Samsung Internet; not on iOS Safari (iOS NFC needs native Core NFC). — [web.dev Web NFC](https://web.dev/nfc?authuser=8), [Progressier NFC PWA demo](https://progressier.com/pwa-capabilities/nfc), [unfc README](https://unpkg.com/unfc@1.0.3/README.md)
- WebHID on Android: Chromium "Intent to Prototype/Ship" thread (13-21 Aug 2026) says Android support planned for Chrome 157 (DevTrial in Chrome 154); already shipped on desktop. Earlier March-2026 guide said Chrome Android had no WebHID. — [blink-dev thread](https://groups.google.com/a/chromium.org/g/blink-dev/c/aEsVkIFFYPE/m/KcxvyOIcBQAJ)
- Google's Chrome help says iPhone/iPad cannot connect websites to USB, serial or HID devices. — [Chrome Help](https://support.google.com/chrome/answer/12576972?hl=ja)
- Capacitor option: unofficial `@capacitor-mlkit/barcode-scanning` (Capawesome) wraps Google ML Kit; Android + iOS, on-device/offline, multi-code scan, torch and autofocus, optional ready-made scanner UI; tutorial suggests iOS deployment target >= 15.5. Capawesome also sells a separate "Capacitor Barcode Scanner" plugin (Insiders/paid) adding web, batch and embedded scanning. — [Capawesome ML Kit plugin](https://capawesome.io/plugins/mlkit/barcode-scanning), [Capawesome docs](https://capawesome.io/docs/sdks/capacitor/mlkit/barcode-scanning/)
- Supabase Realtime: backgrounded tabs/minimized apps are throttled, heartbeats can be skipped and the WebSocket drops silently; Supabase recommends `heartbeatCallback` to detect and reconnect, and the Web Worker option (`realtime: { worker: true }`) to avoid timer throttling; reconnect does not replay missed events so re-fetch state on reconnect/visibilitychange. — [Supabase troubleshooting](https://supabase.com/docs/guides/troubleshooting/realtime-handling-silent-disconnections-in-backgrounded-applications-592794), [Supabase discussion #5641](https://github.com/orgs/supabase/discussions/5641)

### Inferences
- Recommended path: React PWA first (Home Screen install on iOS, Chrome install on Android), camera scanning in-browser plus Bluetooth HID scanners as the reliable fast path. Add a Capacitor shell only if iOS standalone camera instability proves unacceptable in testing, or the owner wants iOS haptics/NFC.
- To dodge the iOS standalone camera bug: make the scan screen a single persistent route (no router navigation while scanning; drive "next pick" with state, not URL changes), keep one `MediaStream` alive across picks, and test on iOS 26.x specifically.
- Because iOS has no Background Sync, "offline queue" must be an in-app IndexedDB outbox flushed on `online`/`visibilitychange`/Realtime reconnect (not a service-worker sync). Use Supabase Realtime worker mode plus re-fetch on resume.
- Quick login for shared/rotating devices: no sourced evidence found for specifics; plausible design is Supabase Auth per staff user + long-lived refresh session on the device and an app-level PIN/QR-badge re-auth screen for "who is picking" (see Gaps). NFC badge login is Android-only via Web NFC; QR badge scanned by the same camera scanner works on both platforms.

### Gaps
- No sourced evidence on PIN/QR-badge login patterns with Supabase Auth, or on iOS PWA session/cookie lifetime (ITP 7-day eviction behavior for installed PWAs) — not found; verify empirically. (firt.dev says login cookies are copied to the installed app since 17.2 but not eviction rules.)
- No confirmation whether iOS 26.x fixed standalone-mode camera stream/permission bugs; needs on-device test.
- No data found on Android Chrome PWA session persistence or install/standalone camera behavior (generally believed fine; unsourced).

---

## 2. Camera barcode scanning in the browser (BarcodeDetector, libraries, SDKs, tips)

### Takeaway
Native `BarcodeDetector` is not usable cross-platform: caniuse shows it "disabled by default" on all Safari/iOS versions 17.0-27.x and unsupported in Firefox. Use the `barcode-detector` ponyfill (ZXing-C++ WASM via zxing-wasm, actively maintained) as the free baseline, and treat a commercial SDK (STRICH from EUR 99/mo, Scandit/Dynamsoft by quote) as an upgrade if scan speed/blur tolerance on glass-product labels disappoints. html5-qrcode and zxing-js are effectively unmaintained.

### Cited Findings
- caniuse BarcodeDetector: Chrome for Android supported (155 listed); Chrome desktop "partial" (83-158); Edge partial (83-155); Safari desktop and Safari iOS "disabled by default" 17.0 through 26.6/27.x; Firefox desktop (to 161) and Android (158) unsupported. — [caniuse](https://caniuse.com/mdn-api_barcodedetector)
- Even with the Safari flag on, it was reported broken: WebKit bug and Apple forum reports say it worked in Safari 17.6 then broke after iOS 18; one commenter said examples didn't work in Safari 18.3. — [WebKit bug 281848](https://bugs.webkit.org/show_bug.cgi?id=281848), [Apple forum 767761](https://developer.apple.com/forums/thread/767761)
- `barcode-detector` (Sec-ant): polyfill/ponyfill of the W3C Barcode Detection API using ZXing-C++ via `zxing-wasm`; formats include Code 128, EAN/UPC, ITF, Codabar, Code 39, QR, Data Matrix, Aztec, PDF417; WASM fetched at runtime, default from jsDelivr but path configurable via `prepareZXingModule` (CSP/offline); `npm i barcode-detector`; entry points `/ponyfill`, `/polyfill`. — [Sec-ant/barcode-detector](https://github.com/Sec-ant/barcode-detector)
- `zxing-wasm`: reader build ~1.04 MiB, full ~1.46 MiB, writer ~636 KiB; WASM loads lazily on first read; project active (523 commits, few open issues). — [Sec-ant/zxing-wasm](https://github.com/Sec-ant/zxing-wasm)
- Dynamsoft-published benchmark (competitor, treat as biased): zxing-wasm 3.1.2 recall 67.25% vs Dynamsoft JS 84.84% on 7,894 real images; on blurred EAN-13 images open-source ZXing/ZBar fell below 14% read rate vs Dynamsoft above 81%. — [Dynamsoft zxing-wasm benchmark](https://www.dynamsoft.com/codepool/benchmark-barcode-reading-javascript-zxing-wasm-dynamsoft-barcode-reader.html), [Dynamsoft 1D benchmark](https://dynamsoft.com/codepool/barcode-scanning-accuracy-benchmark-and-comparison.html)
- Dynamsoft four-SDK benchmark (83 images; vendor-run): Dynamsoft 428 barcodes found, avg ~278 ms/image; Scandit found 178 with ~11 s/image under default config (likely config artifact; not representative of live video scanning). — [Dynamsoft four-SDK benchmark](https://www.dynamsoft.com/blog/insights/benchmark-four-sdk-barcode-scanner-real-world-performance/)
- html5-qrcode: in maintenance mode, last release April 2023, author no longer merging PRs; built on zxing-js which is also unmaintained; Snyk rates it inactive. Reports of camera init failing on some Samsung Chrome. (Source is Scanbot, a competing vendor.) — [Scanbot comparison](https://scanbot.io/blog/popular-open-source-javascript-barcode-scanners/), [Snyk](https://security.snyk.io/package/npm/html5-qrcode)
- Quagga2 described as regularly updated but with dozens of open issues and DIY UI; same biased source. — [Scanbot: Quagga2 vs html5-qrcode](https://scanbot.io/blog/quagga2-vs-html5-qrcode-scanner/)
- STRICH pricing (official page): Basic EUR 99/month (unlimited devices/URLs, 10k scans/mo soft limit); Professional EUR 249/month (100k scans/mo); Business from EUR 4,000/year (unlimited scans, 1 app); Enterprise from EUR 7,500/year; 14-day free trial; no per-device fees; scan limits are soft. Single JS file with embedded WASM under 1 MB; symbologies include Code 128, EAN/UPC, Code 39/93, ITF, GS1 DataBar, Codabar, QR, Data Matrix, Aztec, PDF417; vendor claims GPU-accelerated pipeline, low-end-hardware tuning, no published benchmarks, no PWA/iOS standalone notes on the page. — [STRICH](https://strich.io/)
- Dynamsoft JS SDK (V11.x) licensing via reseller listing: per barcode scan counted yearly; 10,000-scan annual bundle about USD 1,371 (older V10.2 listing USD 1,273, Jan 2024); per-device licensing appears only for the mobile SDKs. — [ComponentSource Dynamsoft prices](https://www.componentsource.com/product/barcode-reader/prices)
- Scandit: no public prices; pricing page asks for a quote with volume discounts; a third-party tracker lists an "Express Core" per-device starter around USD 50/month (AI-extracted, unverified). — [Scandit pricing](https://www.scandit.com/pricing/), [PulseSignal](https://getpulsesignal.com/pricing/scandit)
- Scandit Web SDK licensing support article returned HTTP 403 (not read). — [Scandit support](https://support.scandit.com/hc/en-us/articles/360018771279-How-does-licensing-works-on-the-Web-SDK)

### Inferences
- Both Code 128 (location/tote labels you print) and UPC/EAN (product barcodes) are covered by all candidate engines; the real risk is camera speed on small/curved/glossy glass-product packaging and low light, not symbology support. Because you control location/tote labels, print them large with quiet zones (Code 128, or QR) so camera scan is near-instant; the product-barcode scan is the harder case.
- At 2-5 users and low scan counts STRICH Basic (EUR ~1.2k/yr) is the cheapest commercial hedge; Dynamsoft's per-scan annual bundle (~USD 1.4k per 10k scans) likely exceeds a small team's needs if they scan ~every item; Scandit needs a quote. All vendor accuracy numbers above are vendor-run and not independent.
- Practical implementation tips (engineering judgement; not sourced here): `getUserMedia` with `facingMode: environment` and 1280x720 or higher; constrain scan to a center ROI to cut decode cost; decode at ~10-15 fps via a worker; debounce identical results for ~1-1.5 s; torch via `track.applyConstraints({advanced:[{torch:true}]})` works on Android Chrome but is generally unavailable on iOS Safari; continuous-focus constraint on Android; keep one stream alive across picks. Verify each on target devices.
- Suggested build-vs-buy gate: ship with `barcode-detector` ponyfill behind an adapter interface (`onScan(code)`), run a bake-off with 30 real SKUs in the real warehouse lighting vs STRICH trial (14 days free), choose.

### Gaps
- No independent (non-vendor) benchmark found for barcode-detector/zxing-wasm vs STRICH/Scandit on live video on iPhone/Android.
- Scandit Web SDK license terms and Dynamsoft's official (non-reseller) price page not reachable.
- Torch/autofocus support matrix on iOS Safari/PWA not sourced.
- STRICH docs page returned only a redirect; no PWA/iOS standalone detail confirmed.
- Chrome Android BarcodeDetector backing engine (Google Play Services/ML Kit) not verified this session.

---

## 3. Hardware scanners (BT ring/sled/wearable), HID capture, rugged Android devices

### Takeaway
Bluetooth HID ("keyboard wedge") scanners work with any web app on iOS and Android with zero SDK: ~USD 70 (Inateck) to ~USD 365 (Socket S740) for handhelds, ~USD 800-1,400 for Zebra RS5100 rings, ~USD 1,500 for ProGlove MARK. Key caveat: on iPhone, a paired HID scanner hides the on-screen keyboard. Rugged Android handhelds with DataWedge (Zebra) type scans as keystrokes by default.

### Cited Findings
- Socket Mobile S740 retail about USD 365; DuraScan D700 about USD 312; S700-series claims ~16 h / 10,000+ scans per charge; HID (keyboard emulation) works with any app, Apple-certified for iOS; also supports app-based SPP/BLE modes. (Retailer listings, not Socket's page.) — [Spartan POS D700](https://spartanpos.com/products/socket-mobile-durascan-d700-1d-linear-screen-barcode-scanner), [LTT Partners S740](https://www.lttpartners.com/products/socketscan-reg-s740-1d-2d-imager-barcode-scanner-blue), [Neotech](https://neotech.ae/products/0-gb429d353)
- Inateck BCST-70: about USD 70 on listings; vendor claims 144 h continuous scanning and 180 days standby (another listing: 15 days working); range >35 m; compatible with iOS/Android/Windows/Mac; listings do not explicitly say "HID". — [Desertcart listing](https://www.desertcart.tw/products/253709545-bcst-70.md), [eBay](https://ebay.com/itm/276048229785)
- Zebra RS5100 ring scanner: CHF 769 / GBP 806 / EUR 907 retailer prices (US reseller USD 1,360, out of stock); standard battery 480 mAh ~12 h / 14,400 scans, extended 735 mAh; Bluetooth 5.2, up to ~91 m. HID support not confirmed in these results. — [Bechtle](https://bechtle.com/ch-en/shop/zebra-rs5100-ring-scanner-bluetooth-5-2--4707629--p), [LabelZone](https://www.labelzone.co.uk/products/zebra-rs5100-ring-scanner-se4710-standard-battery-single-trigger)
- ProGlove MARK Basic: price from ~USD 1,505 (AU retailer incl. GST) / GBP 590 in a 2020 UK launch; battery claims conflict (3,000 / 5,000 / 7,000 scans per charge); BLE; spec sheet lists Android HID and iOS HID interfaces. Pairing in HID: scan the "BLE HID Pairing Barcode" with MARK, then add it as a keyboard in OS Bluetooth settings; ProGlove blog says BLE HID must be configured not to send Enter after each character in some use cases. ProGlove also has an "iOS virtual keyboard toggle" doc page. — [POSMarket](https://www.posmarket.com.au/products/barcode-scanners/wearable/proglove/mark-basic_20018.html), [ITSupplyChain](https://itsupplychain.com/proglove-set-to-expand-into-the-uk-market-with-award-winning-mark-product-family-of-wearable-barcode-scanners/), [ProGlove FAQ](https://docs.proglove.com/en/18595-18968-faqs.html), [ProGlove MARK Basic tech spec](https://proglove.com/wp-content/uploads/2024/05/Technical-Specification_ProGlove-MARK-Basic_January-2024.pdf), [ProGlove iOS keyboard toggle](https://docs.proglove.com/en/4605-8824-ios-virtual-keyboard-toggle.html)
- iOS keyboard behavior: ShipHero says on iPhone the only way to show the on-screen keyboard while a HID scanner is paired is to disable Bluetooth or disconnect the scanner (iPad has a toggle); a vendor claims Socket scanners restore the virtual keyboard by double-tapping the power button; one developer reports keyboard disappearing after first scan; a Shopify POS user reports later scans failing and suffix settings as the fix. — [ShipHero help](https://software-help.shiphero.com/hc/en-us/articles/4419362414733), [Shopify community](https://community.shopify.com/t/new-bluetooth-scanner-barcode-not-recognized/568524), [B4X forum](https://www.b4x.com/android/forum/threads/toggle-between-bluetooth-scanner-hid-and-ios-keyboard.60500/latest)
- ShipStation Scan to Verify: if the scanner does not send Enter (carriage return) after each scan you must click Verify manually; enabling carriage return/suffix fixes it. — [ShipStation help](https://help.shipstation.com/hc/en-us/articles/360031021831-Verify-Print-Shipments-with-Barcode-Scan)
- Zebra DataWedge sends scan results as keyboard (HID) input by default; Enterprise Browser/Kiosk Browser can instead receive intents (e.g., action `com.symbol.dw.action`, broadcast); Android 11 devices need DataWedge 11.4.205+, Android 13 needs 13.0.103+ for intent APIs. Plain Chrome cannot receive DataWedge intents, so keystroke output into a focused input is the web-app path. — [Zebra Enterprise Browser DataWedge guide](https://techdocs.zebra.com/enterprise-browser/latest/guide/datawedge), [Android Kiosk help](https://help.android-kiosk.com/en/article/zebra-tc-series-integration-barcode-scanner-16ox5x7/)
- Rugged Android price snapshots: Chainway C66 USD 269-369 (B2B marketplace, MOQ 1); Zebra TC22 about AUD 1,375 inc GST (AU retailer) / NZD 2,233 + GST; Urovo DT50 price not found (DT30 lot on eBay). — [Alibaba Chainway/Zebra listings](https://electronics.alibaba.com/product/zebra-tc26), [PB Tech TC22](https://www.pbtech.co.nz/product/POSZBR5749919/Zebra-WLMT0-T22B8CBD8-A6-TC22-WLAN-Wifi-6-SE55-6in)

### Inferences
- HID capture in React: keep one hidden/visually-minimal `<input>` always focused (`inputMode="none"` so soft keyboard never shows on Android where a HID scanner is not attached), or alternatively a global `keydown` listener that buffers characters and treats inter-key delay < ~30-50 ms followed by Enter (suffix) as a scan; require CR/LF suffix on every scanner (configure via programming barcodes); use a prefix (e.g., STX/`~`) if the scanner supports it so scans are distinguishable from manual typing; re-focus on blur/visibilitychange. Debounce duplicate scans. (Judgement; not from a source.)
- Because iPhone hides the soft keyboard while HID is paired, design every screen so no typing is required (big buttons for qty, skip, reason) and provide a camera-scan fallback button.
- With 2-5 staff, the cheapest robust setup is likely 2-3 Inateck/Socket Bluetooth scanners (~USD 70-365) used optionally; ring/wearable scanners (RS5100/ProGlove, ~USD 800-1,500 each) are probably not justified at this volume. Rugged Android (Chainway/Urovo ~USD 270-400 wholesale-listing prices; Zebra TC ~USD 900-1,500) only makes sense if personal-phone adoption or camera scanning fails.

### Gaps
- Not found: Tera, KOAMTAC, Honeywell product pricing/specs; Zebra RS5100 HID mode confirmation; official Socket Mobile/Inateck pages; Urovo DT50 price; current (2026) Zebra TC pricing from authorized channel.
- No source verifying that HID input into a Safari/PWA `<input>` is currently reliable on iOS 26 (a 2016 WebKit bug describes garbled input; unclear if fixed).

---

## 4. Guided picking screen patterns from leading mobile WMS apps

### Takeaway
Leading apps converge on: list/card of next item sorted by bin location, scan item barcode (or tap) to confirm, optional enforced location scan, tote scan for multi-order batches (items from the same order auto-routed to the same tote), a progress control (orders in batch, totes used, items remaining), and a "Report Issue/Skip/Short" path that either holds the order or short-ships the line.

### Cited Findings
- ShipHero iOS app: picking styles Single Item Batch, Multi-Item Batch, Single Order. Multi-Item Batch: enter number of totes; for each item scan/select a tote; items from same order go to same tote; confirm each pick by scanning the barcode or tapping; lower corners show batch and remaining-item counts; "Progress" shows batch totals, totes in use, remaining items; "Report Issue" lets picker add notes and optionally put the order on operator hold (removed from batch); tap Complete when done. Single Item Batch: scan/select an empty tote, confirm quantity per product, shows orders-in-batch and items-remaining. — [ShipHero iOS app guide](https://software-help.shiphero.com/hc/en-us/articles/8497107616269-User-Guide-to-the-ShipHero-iOS-Mobile-App)
- ShipHero Mobile Picking Interface (Beta): optional/enforced location-scan step ensures picking from the correct bin; flow is go to location, scan item, scan tote, place, re-scan tote to confirm placement; error pop-ups for tote already in use or wrong item; training video says item scanning is best practice when barcode missing/not barcoded. — [ShipHero help](https://software-help.shiphero.com/hc/en-us/articles/40363495768077), [ShipHero multi-item batch video](https://shiphero.com/videos/multi-item-batch-picking)
- ShipHero Single Order mode: scan items, tap Pack, choose box (weight auto-populates or "Get From Scale"), optional rate quote, Print Packing Slip and Label; Single Item Batches cannot be shipped from the mobile app; Multi-Item Batches are shipped by scanning the tote barcode from All Orders. — [ShipHero iOS app guide](https://software-help.shiphero.com/hc/en-us/articles/8497107616269-User-Guide-to-the-ShipHero-iOS-Mobile-App)
- Veeqo: batch default 10 orders / max 20 items; items presented in ascending bin-location order; scan barcode with phone camera (camera icon) or tap to confirm; list vs card view (card recommended once shelf locations exist); methods Single Tote, Pick to Order, "Most Efficient" (Pick to Pile chosen when >50% of batch is single-line orders); "batch complete" screen; at pack station scan tote barcode to retrieve all batch orders (single tote) or the single order (pick-to-order); totes freed on dispatch. Digital picking described as Android + Veeqo scanners, batch picking Android/Premium only. — [Veeqo digital picking overview](https://help.veeqo.com/en/articles/8306650-digital-picking-overview), [Veeqo mobile app](https://www.veeqo.com/features/mobile-app)
- Logiwa: pick-to-location shows SKU, pick quantity and pick-from location after scanning location or LPN; help center has separate mobile articles "Skip during Picking", "Report Missing Items When Picking", and "Retain Allocation During Missing (Pick Short)" (titles only; contents not read). — [Logiwa pick to location](https://intercom.help/mylogiwa/en/articles/7033169-pick-to-location), [Logiwa picking collection](https://intercom.help/mylogiwa/en/collections/3854953-picking)
- Seko WMS mobile wave picking: skipping a line prompts confirmation and the line is short-shipped via a "Short Ship" button. fulfillmenttools: marking an item unavailable triggers an alternative-location check and redirects the picker; if none, recorded as short-pick with a capturable reason. Oracle mobile pick confirm: partial pick then split, short pick or backorder remainder. — [Seko](https://seko.atlassian.net/wiki/x/hBF0qQ), [fulfillmenttools](https://docs.fulfillmenttools.com/documentation/apps/store-operations-app-beta/beta-picking-android-app), [Oracle pick confirm](https://docs.oracle.com/en/cloud/saas/supply-chain-and-manufacturing/26a/famml/pick-confirm.html)
- NIMMSTA documents a "Picking Item and Location Verified" flowchart (both location and item scan required). — [NIMMSTA](https://docs.nimmsta.com/standardpovflowcharts/4.%20Picking%20Item%20And%20Location%20Verified.html)

### Inferences
- Screen content consensus for the "next pick" card: big location (aisle-shelf-bin) as the hero, product image + name + SKU variant, quantity as a large number with +/- only when qty > 1, tote-slot letter/number chip, progress ("3 of 12"), and a persistent but visually quiet "Can't find / Skip" action. This fits the owner's no-captions rule: use iconography, color state changes and haptic/audio instead of explanatory text.
- Recommended confirmation model for a small, one-warehouse brand: scan location (optional toggle, default on for similar-looking glass SKUs) then scan item; qty > 1 either scan each unit or tap-to-set quantity after first scan; wrong scan = red flash + double buzz + no state change.
- Exception model synthesizing the sources: (1) Skip = move line to end of route (re-route), (2) Not found/short = reason chips (empty bin, damaged, wrong item in bin) creating a cycle-count task for that location and short-pick (or hold order, ShipHero style), (3) Damaged = decrement and flag. Source coverage is thin (titles only for Logiwa); define states yourself.
- Do not assume multi-tote slot assignment is needed at 2-5 staff; ShipHero/Veeqo-style "pick to order" with tote scan at pack station is the simplest handoff.

### Gaps
- No documentation found for Packiyo, Deposco, SkuVault, Hopstack, Easy WMS, Peoplevox, Zoho Inventory mobile, or Shopify/Stocky picking flows.
- Logiwa skip/missing/short-pick article contents not read; ShipHero's skip/short-pick behavior not documented in the pages found (only Report Issue/hold).
- No sourced guidance on quantity-entry UX for multi-qty (Veeqo article silent).

---

## 5. Packing station patterns (scan tote, verify, box, weigh, label, mark packed; cartonization)

### Takeaway
ShipStation's Scan to Verify already defines the verification contract: scan packing-slip barcode/order number, then scan each product UPC/SKU; order is marked Verified only when all items scan. Weight via USB scale needs ShipStation Connect on a workstation; browsers on phones cannot talk to USB scales, so the pack station should be a desktop/tablet-with-PC running a print bridge (PrintNode/QZ Tray/ShipStation Connect).

### Cited Findings
- ShipStation Scan to Verify & Print: scan UPC or SKU barcode of each item; barcode types chosen in Settings > Shipping > Workflow Settings; UPCs stored in product UPC field; does not support multiple UPCs or fulfillment SKUs per product; Scan tab: scan packing slip barcode or enter order number, scan each product or use Verify / Verify All, Mark as Verified; audio and visual feedback on item scan; "Verify" workflow alone marks Verified and has no label step; not for inventory management; for out-of-stock items create separate shipments; new layout only. Community: partial verification state not saved unless all items verified. — [ShipStation help (via search snippets)](https://help.shipstation.com/hc/en-us/articles/360031021831-Verify-Print-Shipments-with-Barcode-Scan), [ShipStation community](https://community.shipstation.com/t5/Strategies-Workflows/Scan-to-Verify-Workflow-needs-improvement/m-p/21006)
- ShipStation supports most HID-compliant USB scales connected directly to the workstation via ShipStation Connect (per third-party quoting ShipStation docs; ShipStation hardware guide says install Connect on any workstation attached to shipping hardware). — [vMeasure summary](https://vmeasure.ai/is-shipstations-scale-integration-reliable-for-accurate-weight-capture/), [Spartan POS ShipStation hardware guide](https://spartanpos.com/pages/shipstation-hardware-guide-printers-scanners-scales-labels)
- WebHID/WebUSB for scales: WebHID desktop Chrome/Edge 89+; Android WebHID planned in Chrome 157; iOS cannot connect USB/serial/HID. — [blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/aEsVkIFFYPE/m/KcxvyOIcBQAJ), [Chrome Help](https://support.google.com/chrome/answer/12576972?hl=ja)
- PrintNode: plans count computers running the PrintNode Client (Windows/macOS/Linux incl. Raspberry Pi; phones/tablets not supported); Lite free (50 prints/mo, 1 computer), Essential $9/mo (5,000 prints, 3 computers), Standard $29/mo (25,000, 5 computers), Premium $99/mo; one-month free trial; each print request counts as one regardless of pages; USD page also describes scale support via USB (per AlternativeTo). — [PrintNode pricing](https://www.printnode.com/en/pricing), [AlternativeTo](https://alternativeto.net/software/printix/)
- QZ Tray: core free; paid support tiers enable silent printing without prompts; Premium Support USD 749 (qz.io) vs USD 599 (buy.qz.io; multi-year USD 449/yr) — conflicting; supports ZPL/EPL/PDF/PNG/ESC-POS from the browser; must be installed on the PC attached to the printer. — [qz.io](https://qz.io/), [QZ store Premium Support](https://buy.qz.io/Premium-Support-_p_13.html)
- ShipHero pack flow: choose shipping box, weight auto-populates or Get From Scale, then print packing slip and label. Veeqo pack: scan tote retrieves orders for label purchase. — [ShipHero iOS guide](https://software-help.shiphero.com/hc/en-us/articles/8497107616269-User-Guide-to-the-ShipHero-iOS-Mobile-App), [Veeqo digital picking](https://help.veeqo.com/en/articles/8306650-digital-picking-overview)
- Printers: Zebra ZD421 USD 370-500 (Walmart) to USD 652 (CDW.ca); Rollo X1040 about USD 200; third-party label stock USD 0.03-0.06 per label vs USD 0.09-0.12 name-brand (affiliate blog). — [Walmart Zebra](https://www.walmart.com/c/kp/barcode-zebra), [CDW.ca ZD421](https://www.cdw.ca/product/zebra-zd421d-label-printer-b-w-direct-thermal/6439301), [shippinglabel.co](https://shippinglabel.co/blog/best-thermal-label-printer-shipping)

### Inferences
- Simplest compliant design: keep ShipStation as label/rate/tracking authority; ERP pack screen on a desk tablet/PC does scan-tote -> order -> per-item scan verify (mirror ShipStation rules: mismatch = hard block, all items required, qty counted per scan) -> box suggestion -> weight from a USB scale via ShipStation Connect (or WebHID on desktop Chrome) -> label printed by ShipStation Connect/PrintNode/QZ Tray -> mark packed. Avoid duplicating both ShipStation Scan to Verify and ERP verification: choose the ERP as verifier and ship via ShipStation API, or let ShipStation verify and ERP only reflect status. Decide ownership explicitly.
- Cartonization at this scale: rule-based (product dimensions/weight x qty -> smallest box from a short list; glass fragile items add void-fill/protection flag) rather than 3D bin-packing; no source found supporting a specific algorithm.
- PrintNode Essential ($9/mo) or Lite likely sufficient (1-3 stations); QZ Tray's cost is hard to justify unless you need local printing without a cloud service. Phones cannot run PrintNode client, so pick/pack labels happen at the station PC.

### Gaps
- Official ShipStation help text was blocked (HTTP 403 on direct fetch); details above come from search-engine summaries of that page. Re-verify steps, partial-verify behavior and scale support list on ShipStation directly.
- No sourced cartonization algorithm/best-practice material; no ShipStation Connect supported-scale list; no source on Bluetooth scale integration from a browser.
- Dymo label printer details not found.

---

## 6. Feedback and ergonomics (audio/haptic, touch targets, lighting, gloves, offline, battery, mounting)

### Takeaway
Haptics are unreliable on iOS (no Vibration API; a hidden `<input type=checkbox switch>` trick worked on iOS 17.4-26.4 but a single source says it was patched in 26.5), so audio plus strong visual state changes must be the primary confirmation channel. Supabase Realtime silently drops when backgrounded.

### Cited Findings
- Safari/iOS has no Vibration API; `navigator.vibrate` may exist but returns false; workaround is Safari 17.4+ `<input type="checkbox" switch>` with programmatic label click; WebHaptics library falls back to this; one tester site says it works iOS 17.4-26.4 and was patched in 26.5 (single source). — [Mintlify WebHaptics browser support](https://www.mintlify.com/lochie/web-haptics/advanced/browser-support), [azukiazusa.dev](https://azukiazusa.dev/en/blog/ios-safari-web-haptics), [iOS Haptics Tester](https://rapidtoolset.com/en/tool/ios-haptics-tester)
- ShipStation Scan to Verify gives audio and visual feedback on item scans (reference behavior). — [ShipStation help](https://help.shipstation.com/hc/en-us/articles/360031021831-Verify-Print-Shipments-with-Barcode-Scan)
- Screen Wake Lock works for installed iOS PWAs since 18.4. — [firt.dev](https://firt.dev/notes/pwa-ios/)
- Realtime reconnect guidance (worker heartbeat, heartbeatCallback, refetch on visibility). — [Supabase](https://supabase.com/docs/guides/troubleshooting/realtime-handling-silent-disconnections-in-backgrounded-applications-592794)
- ProGlove claims wearable scanners save up to ~4 s per scan (retailer claim). — [Motion Miners listing](https://mpi.motionminers.com/en/offerings/proglove-mark-basic-mr-wearable-scanner)

### Inferences
- Audio: Web Audio needs a user gesture to unlock on iOS; unlock on the first tap ("Start picking"), then play distinct short tones for success / wrong item / wrong location / done. Use `navigator.vibrate` on Android, optional switch-hack on iOS with feature detection and no reliance.
- Touch/ergonomics (general UX practice; no source retrieved): >= 56-64 px primary targets, bottom-anchored primary action for one-hand thumb reach, high-contrast dark theme (OLED) for dim warehouse, avoid swipe gestures that fail with gloves, full-screen color flash (green/red) as the main status signal consistent with "no captions".
- Offline: IndexedDB outbox of pick events with idempotent client-generated UUIDs, optimistic local state, replay on reconnect; show a single small connectivity dot rather than text; make pick-confirm server round-trip idempotent. Because Realtime doesn't replay missed events, re-fetch assignment on resume.
- Battery: continuous camera decode is the main drain; scan-on-demand (camera only open when the scan screen is active, close after N seconds idle) plus Bluetooth scanner as the default for heavy use; keep screen awake via Wake Lock only on the scan screen. Mounting: lanyard/armband or a phone clip for the one-hand grip; no sourced products.

### Gaps
- No sourced figures on camera-scanning battery drain, glove-compatible touch target standards, or pocket/lanyard mounting products.
- iOS 26.5+ haptic hack status rests on a single tester site.
- Web Audio autoplay/unlock behavior on iOS 26 not sourced.

---

## 7. Voice picking and smart glasses (future options)

### Takeaway
Smart glasses are mature but expensive for a 2-5 person warehouse: RealWear Navigator 520 about USD 3,150 (incl. 1 yr service) and Vuzix M400 about USD 1,800-1,950; voice control is reported to struggle in noise. Not a near-term fit.

### Cited Findings
- RealWear Navigator 520 listed at USD 3,150 including one year of service and support on RealWear's shop (per a comparison page); fleet quotes can differ. — [rfp.wiki RealWear vs Vuzix](https://www.rfp.wiki/specialty-industries/augmented-reality-industrial-operations/realwear/vuzix)
- Vuzix M400 USD 1,799.99, M4000 USD 2,499.99, Z100 USD 499.99 (Vuzix store per comparison page); reseller MSRPs of USD 1,799.99 (Xtreme Kit) and 1,949.99 (Starter Kit). M400 described as suitable for warehouse picking with voice + touchpad; one reviewer says voice struggles in noisy environments and M400 may trail RealWear for heaviest industrial use. — [rfp.wiki Vuzix vs RealWear](https://www.rfp.wiki/specialty-industries/augmented-reality-industrial-operations/vuzix/realwear), [SHI Vuzix M400 Xtreme](https://www.shi.com/product/50041175/Vuzix-M400-Xtreme-Kit)

### Inferences
- Both run Android-based OSes, so a responsive PWA/Chrome page with voice-friendly large text could be reused later; not verified. Dedicated voice-directed picking (headset-based) not researched.

### Gaps
- No sources on Google Glass Enterprise Edition successors, voice-picking vendors (Honeywell Vocollect, Zebra), pricing/maturity of headset voice picking, or web-app compatibility on these devices.
- Comparison-page pricing is from an aggregator (rfp.wiki); not verified against vendor pages or dated 2026.

---

## 8. Label printing for location/tote barcodes (printers, stock, generation)

### Takeaway
Generate Code 128/QR in the browser with `bwip-js` (active, v4.11.4 released 2026-08-19, canvas/SVG output, 100+ symbologies) and print via a Rollo (~USD 200) or Zebra ZD421 (~USD 370-650) using direct thermal label stock; PDF/ZPL printing from the web app needs a print bridge or browser print dialog.

### Cited Findings
- bwip-js 4.11.4 (2026-08-19), BWIPP 2026-05-28; supports Code 128, GS1-128, EAN/UPC, ITF-14, QR, Data Matrix, Aztec, PDF417 etc.; outputs: `toCanvas()` in browser, `toSVG()` everywhere, PNG buffer in Node; ES module imports with per-encoder tree-shaking; width/height in mm at 72 dpi base, scale multiplies; v4.10 changed guard-bar height. — [bwip-js GitHub](https://github.com/metafloor/bwip-js)
- Printer price snapshots: Zebra ZD421 USD 370-500 (Walmart) and USD 652 (CDW.ca); Rollo X1040 about USD 200; third-party labels USD 0.03-0.06 vs name-brand USD 0.09-0.12; DYMO uses proprietary rolls (costlier). — [Walmart](https://www.walmart.com/c/kp/barcode-zebra), [CDW.ca](https://www.cdw.ca/product/zebra-zd421d-label-printer-b-w-direct-thermal/6439301), [shippinglabel.co best thermal printer](https://shippinglabel.co/blog/best-thermal-label-printer-shipping)
- PrintNode/QZ Tray options for silent printing as in Section 5. — [PrintNode](https://www.printnode.com/en/pricing), [qz.io](https://qz.io/)

### Inferences
- Use one label style: large Code 128 plus human-readable text (location code like A-03-2) with a >= 10x module quiet zone for camera readability, QR for tote labels; test printed labels at 203 dpi with the real shelf distance. For location labels, a 4x6 or 2x1 in thermal label stock on shelf edges; consider laminated/polyester labels for durability (not sourced).
- JsBarcode is an alternative but was not researched; bwip-js is the better-documented option here.

### Gaps
- No sourced info on JsBarcode, shelf/bin label stock types (polyester, magnetic, shelf-edge), Dymo model specs, or label-size recommendations.
- Browser-direct printing to Zebra without a bridge (e.g., Zebra Browser Print, WebUSB ZPL) not researched.
