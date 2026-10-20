# Pick-to-Light / Put-to-Light Hardware Drivable from a Custom Cloud ERP (as of Oct 2026)

Scope: Freeze Pipe (2-5 staff, a few hundred SKUs, standard shelving, custom React/Supabase ERP). Research budget was limited (~16 tool calls), so many vendor-specific questions are listed as Gaps rather than answered. Prices are as seen on the cited pages in October 2026 unless noted.

## 1. Commercial pick-to-light vendors: cost, architecture, and API openness

### Takeaway
Of the vendors checked, Voodoo Robotics is the most SMB-friendly and the most openly programmable. It has a published REST API with ack/nack callbacks, battery-powered wireless displays, and a $5,000 starter kit for 10 devices. Banner/Turck PTL110 and K50 modules are sold per unit through distributors (about $186-$280 each) and speak Modbus RTU over RS-485, so a team can drive them directly without vendor WMS middleware, but they need a wired bus and a gateway. Classic wired PTL vendors (Lightning Pick/Matthews, KBS, Aioi) do not publish per-module prices and appear to be integrator-sold.

### Cited Findings
**Voodoo Robotics (Cloud Display Devices)**
- Starter Kit: $5,000 one-time hardware plus an annually renewable cloud license. It includes 10 display devices and 1 Turbo II router, plus REST API integration support. Per-device prices are not published ("We quote per configuration"). — [Voodoo Robotics pricing](https://voodoorobotics.com/pricing/)
- Licensing: the page states "no per-device subscriptions." Production uses a one-time perpetual server license. The cloud license covers up to 50 devices. Expansion tiers run from zone expansion (25-100 devices, 1-2 routers) to full floor (300-1,000+ devices, 5-25 routers). — [Voodoo Robotics pricing](https://voodoorobotics.com/pricing/)
- Hardware and radio: displays run on 2x AAA batteries for "a year or more, often years," and the system emails when a battery runs low. One Turbo reaches about 300 devices at 75-100 ft. Planning assumes about one Turbo per 100 devices, mounted about 8 ft high, with PoE preferred. Voodoo recommends every device be in range of at least two Turbos, so production starts at two. — [Voodoo Robotics pricing](https://voodoorobotics.com/pricing/)
- Server options: a multi-tenant cloud server (pilot) or a dedicated server (cloud-hosted or on-premises). Ready-made connectors exist for Odoo, ShipStation, Extensiv, QuickBooks Online, NetSuite, Oracle WMS, Manhattan, SAP and Epicor. — [Voodoo Robotics pricing](https://voodoorobotics.com/pricing/)
- REST API request: `POST https://www.voodoodevices.com/api/device/DEVICE_ID/` (the trailing slash is required), authenticated with an `API-KEY` header.
  - Device IDs look like `FFFFFF:EEEEEE`.
  - Body fields: `command` (e.g., `flash`), `line1`-`line5`, `barcode`, `arrow`, `quantity` (0-99), `color` (named colors or hex), `seconds` (timeout), and `nonce` (a correlation ID you supply).
  - Source: [Voodoo developer docs](https://developer.voodoorobotics.com/)
- REST API callbacks: Big Block (Voodoo's server) POSTs a callback to your system with `acknack`, `deviceid`, `location`, `nonce` and `qty`. `acknack` is `ack` (worker pressed the button), `nack` (the command expired) or `call` (a long press while idle). No latency or rate-limit figures are published on that page. — [Voodoo developer docs](https://developer.voodoorobotics.com/)
- Leasing: a 2018 trade-press article said the displays were offered on a month-to-month lease, and that the "Mobile Turbo" router connects displays directly to the Internet. This may be outdated, since the 2026 pricing page describes one-time hardware and licenses. — [MMH 2018](https://www.mmh.com/article/voodoo_robotics_releases_mobile_connectivity_device_for_messaging_modules)

**Banner Engineering PTL110 (distributor prices, Oct 2026)**
- PTL110S-T-QP150 (touch, no display): $186 at Powermatic and $196 at DigiKey. — [Powermatic](https://www.powermatic.net/part/banner/ptl110s-t-qp150/1875961)
- PTL110S-FF200LD3-QP150 (3-digit display, 200 mm): $239 at Powermatic and $251 at DigiKey. — [Powermatic](https://www.powermatic.net/part/banner/ptl110s-ff200ld3-qp150/1876012)
- PTL110S-FF100TD3-QP150 (touch plus 3-digit display, 100 mm): $266 at Powermatic. — [Powermatic](https://www.powermatic.net/part/banner/ptl110s-ff100td3-qp150/1875954)
- PTL110S-FF100TD3-QPS150 (5-pin connector variant): $279 at Powermatic. — [Powermatic](https://www.powermatic.net/part/banner/ptl110s-ff100td3-qps150/1875804)
- Protocol: all PTL110 variants use PICK-IQ serial communication, which is compatible with RS-485 / Modbus RTU. Some DigiKey variants showed zero stock at the time of search. — [Powermatic listings](https://www.powermatic.net/part/banner/ptl110s-ff200td3-qp150/1876307); [DigiKey video page](https://www.digikey.com/en/videos/b/banner-engineering/banner-ptl110-series-of-scalable-versatile-picktolight-devices)

**Turck (sister brand to Banner, sold in the Turck shop)**
- K50TGRYS1QP pick-to-light placement sensor, Modbus RTU: list price about €206.70-€220.40 (it differs between shop pages). — [Turck shop](https://www.turck.com/de/en/shop/lighting-and-indicators/pick-to-light/3095447)
- PTL110S-series units: about €173.90-€202.30 list, Modbus RTU, 14 colors. — [Turck shop](https://shop.turck.de/en/lighting-and-indicators/pick-to-light/3807535)
- Banner K50 Pro and S22 Pro indicators support Modbus control of full color and animations over RS-485. — [Banner K50 Pro literature](https://info.bannerengineering.com/cs/groups/public/documents/literature/253620.pdf)

**Lightning Pick (Matthews Automation Solutions)**
- Part of Matthews Automation Solutions, with about 500 installations. Its modules use a "twin-wire" design that needs no interconnecting cable, which the vendor says cuts surface-mount installation cost on existing racks. — [Lightning Pick](https://lightningpick.com/?p=3726)
- A "LightningPick PLC Bridge" product exists. It is distributed via Cisco-Eagle, which points to integrator and distributor sales. — [Cisco-Eagle PDF](https://www.cisco-eagle.com/uploads/PickLight/LightningPick-PLC-Bridge.pdf)

**Market-level per-bin estimates (marketing source; treat cautiously)**
- ekko GmbH (German vendor, dated 23 Sep 2026) puts hardware at €10-250 per compartment. Wired infrastructure adds €50-150 per compartment (its FAQ says €25-150, which is inconsistent). For systems of several hundred compartments, electrical work is 30-50% of total investment. Wireless needs about one gateway per 1,000 m². — [ekko](https://www.ekko.io/en/wissen/pick-to-light-cost)
- ekko's 200-bin example:
  - Wireless: about €8,000 (200 modules at €15, plus €5k for gateways and commissioning).
  - Wired: about €55,000 (200 modules at €150, €20k installation, €5k controllers).
  - Custom integrations "can quickly cost a five-figure sum."
  - Source: [ekko](https://www.ekko.io/en/wissen/pick-to-light-cost)
- Conflict: an earlier search snippet of the same ekko page said €80-250 per bin, but the fetched page says €10-250. — [ekko](https://www.ekko.io/en/wissen/pick-to-light-cost)
- Other cost guides found ("pick to light cost guide 2026" pages on unrelated domains) looked like low-quality SEO content and were not used. — [example](https://new.risingsunartscentre.org/news/pick-to-light-system-cost-guide-2026.html)

### Inferences
- Voodoo is the only vendor found that matches "buy hardware, write our own software" out of the box. The ERP calls a cloud REST endpoint and receives HTTP callbacks, so no on-site bridge is strictly needed beyond the Turbo routers.
- The starter kit works out to about $500 per location all-in, which suits a pack-wall pilot (10 cubbies) more than a few hundred bins.
- Voodoo callbacks land on a public HTTP endpoint, and a Supabase Edge Function could serve as that receiver.
- Banner/Turck PTL110 at about $190-$280 per position plus RS-485 cabling, 24 V power and a Modbus gateway costs more than $25k for 100 bins in hardware alone. They are robust industrial parts, but overkill for 2-5 staff.
- Banner/Turck modules can still be driven by any software that speaks Modbus RTU, for example a Raspberry Pi with a USB-RS485 adapter running a Modbus library, so there is no WMS lock-in.

### Gaps
- Not researched (call budget): KBS Industrieelektronik, Aioi Systems, Atop, Hanel, Kardex, ProGlove MARK Display, Pick-to-Light Systems (Spain), Panasonic, Lumi. This covers their per-position costs, bus architecture, API openness and SMB availability. A search for an "Atop" pick-to-light Modbus TCP product returned nothing relevant.
- Voodoo per-device price beyond the starter kit, annual cloud license price, and end-to-end latency (cloud to Turbo to device): not published.
- Banner gateway options (e.g., DXM controllers) and their prices: not found in this pass.

## 2. Electronic shelf labels (ESL) as pick-to-light

### Takeaway
Major ESL makers (SoluM, Minew/MinewTag, Delfi as a reseller) market LED-flash labels for pick-by-light. Public, self-serve API documentation for triggering LED flashes was not found for SoluM AIMS, Vusion or Hanshow; Minew claims MQTT/HTTP APIs. The open-source OpenEPaperLink firmware does support LED flash commands on tags that have an LED. However, commands are delivered only at the tag's next check-in, about 40+ seconds, which makes it unsuitable for real-time pick guidance.

### Cited Findings
**Commercial ESLs**
- SoluM labels offer seven LED colors that flash, and Pick-by-Light is listed among supported processes. Its digital-picking page describes pick-to-light, batch picking and pack-to-light, with LED color and pattern signaling priority. — [SoluM distribution center](https://www.solum-group.com/distribution-center); [SoluM digital picking](https://www.solum-group.com/us/en/esl-n-iot/industrial-solution/digital-picking)
- The free SoluM "AIMS Manager" iPad app includes a "Blink LED" function. The listing does not say whether this is exposed via a public API. — [App Store](https://apps.apple.com/app/id1602506132)
- SoluM partnered with Logistic Lights to pair ePaper ESLs with mobile pick-by-light modules (LEDs plus confirm buttons) for picking trolleys. — [materialfluss.de](https://www.materialfluss.de/warehouse--picking-technology/logistic-lights-announces-partnership-with-epaper-esl-manufacturer-solum.htm)
- MinewTag sells warehouse picking labels with three-color LEDs, plus an API layer for ERP integration over MQTT and HTTP/HTTPS. — [MinewTag smart warehouse](https://www.minewtag.com/smart-warehouse.html); [MinewTag pick-by-light](https://www.minewtag.com/newsinfo445.html)
- Delfi (ESL integrator) describes an LED "Flash" workflow: scan an item, trigger the flash from an app, then find the flashing label. — [Delfi](https://www.delfi.com/solutions/flash)
- Aioi Systems is listed as an E Ink business partner, which fits its e-paper picking displays. — [E Ink partner page](https://www.eink.com/partner/detail/AIOI)

**OpenEPaperLink (open source)**
- OpenEPaperLink is alternative firmware and protocol for ESLs, with access-point firmware and tag firmware. The access point is an ESP32 paired with a tag acting as an 802.15.4 radio. Mini AP designs exist, and segmented SoluM tags reportedly work. — [OpenEPaperLink GitHub](https://github.com/OpenEPaperLink/OpenEPaperLink)
- Tags check in every 40+ seconds, and the project cites a "minimum of 40 second latency." — [OpenEPaperLink GitHub](https://github.com/OpenEPaperLink/OpenEPaperLink)
- The OpenEPaperLink Homey integration can set a tag's LED color, flashes per burst, time between bursts and flash duration (in minutes). This works only on tag types with an 'led' option, and the LED command reaches the tag at its next check-in. — [Homey app](https://homey.app/en-md/app/nl.wiggert.OpenEPaperLink/)
- A ready-made "OpenEPaperLink Mini AP v3" (Zigbee/WiFi gateway) is sold on Tindie. — [Tindie](https://www.tindie.com/products/electronics-by-nic/openepaperlink-mini-ap-v3-zigbee-wifi-gateway/)

### Inferences
- Commercial ESLs are likely sold through integrators with gateway plus software licensing (SoluM AIMS, Vusion Cloud). Since no public self-serve API docs or US small-quantity pricing turned up, ESLs should not be the first-choice path for an SMB that wants to write its own driver.
- OpenEPaperLink tags fit well as static bin labels (SKU, name, location barcode, refreshed when slotting changes). The 40 s+ latency rules them out as the "light up now" signal.
- A hybrid is plausible: e-paper labels for identification, plus an LED strip or a Voodoo device for the real-time cue.

### Gaps
- Per-label and gateway prices, MOQs, LED-flash latency, and API terms for VusionGroup/SES-imagotag, Hanshow, SoluM, Pricer, Zhsunyco and Opticon were not found.
- Whether used or surplus Hanshow/SoluM tags sold on eBay/AliExpress have LEDs that OpenEPaperLink can drive (per tag model) needs checking on the OpenEPaperLink wiki.

## 3. DIY route: ESP32 + addressable LEDs (WLED or custom firmware)

### Takeaway
WLED on an ESP32 exposes a documented JSON/HTTP API that can set arbitrary individual LEDs (by index or range) within a segment. That is exactly the "light bin N" primitive, so a team that writes software can drive shelf-edge strips with no custom firmware. Practical limits: send per-LED calls sequentially rather than in parallel, keep payloads under about 24 KB on ESP32, and expect WiFi reliability to dominate overall robustness. No published DIY warehouse pick-to-light build was found in this pass.

### Cited Findings
- Individual LED control syntax:
  - Sequential: `{"seg":{"i":["FF0000","00FF00","0000FF"]}}`
  - Specific indices: `{"seg":{"i":[0,"FF0000",2,"00FF00"]}}`
  - Ranges (start inclusive, stop exclusive): `{"seg":{"i":[0,8,"FF0000",10,18,"0000FF"]}}`
  - Source: [WLED JSON API](https://kno.wled.ge/interfaces/json-api/)
- Individual LED state is non-persistent. The segment is frozen while individual control is active and returns to effect mode if the light turns off. Brightness and on-state must be set in a separate, earlier request: "turning on the LEDs and setting individual LEDs in the same request will not work." — [WLED JSON API](https://kno.wled.ge/interfaces/json-api/)
- Indices are relative to the segment. The maximum segment count is reported in `info.leds.maxseg`, and the LED count range is documented as 1-1200 (`info.leds.count`). — [WLED JSON API](https://kno.wled.ge/interfaces/json-api/)
- Rate and size limits: do not send individual-LED calls in parallel; wait for each to finish. Split large updates into about 256-color chunks and use hex strings if the buffer would exceed about 10 KB (ESP8266) or about 24 KB (ESP32). — [WLED JSON API](https://kno.wled.ge/interfaces/json-api/)
- Realtime modes (UDP, DDP, E1.31/Art-Net) are documented separately. Realtime mode blanks LEDs and persists until state changes, and clients should send `{"live":false}` when done. MQTT is also supported (separate page). — [WLED JSON API](https://kno.wled.ge/interfaces/json-api/)
- The ESP32 is preferred over the ESP8266 for WLED because of dual cores, more GPIO and more RAM. — [Zbotic](https://zbotic.in/wled-smart-light-strip-esp32-rgb-controller-complete-setup/)
- WLED integrates with Home Assistant and can sync multiple controllers. — [CircuitDigest](https://circuitdigest.com/tutorial/diy-esp32-wled-controller); [raspberry.tips](https://raspberry.tips/?p=9145)
- Off-the-shelf "WLED ESP32 controller" boxes for WS2812/SK6812 are sold as finished retail products, so no soldering of the controller is needed. — [Fruugo listing](https://www.fruugo.ca/wled-esp32-led-controller-for-ws2812-sk6812-multiled-rgb-strip-compact-black-io33-output/p-449418720)

### Inferences
- Map each bin to `(controller_id, segment, led_start, led_end)`. Lighting a pick is then one HTTP POST, or one MQTT publish via WLED's MQTT API, per controller.
- Sending several LEDs per bin (e.g., a 3-6 LED range) is more visible than a single pixel and tolerates strip-cut misalignment.
- Rough cost per 100 bins (unsourced estimate; verify): one ESP32 controller per shelving bay, a 5 V or 12 V supply, 60 LED/m strip, aluminum diffuser channel and wiring. Budget a few hundred to roughly $1,000 for 100 bins, an order of magnitude below Banner/Voodoo per-position pricing.
- The labor of cutting and mounting strips and power injection is the real cost.
- Using the phone scan as the confirmation (light-to-locate, scan-to-confirm) avoids per-bin buttons entirely. This fits the planned mobile pick module.
- WiFi on 2.4 GHz ESP32s in a metal-racked warehouse is the main reliability risk. An ESP32 board with Ethernet (or PoE) per bay, or an Ethernet-attached controller, reduces this.

### Gaps
- No GitHub/Hackaday/YouTube DIY warehouse pick-to-light build was located in this pass (a search for "WLED pick to light warehouse" returned only general WLED tutorials).
- Current 2026 prices for WS2812B/SK6812 strip, ESP32 Ethernet/PoE boards, power supplies and aluminum channel were not collected.
- No measured WLED HTTP/MQTT command-to-light latency figures were found.

## 4. Smart buttons, indicators and consumer-IoT hacks (Shelly, Zigbee, LoRa, BLE, Philips Hue)

### Takeaway
Not researched in this pass. No sourced findings.

### Cited Findings
- None collected.

### Inferences
- (General knowledge, unverified here) Consumer smart lights such as Hue are designed for room lighting, are expensive per point, and are bulky for bin-level use. They are a weak fit beyond a novelty demo.

### Gaps
- Latency and limits of the Hue bridge API, Shelly/Zigbee button options, and LoRa/BLE indicator options were not researched (call budget).

## 5. Put-to-light / pack wall and cart-based alternatives

### Takeaway
Put-to-light is mainly an order-consolidation tool, where a light tells the operator which cubby receives each item. Lights mounted on a picking cart (per tote slot) are a recognized, cheaper middle ground for batch / multi-order picking because they light a handful of tote positions instead of every shelf bin. For Freeze Pipe, a 10-30-position cart or pack wall is the natural first lighting project. Voodoo's 10-device starter kit or a single WLED strip fits it.

### Cited Findings
- In order-consolidation (put-to-light) setups, lights tell the operator which cubby to "put" each item into. — [MMH "Pick-to-light's evolution"](https://www.mmh.com/article/pick_to_lights_evolution)
- Current developments include wireless display modules, lights that illuminate an entire compartment, and mobile carts with lights. — [MMH](https://www.mmh.com/article/pick_to_lights_evolution/features)
- Pick-to-cart light modules on carts/totes are best for batch picking and multi-order fulfillment, letting one picker work several orders in one pass. — [Racklify](https://racklify.com/encyclopedia/types-of-pick-to-light-systems-and-when-to-use-them/)
- Light systems suit the highest-velocity SKUs, and the article cites 350-400 lines/hour average pick rates. An automation consultant recommends analyzing order volume profile and SKU velocity before buying. — [MMH](https://www.mmh.com/article/pick_to_lights_evolution)
- The SoluM / Logistic Lights partnership targets mobile pick-by-light modules with confirm buttons for picking trolleys. — [materialfluss.de](https://www.materialfluss.de/warehouse--picking-technology/logistic-lights-announces-partnership-with-epaper-esl-manufacturer-solum.htm)

### Inferences
- Cart lights need only N tote slots (e.g., 6-12), are battery- or power-bank-powered, and move with the picker. Picking still uses phone guidance for bin location while the cart light shows which tote gets the item. This captures much of the batch-picking accuracy benefit at small cost.
- A static pack wall can be wired (USB-powered ESP32 plus strip) since it never moves, which makes it the most reliable DIY target.

### Gaps
- No prices for commercial pick-to-cart kits, and no small-site cart case studies, were found.
- Vision/AR picking alternatives (smart glasses, camera-verified picking) were not researched.

## 6. Software architecture: cloud ERP (Supabase) to on-site lights

### Takeaway
Two viable patterns emerged.
- **Vendor-cloud pattern (Voodoo):** the ERP POSTs to a REST API and receives ack/nack callbacks keyed by a nonce, so no on-site software is needed.
- **Self-hosted pattern (WLED/Modbus):** a small on-site bridge (Raspberry Pi or mini PC) subscribes to the ERP's realtime stream and fans commands out to LAN devices (HTTP/MQTT to WLED, Modbus RTU to Banner/Turck). It reports device health back.

Either way, the phone scan should remain the source of truth so lights are an accelerator, never a dependency.

### Cited Findings
- The Voodoo command/ack model: a per-command `nonce` for correlation, a `seconds` timeout producing a `nack` callback if not acknowledged, and an `ack` callback with `qty` on button press. — [Voodoo developer docs](https://developer.voodoorobotics.com/)
- Voodoo warns to treat the API key like a password and keep it out of browser-side code. — [Voodoo developer docs](https://developer.voodoorobotics.com/)
- WLED requires sequential (not parallel) individual-LED requests, and on-state/brightness must be set before per-LED colors. The bridge should therefore serialize commands per controller. — [WLED JSON API](https://kno.wled.ge/interfaces/json-api/)
- Banner/Turck PTL devices are Modbus RTU over RS-485, which implies a wired serial master (gateway or PC adapter) on site. — [Powermatic](https://www.powermatic.net/part/banner/ptl110s-t-qp150/1875961); [Turck shop](https://shop.turck.de/en/lighting-and-indicators/pick-to-light/3807535)

### Inferences (design proposal; not sourced)
- Data model:
  - `light_devices`: id, type (wled|voodoo|modbus), address, last_seen_at, firmware.
  - `light_locations`: location_id to device_id, segment, led_start, led_end, or a Voodoo device id.
  - `light_commands`: id/nonce, location, color, picker_id, status (queued, sent, lit, acked, expired, failed), and timestamps.
- Flow for Voodoo: an ERP RPC inserts a `light_commands` row. A database trigger or Edge Function calls the Voodoo REST API server-side with the API key in Supabase secrets. Voodoo's callback hits an Edge Function that updates the row by nonce.
- Flow for WLED/Modbus: an on-site bridge (Node or Deno service on a Pi) holds a Supabase Realtime subscription (or polls an RPC as fallback) on `light_commands`. It publishes to a local Mosquitto broker or calls WLED HTTP directly. It serializes per controller, writes `sent`/`lit` status back, and posts a heartbeat row every N seconds. The ERP marks the bridge or devices offline when the heartbeat is stale.
- Assign each concurrent picker a color (e.g., picker A green, picker B blue) and show that color on the phone too. If two pickers need the same bin, alternate or split the LED range.
- Fallback: if the bridge heartbeat is stale or a command is not `lit` within a few seconds, the phone UI simply continues with text/map guidance. No pick should ever block on a light.
- Security: put LED controllers on an isolated VLAN or SSID with no inbound internet access. The bridge makes only outbound connections to Supabase using a scoped service credential, and the WLED web UI should be password/PIN-protected.

### Gaps
- No sourced measurements of end-to-end latency for Supabase Realtime to a LAN bridge to WLED, or for the Voodoo cloud to device, were found.

## 7. Evidence on pick-to-light benefits, and when it is not worth it

### Takeaway
The published evidence is mostly vendor case studies from large operations. They show dramatic accuracy gains (e.g., 0.32% errors to 0.0013%) and pick rates roughly doubling (171 to 350 lines/hour). Sources consistently say PTL suits a relatively small number of high-velocity SKUs. No sourced break-even threshold for small warehouses was found, so for a 2-5 person shop with a few hundred SKUs the ROI hinges on current error cost and pick density.

### Cited Findings
- A fashion accessories distributor (MHI case study, vendor-supplied):
  - Errors: 0.32% to 0.0013%.
  - Pick rate: 171 to 350 lines/hour.
  - Source: [MHI case study PDF](https://og.mhi.org/downloads/industrygroups/solutions-community/casestudies/retail---pick-to-light.pdf)
- Delta Galil (large apparel distributor):
  - Before: about 97% paper-pick accuracy, with every order audited.
  - After: more than 4,000 picks per associate at 99.95% accuracy, with fewer than 7% of orders audited.
  - Payback: about 13 months.
  - Source: [MHL News](https://www.mhlnews.com/technology-automation/article/22039615/picking-up-the-piecessmartly)
- PTL works best in warehouses with a relatively small number of high-volume products. — [TechTarget](https://www.techtarget.com/searcherp/definition/pick-to-light)
- ekko claims "up to one-third time savings" vs paper (studies unnamed) and a 15-16 month payback for a 200-bin example. Its own numbers (about €8k upfront vs about €4k/month savings) are internally inconsistent with that payback. The example assumes four employees at 300 picks/day each, with the error rate dropping from 0.3% to near zero. — [ekko](https://www.ekko.io/en/wissen/pick-to-light-cost)

### Inferences
- With a planned mobile scan-to-confirm pick module, most of the accuracy gain (wrong-item errors) is already captured by barcode verification. Lights mainly add search-time reduction.
- Search-time reduction matters less when 2-5 staff know a few hundred SKUs well, and more for new or seasonal staff and batch-sort walls.
- This argues for lighting the put-wall or cart first, where it removes the "which tote?" decision, rather than lighting every shelf bin.

### Gaps
- No sourced quantitative threshold (orders/day, lines/hour, SKU count) below which PTL is not worthwhile.
- No small-warehouse (fewer than 10 staff) PTL case studies were found.
