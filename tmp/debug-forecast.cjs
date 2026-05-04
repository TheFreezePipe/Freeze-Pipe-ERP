#!/usr/bin/env node
/**
 * Demand Forecasting Engine for Freeze Pipe ERP
 *
 * Reads ShipStation CSV export, maps SKUs to catalog, computes EWMA + seasonality
 * forecasts, and generates forecast-data.ts for the frontend.
 *
 * Usage: node scripts/build-forecast.js
 */

const fs = require('fs');
const path = require('path');

// ============================================================
// 1. CATALOG — extracted from src/lib/demo-data.ts
// ============================================================
const CATALOG = [
  { id: "1", sku: "BW20" },
  { id: "2", sku: "BW20P" },
  { id: "3", sku: "BW20DNA" },
  { id: "4", sku: "BW30P" },
  { id: "5", sku: "bw64" },
  { id: "6", sku: "BW64P" },
  { id: "7", sku: "BW21P" },
  { id: "8", sku: "BW61" },
  { id: "9", sku: "BW40" },
  { id: "10", sku: "BW40SP" },
  { id: "11", sku: "BW60" },
  { id: "12", sku: "BW60U" },
  { id: "13", sku: "NB2" },
  { id: "14", sku: "NB3U" },
  { id: "15", sku: "BW22" },
  { id: "16", sku: "BW22U" },
  { id: "17", sku: "BW25" },
  { id: "18", sku: "BW58B" },
  { id: "19", sku: "BW59" },
  { id: "20", sku: "BW62" },
  { id: "21", sku: "BW63" },
  { id: "22", sku: "NB4" },
  { id: "23", sku: "NB5" },
  { id: "24", sku: "NB6" },
  { id: "25", sku: "BW68" },
  { id: "26", sku: "NB1M" },
  { id: "27", sku: "S02-NSPM" },
  { id: "28", sku: "S02-NSP" },
  { id: "29", sku: "S02-BW51XL" },
  { id: "30", sku: "S02-BW22M" },
  { id: "31", sku: "BW32-P" },
  { id: "32", sku: "BW38" },
  { id: "33", sku: "BW34" },
  { id: "34", sku: "BW55" },
  { id: "35", sku: "E-Rig-Attachment" },
  { id: "36", sku: "Mini-ENAIL-Gray" },
  { id: "37", sku: "Vape" },
  { id: "38", sku: "Puffco-Peak" },
  { id: "39", sku: "BW33-14" },
  { id: "40", sku: "BW33-19" },
  { id: "41", sku: "BW33-14-45" },
  { id: "42", sku: "BW33-19-45" },
  { id: "43", sku: "BW33-14P" },
  { id: "44", sku: "BW33-19P" },
  { id: "45", sku: "BW20-Bowl" },
  { id: "46", sku: "14-HC-Bowl" },
  { id: "47", sku: "18-HC-Bowl" },
  { id: "48", sku: "Hybrid-Bowl" },
  { id: "49", sku: "14-3X-Bowl" },
  { id: "50", sku: "18-3X-Bowl" },
  { id: "51", sku: "14-G-Bowl" },
  { id: "52", sku: "18-G-Bowl" },
  { id: "53", sku: "14-Banger" },
  { id: "54", sku: "18-Banger" },
  { id: "55", sku: "BW21-Bowl" },
  { id: "56", sku: "Quartz-Tip" },
  { id: "57", sku: "BC-14" },
  { id: "58", sku: "BC-18" },
  { id: "59", sku: "14-Mag-Bowl" },
  { id: "60", sku: "18-Mag-Bowl" },
  { id: "61", sku: "J-Bowl" },
  { id: "62", sku: "FP-Koozie" },
  { id: "63", sku: "Bong-Koozie" },
  { id: "64", sku: "XL-Koozie" },
  { id: "65", sku: "GBT-Koozie" },
  { id: "66", sku: "34-Clip" },
  { id: "67", sku: "19-Clip" },
  { id: "68", sku: "14-Clip" },
  { id: "69", sku: "Plastic-Grinder" },
  { id: "70", sku: "1-Hemp" },
  { id: "71", sku: "Dab-Dish" },
  { id: "72", sku: "Carb-Cap" },
  { id: "73", sku: "BW22-Down" },
  { id: "74", sku: "BW22P-Down" },
  { id: "75", sku: "BW22U-Down" },
  { id: "76", sku: "Cleaning-Bottle" },
  { id: "77", sku: "Cleaning-Caps" },
  { id: "78", sku: "Cleaning-Plugs" },
  { id: "79", sku: "Pipe-Cleaner" },
  { id: "80", sku: "GBT-ADP" },
  { id: "81", sku: "BW20-Stone" },
  { id: "82", sku: "BW40-Stone" },
  { id: "83", sku: "BW40XL-Stone" },
  { id: "84", sku: "NB2-Stone" },
  { id: "85", sku: "BW20DNA-Stone" },
  { id: "86", sku: "Rolling-Tray" },
  { id: "87", sku: "Keychain-Debowler" },
  { id: "88", sku: "Sleeve" },
  { id: "89", sku: "Vault-Box" },
  { id: "90", sku: "Carbon-Filter" },
  { id: "91", sku: "Hookah-Adapter" },
  { id: "92", sku: "10-Filters" },
  { id: "93", sku: "Filter-ADP" },
  { id: "94", sku: "HT-3" },
  { id: "95", sku: "HT-4" },
  { id: "96", sku: "HT-5" },
  { id: "97", sku: "HT-5M" },
  { id: "98", sku: "HT-11" },
  { id: "99", sku: "BW21-Spiral" },
  { id: "100", sku: "BW21-Revolver" },
  { id: "101", sku: "NB1-Spiral" },
  { id: "102", sku: "NB1-XL-Spiral" },
  { id: "103", sku: "BW32P-Straight" },
  { id: "104", sku: "BW32P-Spiral" },
  { id: "105", sku: "34-Middle-Revolver" },
  { id: "106", sku: "HT-7" },
  { id: "107", sku: "34-UFO" },
  { id: "108", sku: "18-UFO" },
  { id: "109", sku: "BW33-14P-Coil" },
  { id: "110", sku: "BW33-19P-Coil" },
  { id: "111", sku: "HT6" },
  { id: "112", sku: "34-DNA-Coil" },
  { id: "113", sku: "BW21-Base" },
  { id: "114", sku: "BW21P-Base" },
  { id: "115", sku: "NB1M-Base" },
  { id: "116", sku: "BW51-base" },
  { id: "117", sku: "BW51P-Base" },
  { id: "118", sku: "BW22-Base" },
  { id: "119", sku: "BW22P-Base" },
  { id: "120", sku: "BW22U-Base" },
  { id: "121", sku: "NB1-Base" },
  { id: "122", sku: "NB2-Base" },
  { id: "123", sku: "BW25-Base" },
  { id: "124", sku: "BW53" },
  { id: "125", sku: "BW34-Base" },
  { id: "126", sku: "BW38-base" },
  { id: "127", sku: "BW32-Base" },
  { id: "128", sku: "BW63-Base" },
];

