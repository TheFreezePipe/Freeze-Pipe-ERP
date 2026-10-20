# Barcode translation layer precedents (scanner -> lookup/transform -> keystrokes into focused app)

Research date: 2026-10-19. Target use: bench laptop running ShipStation web app; packer scans permanent tote barcode; helper looks tote up in custom ERP over HTTPS and types `^#^<hex>^` + Enter; all other scans pass through. Tool budget was exhausted before every sub-question could be covered; unverified items are marked **[UNVERIFIED]** and listed under Gaps. Two TEC-IT PDFs (TWedge3 manual, TWedge datasheet) were fetched but returned as compressed binary and could not be read, so TWedge's script API (exact function names, HTTP call syntax) is NOT verified.

## 1. TEC-IT TWedge (Windows software keyboard wedge)

### Takeaway
TWedge is the closest off-the-shelf match: Windows-only, takes input from USB HID scanners, serial/virtual COM, Bluetooth and TCP, runs per-scan JavaScript (reported as Chrome V8) with ODBC and a listed "HTTP requests" feature, and injects keystrokes into arbitrary applications. It is priced as an annual subscription from about $272 per device. The exact scripting API for an HTTPS GET and for "type this string then Enter" is not verified, and I found no published lookup-then-type case study.

### Cited Findings
- Product is "Data Acquisition Software for Windows"; the page does not mention Linux/macOS. — [TEC-IT TWedge overview](https://www.tec-it.com/en/software/data-acquisition/tbarcode-twedge/overview/Default.aspx)
- Interfaces listed: "Serial ports (RS232, RS485, virtual COM)", "USB (HID keyboard profile)", "Bluetooth (master and slave)", "TCP (client and server)" (and UDP). — [TEC-IT TWedge](https://tec-it.com/twedge)
- Scripting: the JavaScript engine "provides functions for database operations"; "Direct ODBC database access with SQL commands"; hotkey and timer functions can be scripted. A search-result summary of TEC-IT's page says the JavaScript is based on the Chrome V8 engine with Eclipse debugger support (second-hand, not read directly). — [TEC-IT TWedge](https://tec-it.com/twedge)
- Datasheet wording (via search snippet): the integrated JavaScript "provides functions for keystroke simulation, database and file operations, hotkeys, timers, user interaction, application control and more." — [TWedge datasheet EN](https://www.tec-it.com/download/pdf/Sheets/TWedge_EN.pdf) (PDF unreadable by my fetcher; quoted from search snippet)
- Output: "received data is converted into virtual keystrokes and injected into arbitrary applications"; function and control keys are supported. — [TEC-IT TWedge](https://tec-it.com/twedge)
- "HTTP requests" is listed as a delivery method, with no further detail on that page (no mention of REST/web services). — [TEC-IT TWedge](https://tec-it.com/twedge)
- Pricing (annual subscriptions, auto-renew for 12 months unless cancelled 3 months before expiry): TWedge EUR 219 / $272 (1 device); TWedge Pro EUR 259 / $322 (3 devices); Datacenter 5 EUR 299 / $372; Datacenter 25 EUR 699 / $869. — [TEC-IT TWedge](https://tec-it.com/twedge)
- Resource note: at least 25 MB RAM per managed device, more for complex scripts (search-snippet summary of TEC-IT text). — [TEC-IT TWedge overview](https://www.tec-it.com/en/software/data-acquisition/tbarcode-twedge/overview/Default.aspx)
- A competitor (AggSoft) comparison page says basic templates cover standard tasks but advanced filtering needs JavaScript; treat as biased third-party. — [AggSoft comparison](https://www.aggsoft.com/serial-data-logger/twedge-serial-data-logger-comparison.htm)

### Inferences
- TWedge reads HID-keyboard scanners through its own HID keyboard profile, but I did not verify how it stops the raw scan also being typed into the focused app. The safer design is to put the scanner in CDC/serial mode so only the helper sees the raw scan. This is a design inference, not a documented TWedge recommendation.
- The lookup-then-type pattern (scan -> ODBC/HTTP -> keystroke) is within TWedge's advertised feature set. Whether the HTTP call is synchronous in the script and how long it may block is unknown.

### Gaps
- Exact script function names for HTTP and SendKeys; whether HTTP supports HTTPS with custom headers (needed for ERP/Supabase auth); sync vs async behavior. The TWedge3 manual (https://www.tec-it.com/download/PDF/TWedge3_Manual_EN.pdf) was fetched but compressed; text extraction was not done.
- No case study found of lookup-then-type with TWedge.
- Whether a perpetual license still exists (page says annual subscriptions only).

## 2. TAL Technologies WinWedge / WedgeLink / BC-Wedge

### Takeaway
WinWedge is a serial/TCP-to-keystroke wedge with parsing and math functions, now sold via Rice Lake. No HTTP/database lookup capability was found, and current pricing is not published.

### Cited Findings
- Rice Lake describes WinWedge as software that takes RS-232 or Ethernet device output and enters it into Excel, Access, or any Windows application or web page; Standard covers RS-232/RS-485, Pro adds TCP/IP, advanced parsing, math functions, virtual instrument mode. — [Rice Lake WinWedge](https://ricelake.com/products/winwedge-tal-wedge-software)
- Rice Lake's 2025 catalog lists Standard (75351) and Pro (72304) as "Consult" (no public price). — [Rice Lake 2025 WinWedge PDF](https://ricelake.com/media/r2qbfwja/2025_winwedge.pdf) (via search summary)
- A 2001 TALtech post gave Standard list $259 (obsolete). — [TALtech store blog](https://store.taltech.com/blog/post/winwedge_standard_3.0_release)
- TALtech markets it as a keyboard wedge for RS232, USB and Ethernet devices and says it can send commands back to instruments. — [TALtech keyboard wedge](https://www.taltech.com/keyboard-wedge)

### Inferences
- WinWedge can transform (parse/reformat), but a network lookup is not a documented feature. A lookup would need an external helper in the chain. **[UNVERIFIED]**: I did not read WinWedge docs for scripting or DDE/ActiveX hooks.

### Gaps
- WedgeLink and BC-Wedge not researched. No evidence either way on lookup capability. Current WinWedge price unknown.

## 3. Scanner firmware / vendor-side rules (Zebra DataWedge, 123Scan ADF, Honeywell EZConfig, Datalogic Aladdin)

### Takeaway
Scanner-side formatting (ADF) is a static, scanner-resident rule interpreter with small storage; it cannot do HTTP/database lookups. DataWedge is an Android service, not an option for a Windows bench laptop. Honeywell EZConfig and Datalogic Aladdin were not researched.

### Cited Findings
- 123Scan ADF rules are built with a GUI wizard that generates code in an interpreted ADF language; the code is loaded into the scanner and the ADF interpreter processes decode data before it is sent to the host. — [Zebra 123Scan ADF docs](https://techdocs.zebra.com/dcs/scanners/123scan/adf/)
- The scanner has 2000 bytes of rule storage; legacy ADF1 limits a rule to 127 bytes; ADF2 is larger; only one format is usable at a time (search summary of Zebra docs). — [Zebra 123Scan ADF docs](https://techdocs.zebra.com/dcs/scanners/123scan/adf/)
- DataWedge is described as a zero-code scanning/processing service for Zebra devices running Android. — [Zebra DataWedge 7.2 about](https://techdocs.zebra.com/datawedge/7-2/guide/about/)

### Inferences
- Firmware cannot dynamically look up a tote: rules are compiled and loaded into a 2000-byte store, with no network access. This matches the expected "static only," but no source states "no lookup" explicitly. A static per-tote table is impractical at scale. Static rules could still prefix/suffix tote scans so a helper can recognise them; not verified as a documented pattern.

### Gaps
- Honeywell EZConfig data formatting and Datalogic Aladdin: not researched. DataWedge Intent output details not verified. No DataWedge-for-Windows product was found (absence of evidence only).

## 4. Socket Mobile Companion / Scandit Keyboard Wedge / "Barcode to PC" apps

### Takeaway
Not researched within the tool budget.

### Cited Findings
- None collected.

### Inferences
- None.

### Gaps
- No evidence gathered on transformation capability of Socket Mobile Companion, Scandit's wedge, or Barcode to PC. **[UNVERIFIED]**: do not rely on any claim about these.

## 5. Hardware HID emulation (Raspberry Pi / Arduino / ESP32-S3 / commercial dongles)

### Takeaway
The mechanism is documented and mainstream (Linux USB HID gadget via configfs; 8-byte keyboard reports written to /dev/hidgX). I did not find a documented warehouse/kiosk project doing lookup-then-type, nor evidence on Arduino/ESP32 or commercial keyboard-emulator dongles.

### Cited Findings
- Kernel doc: "HID reports can be sent/received using read/write on the /dev/hidgX character devices"; the sample keyboard uses an 8-byte report and writes an all-zero report to release keys; with configfs the report descriptor is written as a byte stream to a configfs attribute. — [Linux USB HID gadget driver](https://docs.kernel.org/7.1/usb/gadget_hid.html)
- Typical Pi barcode projects read a USB HID scanner as stdin and put the DB lookup in code (a `process_barcode` stub); scanners can be configured via setup barcodes for inter-character delay and terminator. — [Fast.io OpenClaw Pi inventory agent](https://www.fast.io/resources/openclaw-raspberry-pi-barcode-scanner-inventory-agent.md) (search summary; low-authority source)
- A PostalPoint hardware repo describes a Pico-based middle layer using the USB HID POS barcode-scanner spec; the author notes HID POS is superior to keyboard emulation but rarely implemented; the code was work in progress. — [PostalPoint_Hardware commit](https://source.netsyms.com/PostalPortal/PostalPoint_Hardware/commit/b58c9c844f307db82e38c354e657a9776a0b4541)

### Inferences
- A Pi (OTG-capable port) between scanner (USB host or serial) and laptop (USB device) is technically plausible. It would bypass UIPI, focus and layout-injection issues on the PC because it appears as a real keyboard. It needs network access to the ERP and a layout-aware key-code table. Pi 4/5 gadget-mode specifics (USB-C power/data port) and Pi Zero dwc2 setup were NOT verified.

### Gaps
- No Pi/ESP32/Arduino lookup-then-type warehouse project found; Arduino Keyboard library and ESP32-S3 TinyUSB not researched; commercial keyboard emulator dongles not researched.

## 6. Browser-side approach (Chrome extension; Web Serial/WebHID; ShipStation extension history)

### Takeaway
A content script can listen to real scanner keystrokes, but injecting a result as typing is limited by untrusted-event rules. Setting an input value programmatically may work, but ShipStation's scan-field behavior (React, scan-detection timing) is unverified. Web Serial cannot be shown to type into another tab. No ShipStation-published browser extension was found.

### Cited Findings
- Script-dispatched key events are flagged untrusted (`isTrusted` false) and browsers do not insert their text into fields; a Mozilla bug thread says this is impossible on other browsers too. — [Mozilla Bugzilla 622245](https://bugzilla.mozilla.org/show_bug.cgi?id=622245) and [Mozilla discourse](https://discourse.mozilla.org/t/dispatching-keyboard-event/23593) (from search summaries; I did not open them)
- A trusted-input route via an extension: chrome.debugger / DevTools Protocol `Input.dispatchKeyEvent` yields trusted events but shows a "being debugged" infobar (search summary). — [Adom trusted-input note](https://wiki.adom.inc/adom/chip-fetcher/files/scripts/adom-desktop-trusted-input-prompt.md) (low-authority)
- Web Serial: secure context (HTTPS) only; user activation plus `requestPort()` required; "Limited availability" (not Baseline); the API is scoped to reading/writing serial devices and the page says nothing about sharing a port with other tabs/apps or injecting keystrokes. — [MDN Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
- Third-party extensions exist alongside ShipStation: the GroovePacker + ShipStation Chrome extension opens the recently scanned order in ShipStation; Zonos Label Integration extension prints Zonos labels inside ShipStation. — [Chrome Web Store: GroovePacker-ShipStation](https://chrome.google.com/webstore/detail/groovepacker-shipstation/fpknchejjhppoeflipfekheacbgalbpj) and [Zonos docs](https://zonos.com/de/docs/global-ecommerce/shipping-labels/shipstation-chrome-extension)

### Inferences
- Setting the React input value via the native prototype setter and then dispatching an `input` event is the commonly used workaround for controlled inputs (my background knowledge, **[UNVERIFIED]** by the sources here). Whether ShipStation's scan box needs real key events (it likely detects fast typing + Enter) is unknown. An OS-level or hardware injector avoids the question.
- A Web Serial page (the ERP) can read the scanner but has no documented path to type into another tab. "Cannot type into another tab" is an inference from the API's scope; MDN does not say it explicitly. It would have to message a content script/extension or a local helper.
- An extension scoped to shipstation.com avoids focus loss and UIPI, but needs a Chrome install per bench and a mapping fetch from the ERP.

### Gaps
- Not confirmed whether ShipStation publishes its own browser extension (no hit found; absence of evidence). WebHID not researched. No known extension that remaps scanner input on shipstation.com.

## 7. Precedent inside shipping/WMS land (SkuVault, SKULabs, GroovePacker, Ordoro, AutoHotkey for Scan to Print)

### Takeaway
No community example of AutoHotkey/keyboard-wedge macros for ShipStation scan automation was found. The closest precedent is GroovePacker's extension that opens a scanned order in ShipStation.

### Cited Findings
- ShipStation's native Scan to Print: the user scans barcodes (weight from scale, purchase and print label); after printing, the Scan Barcode screen reappears. — [ShipStation scan to print blog](https://www.shipstation.com/blog/scan-to-print-shipping-workflow.md)
- A reseller notes ShipStation lists the LS2208 as a tested scanner. — [Spartan POS ShipStation hardware](https://spartanpos.com/pages/shipstation-hardware-1)
- A developer thread says the ShipStation API appears to offer no way to look up an order from the barcode on its summary slip. — [Lithium forum thread](https://vhngr73488.lithium.com/t5/Order-Source-Integrations/Shipstation-Barcode-API-to-pull-orders/m-p/2667) (search summary only)
- GroovePacker extension: opens the recently scanned order in ShipStation, meant for stations creating labels right after packing. — [Chrome Web Store](https://chrome.google.com/webstore/detail/groovepacker-shipstation/fpknchejjhppoeflipfekheacbgalbpj)

### Inferences
- The `^#^<hex>^` format and the claim that ShipStation parses it from typed text are the premise of the question; I did not verify them in ShipStation docs.

### Gaps
- Searches for AutoHotkey/keyboard-wedge/macro on the ShipStation community and Reddit returned nothing relevant (one query run; the search tool is not site-targeted). SkuVault, SKULabs, Shippo and Ordoro integrations not researched.

## 8. Reliability considerations

### Takeaway
Windows UIPI silently drops injected input to elevated windows. CDC/serial scanner mode exists on at least the Zebra DS2208 (switchable by programming barcode). Keystroke speed, dead-key `^` handling, and CDC availability on Honeywell/Inateck/Tera were not verified.

### Cited Findings
- UIPI/MIC: a normal (Medium integrity) process cannot send input to a higher (High, elevated) integrity window, and the input can be silently dropped; the fix is to run the sender elevated, or UIAccess, which requires a signed binary in a secure location. — [KeepPressing wiki, Known Limitations](https://github.com/P4suta/keep-pressing/wiki/Known-Limitations); [Microsoft: UIAccess apps in secure locations](https://technet.microsoft.com/en-us/library/jj852244.aspx) (secondary sources, summaries)
- Zebra DS2208 can be switched to a USB CDC virtual serial port by scanning the factory-reset barcode then the CDC barcode; tested on Windows 10 and macOS (reseller-hosted manual). — [Chroma Checker: how to connect DS2208](https://alder.chromachecker.com/manuals/en/show/how_to_connect_zebra_ds2208); Cleverence notes CDC mode may need drivers/extra software — [Cleverence DS2208 article](https://www.cleverence.com/articles/usb-barcode-scanners-de/quick-steps-to-enable-usb-hid-mode-on-ds2208-5837291/)
- Scanners are commonly configurable (via setup barcodes) for inter-character delay and terminator. — [Fast.io Pi guide](https://www.fast.io/resources/openclaw-raspberry-pi-barcode-scanner-inventory-agent.md) (low-authority)

### Inferences
- The caret `^` is a dead key on some non-US layouts (e.g., US-International, many European layouts), so layout-based typing of `^#^` may produce composed or missing characters. Mitigations: a US layout on the bench laptop, Unicode-mode injection (SendInput with KEYEVENTF_UNICODE) rather than scancodes, or a hardware HID device with a fixed layout table. This is general knowledge, **[UNVERIFIED]** by cited sources.
- If the helper owns the scanner via CDC/serial, non-tote scans must be re-typed by the helper (pass-through), which adds latency and a failure mode (helper down means the scanner is dead). Keeping HID and intercepting with a low-level keyboard hook is the alternative; not researched.

### Gaps
- No source on injection speed limits, focus-loss behavior, or caret dead-key handling.
- CDC mode on Honeywell Voyager 1250g/1470g, Inateck, Tera: no evidence found (the Honeywell query returned nothing).
- The primary Microsoft UIPI doc (learn.microsoft.com) was not fetched; UIPI statements come from secondary pages.