// Build lookup: lowercase SKU -> catalog entry
const catalogBySkuLower = new Map();
for (const p of CATALOG) {
  catalogBySkuLower.set(p.sku.toLowerCase(), p);
}

// ============================================================
// 2. SKU MAPPING RULES
// ============================================================

// Known aliases: shipstation name (lowercase) -> catalog SKU (exact case)
const KNOWN_ALIASES = new Map([
  // Rule B: Known aliases
  ["fp", "BW20"],
  ["fp - revolver", "BW20P"],
  ["fp-revolver", "BW20P"],
  ["gbt", "BW40"],
  ["bw40-xl", "BW40SP"],
  ["gbt pro", "BW40SP"],
  ["cold-stone", "BW20-Stone"],
  ["1 fp bowl", "BW20-Bowl"],
  ["fp-bowl", "BW20-Bowl"],
  ["fpbowl", "BW20-Bowl"],
  ["freeze pipe bowl", "BW20-Bowl"],
  ["bubbler pro", "BW21P"],
  ["18-mm hc bowl", "18-HC-Bowl"],
  ["14-mm hc bowl", "14-HC-Bowl"],
  ["hybrid-bowl", "Hybrid-Bowl"],
  ["bw64", "bw64"],
  ["bw61", "BW61"],
  ["fp-bottle", "Cleaning-Bottle"],
  ["1-hemp", "1-Hemp"],
  ["1hemprope", "1-Hemp"],
  ["fp-grinder", "Plastic-Grinder"],
  ["beaker bong", "BW22"],
  ["mini bong", "NB1M"],
  ["recycler", "BW25"],
  ["klein", "BW34"],
  ["e-nail", "Mini-ENAIL-Gray"],
  ["fpenail", "Mini-ENAIL-Gray"],
  ["34mm-clip", "34-Clip"],
  ["19mm-clip", "19-Clip"],
  ["19-clip", "19-Clip"],
  ["14mm-clip", "14-Clip"],
  ["14-clip", "14-Clip"],
  ["sleeve", "Sleeve"],
  ["vault-box", "Vault-Box"],
  ["rolling-tray", "Rolling-Tray"],
  ["carb-cap", "Carb-Cap"],
  ["carb cap", "Carb-Cap"],
  ["gbt-koozie", "GBT-Koozie"],
  ["gbt koozie", "GBT-Koozie"],
  ["34-dna-coil", "34-DNA-Coil"],
  ["dna-coil", "34-DNA-Coil"],
  ["ht-dna", "34-DNA-Coil"],
  ["nb1-spiral", "NB1-Spiral"],
  ["bong coil", "NB1-Spiral"],
  ["bw21-revolver", "BW21-Revolver"],
  ["bubbler pro coil", "BW21-Revolver"],
  ["bw21-spiral", "BW21-Spiral"],
  ["bubbler coil", "BW21-Spiral"],
  ["34-middle-revolver", "34-Middle-Revolver"],
  ["ht7", "HT-7"],
  ["ht-7", "HT-7"],
  ["ht6", "HT6"],
  ["ht-3", "HT-3"],
  ["ht-4", "HT-4"],
  ["ht-5", "HT-5"],
  ["ht-11", "HT-11"],
  ["34-ufo", "34-UFO"],
  ["34mm ufo perc", "34-UFO"],
  ["18-ufo", "18-UFO"],
  ["18mm ufo perc", "18-UFO"],
  ["bong-koozie", "Bong-Koozie"],
  ["bw20dna-iridescent", "BW20DNA"],
  ["bw21p-iridescent", "BW21P"],
  ["vape pen", "Vape"],
  ["gbt-stone", "BW40-Stone"],
  ["gbt-pro-stone", "BW40XL-Stone"],
  ["gbt pro cold stone", "BW40XL-Stone"],
  ["gbt cold stone", "BW40-Stone"],
  ["dab-dish", "Dab-Dish"],
  ["quartz-tip", "Quartz-Tip"],
  ["bc-14", "BC-14"],
  ["bc-18", "BC-18"],
  ["bw21-bowl", "BW21-Bowl"],
  ["bubbler bowl", "BW21-Bowl"],
  ["bub-bowl", "BW21-Bowl"],
  ["j-bowl", "J-Bowl"],
  ["14-banger", "14-Banger"],
  ["14mm banger", "14-Banger"],
  ["18-banger", "18-Banger"],
  ["18mm banger", "18-Banger"],
  ["14-mag-bowl", "14-Mag-Bowl"],
  ["18-mag-bowl", "18-Mag-Bowl"],
  ["14-3x-bowl", "14-3X-Bowl"],
  ["18-3x-bowl", "18-3X-Bowl"],
  ["14-g-bowl", "14-G-Bowl"],
  ["14mm glycerin bowl", "14-G-Bowl"],
  ["18-g-bowl", "18-G-Bowl"],
  ["18mm glycerin bowl", "18-G-Bowl"],
  ["bw33-14 pro", "BW33-14P"],
  ["14mm ac pro", "BW33-14P"],
  ["bw33-18 pro", "BW33-19P"],
  ["18mm ac pro", "BW33-19P"],
  ["10-filters", "10-Filters"],
  ["pipe-filters", "10-Filters"],
  ["10-pipe-cleaner", "10-Filters"],
  ["filter-adp", "Filter-ADP"],
  ["gbt-adp", "GBT-ADP"],
  ["gbt-adapter", "GBT-ADP"],
  ["puffco-peak", "Puffco-Peak"],
  ["nb6", "NB6"],
  ["plastic grinder", "Plastic-Grinder"],
  ["bw22-down", "BW22-Down"],
  ["beaker downstem", "BW22-Down"],
  ["bw22-downstem", "BW22-Down"],
  ["bw22u-down", "BW22U-Down"],
  ["bw22u-downstem", "BW22U-Down"],
  ["bw22p-down", "BW22P-Down"],
  ["bw22p-downstem", "BW22P-Down"],
  ["nb2-stone", "NB2-Stone"],
  ["bw40xl-stone", "BW40XL-Stone"],
  ["bw40-stone", "BW40-Stone"],
  ["bw20dna-stone", "BW20DNA-Stone"],
  ["keychain-debowler", "Keychain-Debowler"],
  ["fp-koozie", "FP-Koozie"],
  ["koozie", "FP-Koozie"],
  ["xl-koozie", "XL-Koozie"],
  ["xl bong koozie", "XL-Koozie"],
  ["bong koozie", "Bong-Koozie"],
  ["ac pro coil", "BW33-19P-Coil"],
  ["ht-bong", "HT-5"],   // HT-Bong likely means bong coil HT-5
  ["carbon-filter", "Carbon-Filter"],
  ["hookah-adapter", "Hookah-Adapter"],
  ["e-rig-attachment", "E-Rig-Attachment"],

  // Additional high-volume aliases discovered from unmatched analysis
  ["bw21", "BW21P"],       // old bubbler -> current bubbler pro
  ["nb1", "NB1M"],         // old bong -> mini bong (current)
  ["fpb", "BW21P"],        // FPB = freeze pipe bubbler = BW21P
  ["beaker pro", "BW22"],  // beaker pro -> beaker bong
  ["bw22p", "BW22U"],      // beaker pro SKU -> beaker ultimate
  ["mini-enail-gray1", "Mini-ENAIL-Gray"],
  ["mini enail gray1", "Mini-ENAIL-Gray"],
  ["mini-enail", "Mini-ENAIL-Gray"],
  ["18mm big hc bowl", "18-HC-Bowl"],
  ["ufo perc", "34-UFO"],
  ["tornado", "BW25"],     // tornado mapped to recycler as closest current product
  ["bw20ps", "BW20P"],     // revolver color variant
  ["bw59ms", "BW59"],      // swiss bong variant
  ["bw21pro-base", "BW21P-Base"],
  ["iridescent pipe - spiral", "BW20DNA"],  // iridescent pipe variant
  ["iridescent pipe", "BW20DNA"],
  ["straight tube", "NB4"],
  ["straight tube bong", "NB4"],
  ["bw22p-base", "BW22P-Base"],
  ["nb1-base", "NB1-Base"],
  ["nb2-base", "NB2-Base"],
  ["nb2 base", "NB2-Base"],
  ["bw22 base", "BW22-Base"],
  ["bw22-base", "BW22-Base"],
  ["bw25-base", "BW25-Base"],
  ["bw34-base", "BW34-Base"],
  ["bw38-base", "BW38-base"],
  ["bw63-base", "BW63-Base"],
  ["bw32-base", "BW32-Base"],
  ["bw51-base", "BW51-base"],
  ["bw51p-base", "BW51P-Base"],
  ["ht5", "HT-5"],
  ["ht3", "HT-3"],
  ["ht4", "HT-4"],
  ["ht11", "HT-11"],
  ["ht-5m", "HT-5M"],
  ["ht5m", "HT-5M"],
  ["nb3u", "NB3U"],
  ["nb4", "NB4"],
  ["nb5", "NB5"],
  ["bw58b", "BW58B"],
  ["bw60", "BW60"],
  ["bw60u", "BW60U"],
  ["bw62", "BW62"],
  ["bw63", "BW63"],
  ["bw68", "BW68"],
  ["bw30p", "BW30P"],
  ["bw59", "BW59"],
  ["bw55", "BW55"],
  ["bw53", "BW53"],
  ["bw64p", "BW64P"],
  ["carbon filter", "Carbon-Filter"],
  ["charcoal filter", "Carbon-Filter"],
  ["hookah adapter", "Hookah-Adapter"],
  ["hookah-bong", "BW63"],
  ["bong ultimate", "NB3U"],
  ["nb1-xl-spiral", "NB1-XL-Spiral"],
  ["bw32p-straight", "BW32P-Straight"],
  ["bw32p-spiral", "BW32P-Spiral"],
  ["bw33-14p-coil", "BW33-14P-Coil"],
  ["bw33-19p-coil", "BW33-19P-Coil"],
  ["ac pro 14 coil", "BW33-14P-Coil"],
  ["ac pro 18 coil", "BW33-19P-Coil"],
  ["pipe filter", "10-Filters"],
  ["pipe filters", "10-Filters"],
  ["bw33-14-45", "BW33-14-45"],
  ["bw33-19-45", "BW33-19-45"],
  ["14mm 45 ash catcher", "BW33-14-45"],
  ["18mm 45 ash catcher", "BW33-19-45"],
  ["14mm ash catcher", "BW33-14"],
  ["18mm ash catcher", "BW33-19"],
  ["s02-nspm", "S02-NSPM"],
  ["s02-nsp", "S02-NSP"],
  ["s02-bw51xl", "S02-BW51XL"],
  ["s02-bw22m", "S02-BW22M"],
  ["nb1m-base", "NB1M-Base"],
  ["bw22u-base", "BW22U-Base"],

  // Additional round 2 unmatched fixes
  ["mini rig", "BW38"],
  ["mini-rig", "BW38"],
  ["mini dab rig", "BW38"],
  ["14mm big hc bowl", "14-HC-Bowl"],
  ["blue gbt", "BW40"],
  ["nb1m-spiral", "NB1-Spiral"],    // mini bong spiral coil
  ["spiral - bubbler", "BW21-Spiral"],
  ["beaker ultimate", "BW22U"],
  ["showerhead base", "NB2-Base"],
  ["bw21u", "BW21P"],                // bubbler ultimate -> bubbler pro (current)
  ["nb1m-ht6", "NB1M"],             // mini bong w/ coil -> count base product
  ["revolver coil", "BW21-Revolver"],
  ["fp bong", "NB2"],
  ["fp-bong", "NB2"],
  ["bong pro", "NB2"],
  ["bong-pro", "NB2"],
  ["bong xl", "NB4"],
  ["bong-xl", "NB4"],
  ["swiss bong", "BW59"],
  ["swiss-bong", "BW59"],
  ["combo bong", "BW62"],
  ["hookah bong", "BW63"],
  ["layflat bong", "BW68"],
  ["lay flat bong", "BW68"],
  ["waterfall dab rig", "BW55"],
  ["waterfall", "BW55"],
  ["nectar collector", "BW32-P"],
  ["mini bong base", "NB1M-Base"],
  ["bubbler base", "BW21-Base"],
  ["bubbler pro base", "BW21P-Base"],
  ["beaker base", "BW22-Base"],
  ["beaker pro base", "BW22P-Base"],
  ["beaker ultimate base", "BW22U-Base"],
  ["klein base", "BW34-Base"],
  ["recycler base", "BW25-Base"],
  ["mini rig base", "BW38-base"],
  ["joint bubbler", "BW60"],
  ["joint bubbler ultimate", "BW60U"],
]);

// DS- prefix mappings
const DS_MAP = new Map([
  ["ds-fp", "BW20"],
  ["ds-bong", "NB2"],
  ["ds-bong-xl", "NB4"],
  ["ds-mini-bong", "NB1M"],
  ["ds-beaker", "BW22"],
  ["ds-bubbler", "BW21P"],
  ["ds-gbt", "BW40"],
  ["ds-gbt-pro", "BW40SP"],
  ["ds-vape", "Vape"],
  ["ds-enail", "Mini-ENAIL-Gray"],
  ["ds-klein", "BW34"],
  ["ds-recycler", "BW25"],
  ["ds-14ac", "BW33-14"],
  ["ds-18ac", "BW33-19"],
  ["ds-mini-rig", "BW38"],
  ["ds-nc", "BW32-P"],
  ["ds-nc-kit", "BW32-P"],
  ["ds-wdr", "BW55"],
  ["ds-bubbler-kit", "BW21P"],
  ["ds-bubbler-pro", "BW21P"],
]);

// WS- prefix mappings
const WS_MAP = new Map([
  ["ws-fp", "BW20"],
  ["ws-revolver", "BW20P"],
  ["ws-fpbong", "NB2"],
  ["ws-fpbongxl", "NB4"],
  ["ws-fpbpro", "NB2"],
  ["ws-gbt", "BW40"],
  ["ws-gbtpro", "BW40SP"],
  ["ws-enail", "Mini-ENAIL-Gray"],
  ["ws-klein", "BW34"],
  ["ws-minirig", "BW38"],
  ["ws-fprec", "BW25"],
  ["ws-ac18", "BW33-19P"],
  ["ws-acpro18", "BW33-19P"],
  ["ws-ac14", "BW33-14P"],
  ["ws-acpro14", "BW33-14P"],
  ["ws-beakerultimate", "BW22U"],
  ["ws-fpb", "BW21P"],
  ["ws-nb1m", "NB1M"],
  ["ws-fpnc", "BW32-P"],
]);

// SKUs to skip entirely
const SKIP_PATTERNS = [
  /^customizeyourpiece$/i,
  /^bw51d/i,
  /^steamroller/i,
  /^steamroller-bw30/i,
  /^bw56/i,
  /^bw39/i,
  /^martini/i,
  /^nb2s/i,
  /^nb2m/i,
  /^bw70/i,
  /^gravity[\s-]?bong/i,
  /^inside[\s-]?out[\s-]?bong/i,
  /^hat$/i,
  /^shirt/i,
  /^tf-/i,
  /^station-/i,
  /^fps01-/i,
  /^q9-/i,
  /^i4-/i,
  /^xa-/i,
  /^g-pen$/i,
  /^dna-koozie$/i,
  /^bw33-19p-downstem$/i,
  /^bw33-14p-downstem$/i,
  /^ds-steamroller$/i,
  /^ds-dual$/i,
  /^ds-tornado$/i,
  /^ws-steamroller$/i,
  /^ws-martini$/i,
  /^ws-fpbongdual$/i,
  /^ws-fpgb$/i,
  /^negative-spoon$/i,
  /^pfn$/i,
  /^nb2m/i,         // mini colored bongs (discontinued)
  /^nb2s/i,         // special bongs (discontinued)
  /^rubber-washer$/i,
  /^rubber[\s-]washer$/i,
  /^hat-/i,
  /^tshirt/i,
  /^sticker/i,
  /^gift[\s-]?card/i,
  /^bw39/i,
];

// ============================================================
// 3. SKU RESOLUTION: shipstation SKU -> [{catalogSku, qty}]
// ============================================================

// Bundle patterns: returns array of {catalogSku, qty} or null if can't resolve
function tryBundleDecompose(ssSkuRaw) {
  const ss = ssSkuRaw.trim();
  const ssL = ss.toLowerCase();

  // Cleaning Kit
  if (/^cleaning[\s-]?kit$/i.test(ss)) {
    return [
      { catalogSku: "Cleaning-Bottle", qty: 1 },
      { catalogSku: "Cleaning-Caps", qty: 1 },
      { catalogSku: "Cleaning-Plugs", qty: 1 },
    ];
  }

  // 2-Cleaning-Bottles, 2 pack bottles - solution
  if (/^2[\s-]?cleaning[\s-]?bottles?$/i.test(ss) ||
      /^2[\s-]?pack[\s-]?bottles?[\s-]*[-]?[\s-]*solution$/i.test(ss)) {
    return [{ catalogSku: "Cleaning-Bottle", qty: 2 }];
  }
  // 1 bottle - solution
  if (/^1[\s-]?bottle[\s-]*[-]?[\s-]*solution$/i.test(ss)) {
    return [{ catalogSku: "Cleaning-Bottle", qty: 1 }];
  }

  // 2-Pack patterns
  const twoPack = ss.match(/^2[\s-]?pack[\s-]+(.+)$/i);
  if (twoPack) {
    const inner = twoPack[1].trim();
    const resolved = resolveSimpleSku(inner);
    if (resolved) return [{ catalogSku: resolved, qty: 2 }];
    // try known aliases for inner
    const innerL = inner.toLowerCase();
    if (innerL === 'gbt') return [{ catalogSku: "BW40", qty: 2 }];
    if (innerL === 'gbt pro') return [{ catalogSku: "BW40SP", qty: 2 }];
    if (innerL === 'vape pen' || innerL === 'vape') return [{ catalogSku: "Vape", qty: 2 }];
    return null;
  }

  // 2-PACK with hyphen prefix
  const twoPackH = ss.match(/^2-pack[\s-]+(.+)$/i);
  if (twoPackH) {
    const inner = twoPackH[1].trim();
    const innerL = inner.toLowerCase();
    if (innerL === 'bw40' || innerL === 'gbt') return [{ catalogSku: "BW40", qty: 2 }];
    if (innerL === 'bw40-xl' || innerL === 'gbt pro') return [{ catalogSku: "BW40SP", qty: 2 }];
    if (/^18-3x-bowl$/i.test(inner)) return [{ catalogSku: "18-3X-Bowl", qty: 2 }];
    if (/^14-3x-bowl$/i.test(inner)) return [{ catalogSku: "14-3X-Bowl", qty: 2 }];
    if (/^vape/i.test(inner)) return [{ catalogSku: "Vape", qty: 2 }];
    const resolved = resolveSimpleSku(inner);
    if (resolved) return [{ catalogSku: resolved, qty: 2 }];
    return null;
  }

  // 3-Pipe-Cleaner
  if (/^3[\s-]?pipe[\s-]?cleaner$/i.test(ss)) {
    return [{ catalogSku: "Pipe-Cleaner", qty: 3 }];
  }

  // E-Rig-Attachment + Puffco
  if (/e-rig-attachment.*puffco/i.test(ss)) {
    return [
      { catalogSku: "E-Rig-Attachment", qty: 1 },
      { catalogSku: "Puffco-Peak", qty: 1 },
    ];
  }

  // "HT5 - NB2" style bundles (product + coil with " - " separator)
  const dashBundle = ss.match(/^([A-Za-z0-9]+)\s+-\s+([A-Za-z0-9]+)$/);
  if (dashBundle) {
    const parts = [dashBundle[1], dashBundle[2]];
    const result = tryResolveBundleParts(parts);
    if (result) return result;
  }

  // "+" or "&" bundles
  if (ss.includes('+') || ss.includes('&')) {
    const separator = ss.includes('+') ? '+' : '&';
    const parts = ss.split(separator).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return tryResolveBundleParts(parts);
    }
  }

  return null;
}

function tryResolveBundleParts(parts) {
  const results = [];
  for (const part of parts) {
    const partL = part.toLowerCase().trim();

    // First try direct resolution
    const directResolved = resolveSimpleSku(part);
    if (directResolved) {
      results.push({ catalogSku: directResolved, qty: 1 });
      continue;
    }

    // Known bundle component names
    if (/^14[\s-]?mm?\s*banger$/i.test(part) || partL === '14-banger') {
      results.push({ catalogSku: "14-Banger", qty: 1 });
    } else if (/^18[\s-]?mm?\s*banger$/i.test(part) || partL === '18-banger') {
      results.push({ catalogSku: "18-Banger", qty: 1 });
    } else if (/carb[\s-]?cap/i.test(part)) {
      results.push({ catalogSku: "Carb-Cap", qty: 1 });
    } else if (/^(14[\s-]?mm\s*)?ac\s*pro$/i.test(part) || /^14mm ac pro$/i.test(part)) {
      results.push({ catalogSku: "BW33-14P", qty: 1 });
    } else if (/^ash\s*catcher$/i.test(part)) {
      results.push({ catalogSku: "BW33-14", qty: 1 });
    } else if (/^bowl$/i.test(part)) {
      results.push({ catalogSku: "BW20-Bowl", qty: 1 });
    } else if (/^cap$/i.test(part)) {
      results.push({ catalogSku: "Carb-Cap", qty: 1 });
    } else if (/vape[\s-]?pen$/i.test(part) || partL === 'vape') {
      results.push({ catalogSku: "Vape", qty: 1 });
    } else if (/^(blue\s+)?gbt$/i.test(part) || partL === 'bw40') {
      results.push({ catalogSku: "BW40", qty: 1 });
    } else if (/gbt\s*pro$/i.test(part) || partL === 'bw40sp') {
      results.push({ catalogSku: "BW40SP", qty: 1 });
    } else if (partL === 'puffco' || partL === 'puffco-peak') {
      results.push({ catalogSku: "Puffco-Peak", qty: 1 });
    } else if (partL === 'ht5' || partL === 'ht-5') {
      results.push({ catalogSku: "HT-5", qty: 1 });
    } else if (partL === 'dna' || partL === '34-dna-coil') {
      results.push({ catalogSku: "34-DNA-Coil", qty: 1 });
    } else {
      // Try resolving the part as a simple SKU
      const resolved = resolveSimpleSku(part);
      if (resolved) {
        results.push({ catalogSku: resolved, qty: 1 });
      } else {
        // Can't resolve this part -> skip entire bundle
        return null;
      }
    }
  }
  return results.length > 0 ? results : null;
}

// Flower Kit / Dab Kit / Chill Kit: extract base product
function tryKitMapping(ssSkuRaw) {
  const ss = ssSkuRaw.trim();
  // Patterns: "NB2 & Flower Kit", "NB2 flower kit", "NB2-Flower", "NB2-Dab", "NB2 Chill Kit"
  const kitMatch = ss.match(/^([A-Za-z0-9]+)[\s&-]+(flower|dab|chill)[\s-]*(kit)?$/i);
  if (kitMatch) {
    const baseSku = kitMatch[1];
    const resolved = resolveSimpleSku(baseSku);
    if (resolved) return [{ catalogSku: resolved, qty: 1 }];
  }
  return null;
}

// SS_ prefix: color variants -> base product + coil
function trySsPrefix(ssSkuRaw) {
  const ss = ssSkuRaw.trim();
  if (!ss.startsWith('SS_')) return null;

  const inner = ss.substring(3); // Remove SS_
  // Pattern: PRODUCT-COIL-COLOR e.g. NB2-HT5-Green
  const match = inner.match(/^([A-Za-z0-9]+)-([A-Za-z0-9-]+)-(Green|Purple|Blue|Red|Black|White|Pink|Orange|Yellow)$/i);
  if (match) {
    const prodPart = match[1];
    const coilPart = match[2];

    const results = [];
    // Resolve product
    const prodMap = {
      'nb2': 'NB2', 'nb1': 'NB1M', 'nb1m': 'NB1M',
      'rec': 'BW25', 'bw22': 'BW22', 'bw34': 'BW34',
      'bw21p': 'BW21P', 'bw58b': 'BW58B',
    };
    const resolvedProd = prodMap[prodPart.toLowerCase()];
    if (resolvedProd && catalogBySkuLower.has(resolvedProd.toLowerCase())) {
      results.push({ catalogSku: resolvedProd, qty: 1 });
    } else {
      return null;
    }

    // Resolve coil
    const coilMap = {
      'ht5': 'HT-5', 'ht-5': 'HT-5', 'ht3': 'HT-3', 'ht-3': 'HT-3',
      'ht4': 'HT-4', 'ht-4': 'HT-4', 'ht7': 'HT-7', 'ht-7': 'HT-7',
      'spiral': 'NB1-Spiral', 'nb1-spiral': 'NB1-Spiral',
      'dna': '34-DNA-Coil', '34-dna-coil': '34-DNA-Coil',
      'ht-11': 'HT-11', 'ht11': 'HT-11',
    };
    const resolvedCoil = coilMap[coilPart.toLowerCase()];
    if (resolvedCoil && catalogBySkuLower.has(resolvedCoil.toLowerCase())) {
      results.push({ catalogSku: resolvedCoil, qty: 1 });
    }

    return results.length > 0 ? results : null;
  }

  return null;
}

// Base SKU mapping: "NB2-base" -> "NB2-Base"
function tryBaseMapping(ssSkuRaw) {
  const ss = ssSkuRaw.trim();
  if (/-base$/i.test(ss)) {
    // Try exact case-insensitive match
    const entry = catalogBySkuLower.get(ss.toLowerCase());
    if (entry) return [{ catalogSku: entry.sku, qty: 1 }];
  }
  return null;
}

// Resolve a single SKU name -> catalog SKU string (or null)
function resolveSimpleSku(name) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  // A. Direct match (case-insensitive)
  const direct = catalogBySkuLower.get(lower);
  if (direct) return direct.sku;

  // B. Known aliases
  const alias = KNOWN_ALIASES.get(lower);
  if (alias) {
    // Verify alias is in catalog
    if (catalogBySkuLower.has(alias.toLowerCase())) return alias;
  }

  // C. DS- prefix
  const dsMatch = DS_MAP.get(lower);
  if (dsMatch) {
    if (catalogBySkuLower.has(dsMatch.toLowerCase())) return dsMatch;
  }

  // D. WS- prefix
  const wsMatch = WS_MAP.get(lower);
  if (wsMatch) {
    if (catalogBySkuLower.has(wsMatch.toLowerCase())) return wsMatch;
  }

  return null;
}

/**
 * Master resolver: returns [{catalogSku, qty}] or null (skip)
 */
function resolveShipStationSku(ssSkuRaw, rowQty) {
  const ss = ssSkuRaw.trim();
  if (!ss) return null;
  const lower = ss.toLowerCase();

  // Check skip patterns
  for (const pat of SKIP_PATTERNS) {
    if (pat.test(ss)) return null;
  }

  // Skip qty 0 rows (handled at caller level too)

  // Try simple resolution first
  const simple = resolveSimpleSku(ss);
  if (simple) return [{ catalogSku: simple, qty: rowQty }];

  // Try base mapping
  const base = tryBaseMapping(ss);
  if (base) return base.map(b => ({ ...b, qty: b.qty * rowQty }));

  // Try SS_ prefix
  const ssPrefix = trySsPrefix(ss);
  if (ssPrefix) return ssPrefix.map(b => ({ ...b, qty: b.qty * rowQty }));

  // Try kit mapping (Flower Kit / Dab Kit / Chill Kit)
  const kit = tryKitMapping(ss);
  if (kit) return kit.map(b => ({ ...b, qty: b.qty * rowQty }));

  // Try bundle decomposition
  const bundle = tryBundleDecompose(ss);
  if (bundle) return bundle.map(b => ({ ...b, qty: b.qty * rowQty }));

  // For "2-Cleaning-Bottles" style SKUs that aren't '+' bundles
  if (/^2[\s-]?cleaning[\s-]?bottles?$/i.test(ss)) {
    return [{ catalogSku: "Cleaning-Bottle", qty: 2 * rowQty }];
  }

  return null; // unmatched
}

// ============================================================
// 4. CSV PARSING
// ============================================================

function parseCSV(filePath) {
  console.log(`Reading CSV from: ${filePath}`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  console.log(`Total lines (including header): ${lines.length}`);

  // Skip header
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse quoted CSV: "qty","date","sku"
    const match = line.match(/^"([^"]*)","([^"]*)","([^"]*)"$/);
    if (!match) {
      // Try unquoted fallback
      const parts = line.split(',');
      if (parts.length >= 3) {
        rows.push({
          qty: parseInt(parts[0].replace(/"/g, ''), 10) || 0,
          date: parts[1].replace(/"/g, '').trim(),
          sku: parts.slice(2).join(',').replace(/"/g, '').trim(),
        });
      }
      continue;
    }

    rows.push({
      qty: parseInt(match[1], 10) || 0,
      date: match[2].trim(),
      sku: match[3].trim(),
    });
  }

  console.log(`Parsed ${rows.length} data rows`);
  return rows;
}

function parseDate(dateStr) {
  // Format: "10/16/2023 12:21:34 AM" or "1/5/2024 3:00:00 PM"
  const parts = dateStr.split(' ');
  if (parts.length < 1) return null;
  const dateParts = parts[0].split('/');
  if (dateParts.length !== 3) return null;
  const month = parseInt(dateParts[0], 10);
  const day = parseInt(dateParts[1], 10);
  const year = parseInt(dateParts[2], 10);
  if (isNaN(month) || isNaN(day) || isNaN(year)) return null;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// ============================================================
// 5. AGGREGATE DAILY DEMAND
// ============================================================

function aggregateDemand(rows) {
  // dailyDemand[catalogSku][dateStr] = totalUnits
  const dailyDemand = {};
  let matched = 0;
  let unmatched = 0;
  let skippedZero = 0;
  const unmatchedCounts = {}; // sssku -> total qty

  for (const row of rows) {
    if (row.qty <= 0) {
      skippedZero++;
      continue;
    }
    if (!row.sku) {
      unmatched++;
      continue;
    }

    const dateStr = parseDate(row.date);
    if (!dateStr) {
      unmatched++;
      continue;
    }

    const resolved = resolveShipStationSku(row.sku, row.qty);
    if (!resolved) {
      unmatched += row.qty;
      const key = row.sku.toLowerCase();
      unmatchedCounts[key] = (unmatchedCounts[key] || 0) + row.qty;
      continue;
    }

    for (const { catalogSku, qty } of resolved) {
      if (!dailyDemand[catalogSku]) dailyDemand[catalogSku] = {};
      dailyDemand[catalogSku][dateStr] = (dailyDemand[catalogSku][dateStr] || 0) + qty;
      matched += qty;
    }
  }

  return { dailyDemand, matched, unmatched, skippedZero, unmatchedCounts };
}

// ============================================================
// 6. FORECASTING ALGORITHM
// ============================================================

function computeForecast(dailySeries, catalogSku, catalogId) {
  // dailySeries: { dateStr: units }
  const dates = Object.keys(dailySeries).sort();
  if (dates.length === 0) return null;

  const lastDate = dates[dates.length - 1];
  const firstDate = dates[0];

  // Build a contiguous daily array from first to last date
  const startMs = new Date(firstDate + 'T00:00:00Z').getTime();
  const endMs = new Date(lastDate + 'T00:00:00Z').getTime();
  const dayMs = 86400000;
  const totalDays = Math.round((endMs - startMs) / dayMs) + 1;

  const dailyArray = new Array(totalDays).fill(0);
  const dateArray = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startMs + i * dayMs);
    const ds = d.toISOString().slice(0, 10);
    dateArray.push(ds);
    dailyArray[i] = dailySeries[ds] || 0;
  }

  // --- Promotional Spike Filtering ---
  const filtered = [...dailyArray];
  for (let i = 14; i < filtered.length; i++) {
    // Rolling 14-day median
    const window = filtered.slice(i - 14, i).sort((a, b) => a - b);
    const median = window[7]; // approximate median
    if (median > 0 && filtered[i] > 3 * median) {
      filtered[i] = Math.round(2 * median);
    }
  }

  // --- EWMA on last 90 days ---
  const alpha = 0.15;
  const last90Start = Math.max(0, filtered.length - 90);
  let ewma = filtered[last90Start];
  for (let i = last90Start + 1; i < filtered.length; i++) {
    ewma = alpha * filtered[i] + (1 - alpha) * ewma;
  }

  // --- Seasonal Indices ---
  // Group by month, compute average daily demand per month.
  // Exclude the current (incomplete) month — a partial month with only a few
  // days of data would distort the seasonal index.  We require at least 15 days
  // of data in a calendar month for it to count as a seasonal signal.
  const lastDateObj = new Date(dateArray[dateArray.length - 1] + 'T00:00:00Z');
  const currentYear = lastDateObj.getUTCFullYear();
  const currentMonth = lastDateObj.getUTCMonth() + 1; // 1-12

  const monthTotals = {}; // month (1-12) -> { totalUnits, totalDays }
  for (let i = 0; i < dateArray.length; i++) {
    const y = parseInt(dateArray[i].slice(0, 4), 10);
    const m = parseInt(dateArray[i].slice(5, 7), 10);
    // Skip current incomplete month in the current year
    if (y === currentYear && m === currentMonth) continue;
    if (!monthTotals[m]) monthTotals[m] = { totalUnits: 0, totalDays: 0 };
    monthTotals[m].totalUnits += filtered[i];
    monthTotals[m].totalDays++;
  }

  const monthAvgDaily = {};
  let overallAvgDaily = 0;
  let totalMonthsWithData = 0;
  for (let m = 1; m <= 12; m++) {
    // Require at least 15 days of data for a meaningful seasonal signal
    if (monthTotals[m] && monthTotals[m].totalDays >= 15) {
      monthAvgDaily[m] = monthTotals[m].totalUnits / monthTotals[m].totalDays;
      overallAvgDaily += monthAvgDaily[m];
      totalMonthsWithData++;
    }
  }
  overallAvgDaily = totalMonthsWithData > 0 ? overallAvgDaily / totalMonthsWithData : 1;

  const seasonalIndex = {};
  for (let m = 1; m <= 12; m++) {
    if (monthAvgDaily[m] !== undefined && overallAvgDaily > 0) {
      seasonalIndex[m] = monthAvgDaily[m] / overallAvgDaily;
    } else {
      // No reliable data for this month — use neutral index
      seasonalIndex[m] = 1.0;
    }
  }

  if (catalogSku === "NB4") { const apr = []; for (let i = 0; i < dateArray.length; i++) { const y = parseInt(dateArray[i].slice(0,4),10); const m = parseInt(dateArray[i].slice(5,7),10); if (m===4) apr.push({date:dateArray[i],y,m,val:filtered[i]}); } console.log("NB4 April dates:", apr.length, "first:", apr[0], "last:", apr[apr.length-1]); console.log("NB4 currentYear:", currentYear, "currentMonth:", currentMonth); }
  // Current month for forecast (use April 2026 = month 4)
  const forecastMonth = 4;
  const currentSeasonalIdx = seasonalIndex[forecastMonth] || 1.0;

  // --- Trend Component ---
  // Linear regression on last 180 days of monthly totals
  const last180Start = Math.max(0, filtered.length - 180);
  // Group into months
  const trendMonths = {};
  for (let i = last180Start; i < filtered.length; i++) {
    const ym = dateArray[i].slice(0, 7); // YYYY-MM
    trendMonths[ym] = (trendMonths[ym] || 0) + filtered[i];
  }

  const trendKeys = Object.keys(trendMonths).sort();
  let trendMultiplier = 1.0;
  if (trendKeys.length >= 3) {
    // Simple linear regression: y = a + b*x
    const n = trendKeys.length;
    const xs = Array.from({ length: n }, (_, i) => i);
    const ys = trendKeys.map(k => trendMonths[k]);
    const xMean = xs.reduce((a, b) => a + b, 0) / n;
    const yMean = ys.reduce((a, b) => a + b, 0) / n;

    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - xMean) * (ys[i] - yMean);
      den += (xs[i] - xMean) ** 2;
    }
    const slope = den !== 0 ? num / den : 0;
    // Compute trend as % change per month relative to mean
    if (yMean > 0) {
      const pctChange = slope / yMean;
      // Cap at +/- 20%
      trendMultiplier = Math.max(0.80, Math.min(1.20, 1 + pctChange));
    }
  }

  // --- Final Forecast ---
  const forecast30d = Math.max(0, Math.round(ewma * 30 * currentSeasonalIdx * trendMultiplier));
  const lowerBound = Math.round(forecast30d * 0.75);
  const upperBound = Math.round(forecast30d * 1.30);

  return {
    catalogSkuId: catalogId,
    sku: catalogSku,
    forecastedDemand30d: forecast30d,
    lowerBound,
    upperBound,
    ewmaDaily: Math.round(ewma * 1000) / 1000,
    seasonalIndex: Math.round(currentSeasonalIdx * 1000) / 1000,
    trendMultiplier: Math.round(trendMultiplier * 1000) / 1000,
    dataPoints: totalDays,
    lastSaleDate: lastDate,
  };
}

// ============================================================
// 7. MAIN
// ============================================================

function main() {
  const csvPath = String.raw`C:\Users\chase\Downloads\3079b3bd-4922-44f7-be08-9f13fe7a3c32.csv`;
  const outDir = path.join(__dirname, '..', 'src', 'lib');
  const reportPath = path.join(__dirname, 'forecast-report.txt');

  // Parse CSV
  const rows = parseCSV(csvPath);

  // Aggregate
  console.log('\nAggregating demand...');
  const { dailyDemand, matched, unmatched, skippedZero, unmatchedCounts } = aggregateDemand(rows);

  const totalProcessed = matched + unmatched;
  const matchRate = totalProcessed > 0 ? (matched / totalProcessed * 100).toFixed(1) : 0;
  console.log(`Matched units: ${matched}`);
  console.log(`Unmatched units: ${unmatched}`);
  console.log(`Skipped (qty <= 0): ${skippedZero}`);
  console.log(`Match rate: ${matchRate}%`);
  console.log(`Catalog SKUs with data: ${Object.keys(dailyDemand).length}`);

  // Compute forecasts
  console.log('\nComputing forecasts...');
  const forecasts = [];
  for (const catItem of CATALOG) {
    const series = dailyDemand[catItem.sku];
    if (!series) continue;
    const fc = computeForecast(series, catItem.sku, catItem.id);
    if (fc) forecasts.push(fc);
  }

  // Sort by forecasted demand descending
  forecasts.sort((a, b) => b.forecastedDemand30d - a.forecastedDemand30d);

  console.log(`Forecasts computed for ${forecasts.length} SKUs`);

  // --- Write forecast-data.ts ---
  const today = new Date().toISOString().slice(0, 10);
  let tsContent = `// Auto-generated by scripts/build-forecast.js
// Last updated: ${today}

export interface SKUForecast {
  catalogSkuId: string;
  sku: string;
  forecastedDemand30d: number;  // units for next 30 days
  lowerBound: number;
  upperBound: number;
  ewmaDaily: number;           // smoothed daily rate
  seasonalIndex: number;       // for current month
  trendMultiplier: number;     // 1.0 = flat
  dataPoints: number;          // days of history available
  lastSaleDate: string;
}

export const skuForecasts: SKUForecast[] = [\n`;

  for (const fc of forecasts) {
    tsContent += `  { catalogSkuId: "${fc.catalogSkuId}", sku: "${fc.sku}", forecastedDemand30d: ${fc.forecastedDemand30d}, lowerBound: ${fc.lowerBound}, upperBound: ${fc.upperBound}, ewmaDaily: ${fc.ewmaDaily}, seasonalIndex: ${fc.seasonalIndex}, trendMultiplier: ${fc.trendMultiplier}, dataPoints: ${fc.dataPoints}, lastSaleDate: "${fc.lastSaleDate}" },\n`;
  }

  tsContent += `];

// Lookup by catalog SKU ID
export function getForecast(catalogSkuId: string): SKUForecast | undefined {
  return skuForecasts.find(f => f.catalogSkuId === catalogSkuId);
}
`;

  const tsPath = path.join(outDir, 'forecast-data.ts');
  fs.writeFileSync(tsPath, tsContent, 'utf-8');
  console.log(`\nWrote: ${tsPath}`);

  // --- Write forecast-report.txt ---
  const topUnmatched = Object.entries(unmatchedCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  let report = '';
  report += '='.repeat(80) + '\n';
  report += 'FREEZE PIPE DEMAND FORECAST REPORT\n';
  report += `Generated: ${today}\n`;
  report += '='.repeat(80) + '\n\n';

  report += '--- SKU MAPPING STATISTICS ---\n';
  report += `Total data rows:       ${rows.length}\n`;
  report += `Matched units:         ${matched}\n`;
  report += `Unmatched units:       ${unmatched}\n`;
  report += `Skipped (qty <= 0):    ${skippedZero}\n`;
  report += `Match rate:            ${matchRate}%\n`;
  report += `Catalog SKUs w/ data:  ${Object.keys(dailyDemand).length} / ${CATALOG.length}\n\n`;

  report += '--- TOP 20 UNMATCHED SKUs (by volume) ---\n';
  report += 'SKU'.padEnd(45) + 'Units\n';
  report += '-'.repeat(55) + '\n';
  for (const [sku, count] of topUnmatched) {
    report += sku.padEnd(45) + String(count) + '\n';
  }
  report += '\n';

  report += '--- FORECAST BY SKU (sorted by 30d forecast, descending) ---\n';
  report += 'SKU'.padEnd(22) + 'Cur Monthly'.padStart(12) + '  30d Fcst'.padStart(10) + '  Seasonal'.padStart(10) + '   Trend'.padStart(8) + '  Days\n';
  report += '-'.repeat(72) + '\n';

  for (const fc of forecasts) {
    // Compute "current monthly" as the last 30 days actual
    const series = dailyDemand[fc.sku];
    let last30Actual = 0;
    if (series) {
      const allDates = Object.keys(series).sort();
      const cutoff = allDates.length > 0 ? allDates[allDates.length - 1] : '';
      const cutoffMs = new Date(cutoff + 'T00:00:00Z').getTime();
      for (const [d, v] of Object.entries(series)) {
        const dMs = new Date(d + 'T00:00:00Z').getTime();
        if (dMs > cutoffMs - 30 * 86400000) {
          last30Actual += v;
        }
      }
    }

    report += fc.sku.padEnd(22)
      + String(last30Actual).padStart(12)
      + String(fc.forecastedDemand30d).padStart(10)
      + ('  ' + fc.seasonalIndex.toFixed(2)).padStart(10)
      + ('  ' + fc.trendMultiplier.toFixed(2)).padStart(8)
      + String(fc.dataPoints).padStart(6)
      + '\n';
  }

  fs.writeFileSync(reportPath, report, 'utf-8');
  console.log(`Wrote: ${reportPath}`);

  console.log('\nDone!');
}

main();
