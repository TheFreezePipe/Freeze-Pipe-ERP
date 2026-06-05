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
  ["bong xl", "NB2"],
  ["bong-xl", "NB2"],
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
  ["ds-bong-xl", "NB2"],
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
  ["ws-fpbongxl", "NB2"],
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
// 6. CATEGORY MAP — extracted from src/lib/demo-data.ts
// ============================================================
const CATEGORY_MAP = {
  "1": "Pipes", "2": "Pipes", "3": "Pipes", "4": "Pipes", "5": "Pipes", "6": "Pipes",
  "7": "Bubblers", "8": "Bubblers",
  "9": "Joint Chiller", "10": "Joint Chiller", "11": "Joint Chiller", "12": "Joint Chiller",
  "13": "Bongs", "14": "Bongs", "15": "Bongs", "16": "Bongs", "17": "Bongs", "18": "Bongs",
  "19": "Bongs", "20": "Bongs", "21": "Bongs", "22": "Bongs", "23": "Bongs", "24": "Bongs",
  "25": "Bongs", "26": "Bongs",
  "27": "Studio", "28": "Studio", "29": "Studio", "30": "Studio",
  "31": "Dab Rigs", "32": "Dab Rigs", "33": "Dab Rigs", "34": "Dab Rigs", "35": "Dab Rigs",
  "36": "Accessories", "37": "Accessories", "38": "Accessories",
  "39": "Ash Catchers", "40": "Ash Catchers", "41": "Ash Catchers",
  "42": "Ash Catchers", "43": "Ash Catchers", "44": "Ash Catchers",
  "45": "Bowls", "46": "Bowls", "47": "Bowls", "48": "Bowls", "49": "Bowls",
  "50": "Bowls", "51": "Bowls", "52": "Bowls", "53": "Bowls", "54": "Bowls",
  "55": "Bowls", "56": "Bowls", "57": "Bowls", "58": "Bowls", "59": "Bowls",
  "60": "Bowls", "61": "Bowls",
  "62": "Accessories", "63": "Accessories", "64": "Accessories", "65": "Accessories",
  "66": "Accessories", "67": "Accessories", "68": "Accessories", "69": "Accessories",
  "70": "Accessories", "71": "Accessories", "72": "Accessories", "73": "Accessories",
  "74": "Accessories", "75": "Accessories", "76": "Accessories", "77": "Accessories",
  "78": "Accessories", "79": "Accessories", "80": "Accessories", "81": "Accessories",
  "82": "Accessories", "83": "Accessories", "84": "Accessories", "85": "Accessories",
  "86": "Accessories", "87": "Accessories", "88": "Accessories", "89": "Accessories",
  "90": "Accessories", "91": "Accessories", "92": "Accessories", "93": "Accessories",
  "94": "Coils", "95": "Coils", "96": "Coils", "97": "Coils", "98": "Coils",
  "99": "Coils", "100": "Coils", "101": "Coils", "102": "Coils", "103": "Coils",
  "104": "Coils", "105": "Coils", "106": "Coils", "107": "Coils", "108": "Coils",
  "109": "Coils", "110": "Coils", "111": "Coils", "112": "Coils",
  "113": "Bases", "114": "Bases", "115": "Bases", "116": "Bases", "117": "Bases",
  "118": "Bases", "119": "Bases", "120": "Bases", "121": "Bases", "122": "Bases",
  "123": "Bases", "124": "Bases", "125": "Bases", "126": "Bases", "127": "Bases", "128": "Bases",
};

// ============================================================
// 7. FORECAST HELPERS
// ============================================================

const DAY_MS = 86400000;

/** Build a contiguous daily array from a { dateStr: units } series */
function buildDailyArray(dailySeries) {
  const dates = Object.keys(dailySeries).sort();
  if (dates.length === 0) return { dailyArray: [], dateArray: [], lastDate: '', firstDate: '' };
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const startMs = new Date(firstDate + 'T00:00:00Z').getTime();
  const endMs = new Date(lastDate + 'T00:00:00Z').getTime();
  const totalDays = Math.round((endMs - startMs) / DAY_MS) + 1;
  const dailyArray = new Array(totalDays).fill(0);
  const dateArray = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startMs + i * DAY_MS);
    const ds = d.toISOString().slice(0, 10);
    dateArray.push(ds);
    dailyArray[i] = dailySeries[ds] || 0;
  }
  return { dailyArray, dateArray, lastDate, firstDate };
}

/** Get ISO week number (1-52) from a YYYY-MM-DD string */
function getISOWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayOfYear = Math.floor((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / DAY_MS) + 1;
  return Math.min(52, Math.ceil(dayOfYear / 7));
}

/** Simple linear regression. Returns { slope, intercept, rSquared } */
function linearRegression(ys) {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] || 0, rSquared: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += ys[i]; sumXY += i * ys[i]; sumX2 += i * i; sumY2 += ys[i] * ys[i];
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n, rSquared: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const yMean = sumY / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (ys[i] - yMean) ** 2;
    ssRes += (ys[i] - (intercept + slope * i)) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, rSquared };
}

/** Load overrides from forecast-overrides.json */
function loadOverrides() {
  const overridePath = path.join(__dirname, 'forecast-overrides.json');
  try {
    return JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
  } catch (e) {
    console.warn('No forecast-overrides.json found, using defaults');
    return { version: 1, overrides: {}, events: [] };
  }
}

// ============================================================
// 8. STAGE 1 — EVENT CALENDAR + BASELINE EXTRACTION
// ============================================================

/** Build boolean mask: true = known event/promo day */
function buildEventMask(dateArray, events) {
  const mask = new Array(dateArray.length).fill(false);
  // Only mask events explicitly flagged as promotional (mask: true).
  // Recurring seasonal events (holidays, 4/20) should NOT be masked —
  // they are the seasonality the model needs to capture.
  const maskableEvents = events.filter(evt => evt.mask === true);
  for (let i = 0; i < dateArray.length; i++) {
    const mmdd = dateArray[i].slice(5); // "MM-DD"
    for (const evt of maskableEvents) {
      if (evt.recurring) {
        if (mmdd >= evt.startMMDD && mmdd <= evt.endMMDD) {
          mask[i] = true;
          break;
        }
        if (evt.startMMDD > evt.endMMDD && (mmdd >= evt.startMMDD || mmdd <= evt.endMMDD)) {
          mask[i] = true;
          break;
        }
      }
    }
  }
  return mask;
}

/** Extract baseline by removing spikes (IQR-based) and event-period data.
 *  Returns { baseline, spikeFlags } where baseline has flagged days replaced
 *  with interpolated local values. */
function extractBaseline(dailyArray, dateArray, eventMask) {
  const n = dailyArray.length;
  const flags = new Array(n).fill(false); // true = flagged as spike/event
  const baseline = [...dailyArray];

  // Mark event days
  for (let i = 0; i < n; i++) {
    if (eventMask[i]) flags[i] = true;
  }

  // IQR-based anomaly detection on non-event days
  const WINDOW = 21;
  for (let i = WINDOW; i < n; i++) {
    if (flags[i]) continue; // already flagged as event
    // Collect non-flagged values in the trailing window
    const windowVals = [];
    for (let j = Math.max(0, i - WINDOW); j < i; j++) {
      if (!flags[j]) windowVals.push(dailyArray[j]);
    }
    if (windowVals.length < 7) continue; // not enough context
    windowVals.sort((a, b) => a - b);
    const q1 = windowVals[Math.floor(windowVals.length * 0.25)];
    const q3 = windowVals[Math.floor(windowVals.length * 0.75)];
    const iqr = q3 - q1;
    const upperFence = q3 + 2.0 * iqr;
    if (upperFence > 0 && dailyArray[i] > upperFence) {
      flags[i] = true;
    }
  }

  // Replace flagged days with local baseline (rolling median of non-flagged neighbors)
  for (let i = 0; i < n; i++) {
    if (!flags[i]) continue;
    const neighbors = [];
    for (let j = Math.max(0, i - 14); j <= Math.min(n - 1, i + 14); j++) {
      if (!flags[j]) neighbors.push(dailyArray[j]);
    }
    if (neighbors.length > 0) {
      neighbors.sort((a, b) => a - b);
      baseline[i] = neighbors[Math.floor(neighbors.length / 2)];
    } else {
      baseline[i] = 0;
    }
  }

  return { baseline, spikeFlags: flags };
}

// ============================================================
// 9. STAGE 2 — CATEGORY-LEVEL WEEKLY SEASONAL INDICES (detrended)
// ============================================================

/** Compute weekly seasonal indices for a category's pooled daily series.
 *  Uses detrending to handle rapid company growth.
 *  Returns: object { weekNumber(1-52): seasonalIndex } */
function computeCategoryWeeklySeasonal(catDailyArray, catDateArray) {
  const n = catDailyArray.length;
  if (n < 90) {
    // Not enough data — return neutral
    const result = {};
    for (let w = 1; w <= 52; w++) result[w] = 1.0;
    return result;
  }

  // Step 1: Compute centered 90-day moving average as local trend
  const trend = new Array(n).fill(0);
  const halfWin = 45;
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - halfWin); j <= Math.min(n - 1, i + halfWin); j++) {
      sum += catDailyArray[j];
      count++;
    }
    trend[i] = count > 0 ? sum / count : 1;
  }

  // Step 2: Detrend using ratio (multiplicative seasonal model)
  const detrended = new Array(n).fill(1.0);
  for (let i = 0; i < n; i++) {
    detrended[i] = trend[i] > 0.1 ? catDailyArray[i] / trend[i] : 1.0;
  }

  // Step 3: Group detrended values by ISO week
  const weekBuckets = {}; // week -> { sum, count, yearsSet }
  for (let i = 0; i < n; i++) {
    const week = getISOWeek(catDateArray[i]);
    const year = catDateArray[i].slice(0, 4);
    if (!weekBuckets[week]) weekBuckets[week] = { sum: 0, count: 0, years: new Set() };
    weekBuckets[week].sum += detrended[i];
    weekBuckets[week].count++;
    weekBuckets[week].years.add(year);
  }

  // Step 4: Compute raw seasonal index per week
  const rawSeasonal = {};
  for (let w = 1; w <= 52; w++) {
    if (weekBuckets[w] && weekBuckets[w].count >= 7 && weekBuckets[w].years.size >= 1) {
      rawSeasonal[w] = weekBuckets[w].sum / weekBuckets[w].count;
    } else {
      rawSeasonal[w] = 1.0;
    }
  }

  // Step 5: Normalize so mean = 1.0
  let rawSum = 0;
  for (let w = 1; w <= 52; w++) rawSum += rawSeasonal[w];
  const rawMean = rawSum / 52;
  const seasonal = {};
  for (let w = 1; w <= 52; w++) {
    seasonal[w] = rawMean > 0 ? rawSeasonal[w] / rawMean : 1.0;
  }

  // Step 6: 3-week centered moving average to smooth noise
  const smoothed = {};
  for (let w = 1; w <= 52; w++) {
    const prev = w === 1 ? 52 : w - 1;
    const next = w === 52 ? 1 : w + 1;
    smoothed[w] = (seasonal[prev] + seasonal[w] + seasonal[next]) / 3;
  }

  return smoothed;
}

// ============================================================
// 10. STAGE 3 — CATEGORY-LEVEL DAMPED TREND
// ============================================================

/** Compute damped trend multiplier for a category.
 *  Uses last 6 months of monthly totals with damping toward 1.0. */
function computeCategoryTrend(catDailyBaseline, catDateArray) {
  // Group last 6 months into monthly totals
  const n = catDailyBaseline.length;
  const cutoffIdx = Math.max(0, n - 180); // ~6 months
  const monthTotals = {};
  for (let i = cutoffIdx; i < n; i++) {
    const ym = catDateArray[i].slice(0, 7);
    monthTotals[ym] = (monthTotals[ym] || 0) + catDailyBaseline[i];
  }

  const keys = Object.keys(monthTotals).sort();
  // Exclude the last (likely incomplete) month
  if (keys.length > 1) {
    const lastMonth = keys[keys.length - 1];
    const lastMonthDays = catDateArray.filter(d => d.startsWith(lastMonth)).length;
    if (lastMonthDays < 20) keys.pop();
  }

  if (keys.length < 3) return { trend: 1.0, rSquared: 0 };

  const ys = keys.map(k => monthTotals[k]);
  const { slope, rSquared } = linearRegression(ys);

  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  if (yMean <= 0) return { trend: 1.0, rSquared: 0 };

  const monthlyPctChange = slope / yMean;
  const DAMPING = 0.85;
  let dampedTrend = 1 + monthlyPctChange * DAMPING;

  // Low R² → reduce confidence in trend direction
  if (rSquared < 0.3) {
    dampedTrend = 1 + (dampedTrend - 1) * 0.5;
  }

  // Soft bounds (much wider than the old ±20%)
  dampedTrend = Math.max(0.50, Math.min(1.60, dampedTrend));

  return { trend: dampedTrend, rSquared };
}

// ============================================================
// 11. STAGE 4 — ADAPTIVE EWMA
// ============================================================

/** Compute EWMA with adaptive alpha based on coefficient of variation.
 *  Runs on last 90 days of the baseline series. */
function computeAdaptiveEWMA(baseline, dateArray, seasonalIndices) {
  const n = baseline.length;
  const last90Start = Math.max(0, n - 90);
  // Deseasonalize before EWMA to prevent double-counting when seasonal is applied
  const window = [];
  for (let i = last90Start; i < n; i++) {
    const wk = dateArray ? getISOWeek(dateArray[i]) : 0;
    const si = (seasonalIndices && seasonalIndices[wk]) || 1.0;
    window.push(si > 0.1 ? baseline[i] / si : baseline[i]);
  }
  const wLen = window.length;
  if (wLen === 0) return { ewma: 0, alpha: 0.15, cv: 0 };

  // Coefficient of variation
  const mean = window.reduce((a, b) => a + b, 0) / wLen;
  let variance = 0;
  for (let i = 0; i < wLen; i++) variance += (window[i] - mean) ** 2;
  variance /= wLen;
  const stddev = Math.sqrt(variance);
  const cv = mean > 0 ? stddev / mean : 1.0;

  // Adaptive alpha: volatile → higher alpha (faster response)
  const alpha = Math.max(0.05, Math.min(0.40, 0.05 + 0.15 * cv));

  // Run EWMA on deseasonalized data
  let ewma = window[0];
  for (let i = 1; i < wLen; i++) {
    ewma = alpha * window[i] + (1 - alpha) * ewma;
  }

  return { ewma: Math.max(0, ewma), alpha, cv };
}

// ============================================================
// 12. STAGE 7 — COLD-START BAYESIAN BLEND
// ============================================================

function getLaunchCurveFactor(daysActive) {
  if (daysActive <= 7) return 0.50;
  if (daysActive <= 14) return 0.65;
  if (daysActive <= 30) return 0.80;
  if (daysActive <= 60) return 0.90;
  return 1.0;
}

// ============================================================
// 13. STAGE 8 — CROSTON'S METHOD (intermittent demand)
// ============================================================

/** Croston's method for SKUs with >40% zero-demand days.
 *  Returns { dailyRate, method } or null if not applicable. */
function crostonForecast(dailyArray) {
  const n = dailyArray.length;
  if (n < 30) return null;

  const last90 = dailyArray.slice(Math.max(0, n - 90));
  const zeroPct = last90.filter(v => v === 0).length / last90.length;
  if (zeroPct <= 0.40) return null; // not intermittent

  // Extract non-zero demands and intervals
  const demands = [];
  const intervals = [];
  let daysSinceLast = 0;
  for (let i = 0; i < last90.length; i++) {
    daysSinceLast++;
    if (last90[i] > 0) {
      demands.push(last90[i]);
      if (demands.length > 1) intervals.push(daysSinceLast);
      daysSinceLast = 0;
    }
  }

  if (demands.length < 5) return null; // not enough demand events

  // Smooth demand sizes
  const alpha = 0.15;
  let smoothedSize = demands[0];
  for (let i = 1; i < demands.length; i++) {
    smoothedSize = alpha * demands[i] + (1 - alpha) * smoothedSize;
  }

  // Smooth inter-demand intervals
  let smoothedInterval = intervals[0] || 7;
  for (let i = 1; i < intervals.length; i++) {
    smoothedInterval = alpha * intervals[i] + (1 - alpha) * smoothedInterval;
  }

  const dailyRate = smoothedInterval > 0 ? smoothedSize / smoothedInterval : 0;
  return { dailyRate: Math.max(0, dailyRate), zeroPct };
}

// ============================================================
// 14. STAGE 10 — DATA-DRIVEN CONFIDENCE INTERVALS
// ============================================================

/** Compute confidence intervals from historical forecast error variance. */
function computeConfidenceInterval(forecast30d, baseline, daysOfHistory) {
  if (daysOfHistory < 60 || forecast30d <= 0) {
    return { lower: Math.round(forecast30d * 0.65), upper: Math.round(forecast30d * 1.45) };
  }

  // Walk through history computing rolling 30-day prediction errors
  const errors = [];
  const step = 30;
  for (let i = 60; i <= daysOfHistory - step; i += step) {
    // What EWMA would have predicted at day i
    const windowStart = Math.max(0, i - 90);
    const window = baseline.slice(windowStart, i);
    if (window.length < 30) continue;
    let localEwma = window[0];
    for (let j = 1; j < window.length; j++) {
      localEwma = 0.15 * window[j] + 0.85 * localEwma;
    }
    const predicted = localEwma * step;
    const actual = baseline.slice(i, i + step).reduce((a, b) => a + b, 0);
    if (actual > 0) {
      errors.push((predicted - actual) / actual);
    }
  }

  if (errors.length < 3) {
    return { lower: Math.round(forecast30d * 0.70), upper: Math.round(forecast30d * 1.35) };
  }

  const errMean = errors.reduce((a, b) => a + b, 0) / errors.length;
  let errVar = 0;
  for (const e of errors) errVar += (e - errMean) ** 2;
  const errStdDev = Math.sqrt(errVar / errors.length);

  // 80% CI: ±1.28 standard deviations
  const lower = Math.round(forecast30d * Math.max(0.50, 1 - 1.28 * errStdDev));
  const upper = Math.round(forecast30d * (1 + 1.28 * errStdDev));

  return { lower, upper, residualStdDev: Math.round(errStdDev * 1000) / 1000 };
}

// ============================================================
// 15. MAIN PIPELINE
// ============================================================

function main() {
  const csvPath = process.argv[2] || String.raw`C:\Users\chase\Downloads\3079b3bd-4922-44f7-be08-9f13fe7a3c32.csv`;
  const outDir = path.join(__dirname, '..', 'src', 'lib');
  const reportPath = path.join(__dirname, 'forecast-report.txt');

  // ---- Parse & Aggregate (existing, unchanged) ----
  const rows = parseCSV(csvPath);
  console.log('\nAggregating demand...');
  const { dailyDemand, matched, unmatched, skippedZero, unmatchedCounts } = aggregateDemand(rows);

  const totalProcessed = matched + unmatched;
  const matchRate = totalProcessed > 0 ? (matched / totalProcessed * 100).toFixed(1) : 0;
  console.log(`Matched units: ${matched}`);
  console.log(`Unmatched units: ${unmatched}`);
  console.log(`Skipped (qty <= 0): ${skippedZero}`);
  console.log(`Match rate: ${matchRate}%`);
  console.log(`Catalog SKUs with data: ${Object.keys(dailyDemand).length}`);

  // ---- Load overrides ----
  const overridesConfig = loadOverrides();
  const events = overridesConfig.events || [];
  const skuOverrides = overridesConfig.overrides || {};

  // ---- Validate CATEGORY_MAP ----
  for (const catItem of CATALOG) {
    if (!CATEGORY_MAP[catItem.id]) {
      console.warn(`WARNING: Catalog ID ${catItem.id} (${catItem.sku}) missing from CATEGORY_MAP`);
    }
  }

  // ---- Build per-SKU data structures ----
  console.log('\nBuilding per-SKU daily arrays...');
  const skuData = {}; // sku -> { dailyArray, dateArray, baseline, spikeFlags, lastDate, dataPoints, catalogId, category }
  for (const catItem of CATALOG) {
    const series = dailyDemand[catItem.sku];
    if (!series) continue;
    const { dailyArray, dateArray, lastDate, firstDate } = buildDailyArray(series);
    if (dailyArray.length === 0) continue;
    const eventMask = buildEventMask(dateArray, events);
    const { baseline, spikeFlags } = extractBaseline(dailyArray, dateArray, eventMask);
    skuData[catItem.sku] = {
      dailyArray, dateArray, baseline, spikeFlags, lastDate, firstDate,
      dataPoints: dailyArray.length,
      catalogId: catItem.id,
      category: CATEGORY_MAP[catItem.id] || 'Unknown',
    };
  }
  console.log(`Processed ${Object.keys(skuData).length} SKUs`);

  // ---- Determine forecast date context ----
  let globalLastDate = '2000-01-01';
  for (const sd of Object.values(skuData)) {
    if (sd.lastDate > globalLastDate) globalLastDate = sd.lastDate;
  }
  const forecastWeek = getISOWeek(globalLastDate);
  console.log(`Forecast reference date: ${globalLastDate} (week ${forecastWeek})`);

  // ---- Group SKUs by category ----
  const categorySkus = {}; // category -> [sku, sku, ...]
  for (const [sku, sd] of Object.entries(skuData)) {
    const cat = sd.category;
    if (!categorySkus[cat]) categorySkus[cat] = [];
    categorySkus[cat].push(sku);
  }

  // ---- STAGE 2: Category-level weekly seasonal indices ----
  console.log('\nComputing category-level seasonal indices...');
  const categorySeasonals = {}; // category -> { 1: idx, 2: idx, ..., 52: idx }
  const categoryDailyPooled = {}; // category -> { dailyArray, dateArray }

  for (const [cat, skus] of Object.entries(categorySkus)) {
    // Pool all SKU baseline series into a single category daily series
    // Need a common date range: earliest to latest across all SKUs
    let minDate = '9999-12-31', maxDate = '0000-01-01';
    for (const sku of skus) {
      if (skuData[sku].firstDate < minDate) minDate = skuData[sku].firstDate;
      if (skuData[sku].lastDate > maxDate) maxDate = skuData[sku].lastDate;
    }
    const startMs = new Date(minDate + 'T00:00:00Z').getTime();
    const endMs = new Date(maxDate + 'T00:00:00Z').getTime();
    const totalDays = Math.round((endMs - startMs) / DAY_MS) + 1;

    const catDaily = new Array(totalDays).fill(0);
    const catDates = [];
    for (let i = 0; i < totalDays; i++) {
      catDates.push(new Date(startMs + i * DAY_MS).toISOString().slice(0, 10));
    }

    // Sum all SKU baselines into category daily (aligned by date)
    for (const sku of skus) {
      const sd = skuData[sku];
      const skuStartMs = new Date(sd.firstDate + 'T00:00:00Z').getTime();
      const offset = Math.round((skuStartMs - startMs) / DAY_MS);
      for (let i = 0; i < sd.baseline.length; i++) {
        catDaily[offset + i] += sd.baseline[i];
      }
    }

    categoryDailyPooled[cat] = { dailyArray: catDaily, dateArray: catDates };
    categorySeasonals[cat] = computeCategoryWeeklySeasonal(catDaily, catDates);
  }

  // ---- STAGE 3: Category-level damped trend ----
  console.log('Computing category-level trends...');
  const categoryTrends = {}; // category -> { trend, rSquared }
  for (const [cat, pooled] of Object.entries(categoryDailyPooled)) {
    categoryTrends[cat] = computeCategoryTrend(pooled.dailyArray, pooled.dateArray);
  }

  // ---- STAGE 4: Adaptive EWMA per SKU ----
  console.log('Computing per-SKU adaptive EWMA...');
  const skuEwmaResults = {}; // sku -> { ewma, alpha, cv }
  for (const [sku, sd] of Object.entries(skuData)) {
    skuEwmaResults[sku] = computeAdaptiveEWMA(sd.baseline, sd.dateArray, categorySeasonals[sd.category]);
  }

  // ---- STAGE 5-6: Category forecast → SKU allocation ----
  console.log('Computing category forecasts and SKU allocations...\n');
  const forecasts = [];

  for (const [cat, skus] of Object.entries(categorySkus)) {
    // Average seasonal index across the next 4 weeks (30-day forecast horizon)
    const si = categorySeasonals[cat];
    let catSeasonal = 0;
    for (let w = 0; w < 4; w++) {
      const wk = ((forecastWeek - 1 + w) % 52) + 1;
      catSeasonal += (si[wk] || 1.0);
    }
    catSeasonal /= 4;
    const catTrendResult = categoryTrends[cat] || { trend: 1.0, rSquared: 0 };
    const catTrend = catTrendResult.trend;

    // Sum all SKU EWMA daily rates for category total
    let catEwmaTotal = 0;
    for (const sku of skus) {
      catEwmaTotal += skuEwmaResults[sku].ewma;
    }

    // Category forecast
    const catForecast30d = Math.max(0, catEwmaTotal * 30 * catSeasonal * catTrend);

    // Per-SKU allocation
    for (const sku of skus) {
      const sd = skuData[sku];
      const ewmaResult = skuEwmaResults[sku];
      const ewmaDaily = ewmaResult.ewma;

      // Velocity share
      const velocityShare = catEwmaTotal > 0 ? ewmaDaily / catEwmaTotal : 0;

      // Check for intermittent demand (Croston's)
      const crostonResult = crostonForecast(sd.dailyArray);

      // Determine forecast method and compute
      let forecast30d, method;
      const daysOfData = sd.dataPoints;

      if (crostonResult && daysOfData >= 90) {
        // Stage 8: Croston's for intermittent demand
        forecast30d = Math.round(crostonResult.dailyRate * 30 * catSeasonal * catTrend);
        method = 'croston';
      } else if (daysOfData < 90) {
        // Stage 7: Cold-start Bayesian blend
        const skuWeight = Math.min(daysOfData / 90, 0.7);
        const catWeight = 1 - skuWeight;
        const catAvgDaily = skus.length > 0 ? catEwmaTotal / skus.length : 0;
        const blendedDaily = skuWeight * ewmaDaily + catWeight * catAvgDaily;
        const launchFactor = getLaunchCurveFactor(daysOfData);
        forecast30d = Math.round(blendedDaily * 30 * catSeasonal * catTrend * launchFactor);
        method = 'cold_start';
      } else {
        // Standard: category forecast × velocity share
        forecast30d = Math.round(catForecast30d * velocityShare);
        method = 'category_alloc';
      }

      forecast30d = Math.max(0, forecast30d);

      // SKU-level trend blending (for SKUs with enough data)
      let skuTrend = catTrend;
      if (daysOfData >= 180) {
        const skuTrendResult = computeCategoryTrend(sd.baseline, sd.dateArray);
        // Blend: 60% category, 40% SKU
        skuTrend = catTrend * 0.6 + skuTrendResult.trend * 0.4;
        // Re-apply the blended trend (remove cat trend, apply blended)
        if (catTrend > 0) {
          forecast30d = Math.round(forecast30d * (skuTrend / catTrend));
        }
      }

      // Confidence intervals
      const ci = computeConfidenceInterval(forecast30d, sd.baseline, daysOfData);

      // Zero-day percentage
      const last90 = sd.dailyArray.slice(Math.max(0, sd.dailyArray.length - 90));
      const zeroPct = last90.length > 0
        ? Math.round(last90.filter(v => v === 0).length / last90.length * 100)
        : 0;

      forecasts.push({
        catalogSkuId: sd.catalogId,
        sku,
        forecastedDemand30d: forecast30d,
        lowerBound: ci.lower,
        upperBound: ci.upper,
        ewmaDaily: Math.round(ewmaDaily * 1000) / 1000,
        seasonalIndex: Math.round(catSeasonal * 1000) / 1000,
        trendMultiplier: Math.round(skuTrend * 1000) / 1000,
        dataPoints: daysOfData,
        lastSaleDate: sd.lastDate,
        // New fields
        category: cat,
        forecastMethod: method,
        categorySeasonalIndex: Math.round(catSeasonal * 1000) / 1000,
        blendWeight: daysOfData < 90 ? Math.round(Math.min(daysOfData / 90, 0.7) * 100) / 100 : 1.0,
        residualStdDev: ci.residualStdDev || 0,
        zeroDayPct: zeroPct,
        isOverridden: false,
        velocityShare: Math.round(velocityShare * 10000) / 100, // as percentage
      });
    }
  }

  // ---- STAGE 9: Override application ----
  console.log('Applying overrides...');
  let overrideCount = 0;
  for (const fc of forecasts) {
    const override = skuOverrides[fc.sku];
    if (!override) continue;
    overrideCount++;
    fc.isOverridden = true;

    switch (override.type) {
      case 'seasonal_neutralize':
        // Recompute with seasonal = 1.0
        if (fc.seasonalIndex !== 0) {
          fc.forecastedDemand30d = Math.round(fc.forecastedDemand30d / fc.seasonalIndex);
        }
        fc.seasonalIndex = 1.0;
        fc.categorySeasonalIndex = 1.0;
        break;
      case 'demand_cap':
        fc.forecastedDemand30d = Math.min(fc.forecastedDemand30d, override.value);
        break;
      case 'demand_floor':
        fc.forecastedDemand30d = Math.max(fc.forecastedDemand30d, override.value);
        break;
      case 'manual_forecast':
        fc.forecastedDemand30d = override.value;
        break;
    }

    // Recompute bounds after override
    const ci = computeConfidenceInterval(fc.forecastedDemand30d, [], 0);
    fc.lowerBound = ci.lower;
    fc.upperBound = ci.upper;
  }
  console.log(`Applied ${overrideCount} override(s)`);

  // Sort by forecasted demand descending
  forecasts.sort((a, b) => b.forecastedDemand30d - a.forecastedDemand30d);
  console.log(`\nForecasts computed for ${forecasts.length} SKUs`);

  // ---- Write forecast-data.ts ----
  const today = new Date().toISOString().slice(0, 10);
  let tsContent = `// Auto-generated by scripts/build-forecast.js — Enterprise Forecast Engine v2
// Last updated: ${today}
// Algorithm: Middle-out hierarchical (category → SKU), detrended weekly seasonal,
//            adaptive EWMA, Bayesian cold-start, Croston's intermittent, damped trend

export interface SKUForecast {
  catalogSkuId: string;
  sku: string;
  forecastedDemand30d: number;     // units for next 30 days
  lowerBound: number;
  upperBound: number;
  ewmaDaily: number;               // adaptive-alpha smoothed daily rate
  seasonalIndex: number;           // category-level weekly seasonal for forecast week
  trendMultiplier: number;         // damped category-blended trend
  dataPoints: number;              // days of history available
  lastSaleDate: string;
  // Extended fields
  category?: string;               // display_category
  forecastMethod?: string;         // "category_alloc" | "croston" | "cold_start"
  categorySeasonalIndex?: number;  // category-level weekly seasonal used
  blendWeight?: number;            // SKU vs category weight (0=pure category, 1=pure SKU)
  residualStdDev?: number;         // forecast error std dev for CI
  zeroDayPct?: number;             // % of last 90 days with zero demand
  isOverridden?: boolean;          // true if override from forecast-overrides.json was applied
  velocityShare?: number;          // % of category demand this SKU represents
}

export const skuForecasts: SKUForecast[] = [\n`;

  for (const fc of forecasts) {
    const newFields = [];
    if (fc.category) newFields.push(`category: "${fc.category}"`);
    if (fc.forecastMethod) newFields.push(`forecastMethod: "${fc.forecastMethod}"`);
    if (fc.categorySeasonalIndex != null) newFields.push(`categorySeasonalIndex: ${fc.categorySeasonalIndex}`);
    if (fc.blendWeight != null) newFields.push(`blendWeight: ${fc.blendWeight}`);
    if (fc.residualStdDev) newFields.push(`residualStdDev: ${fc.residualStdDev}`);
    if (fc.zeroDayPct != null) newFields.push(`zeroDayPct: ${fc.zeroDayPct}`);
    if (fc.isOverridden) newFields.push(`isOverridden: true`);
    if (fc.velocityShare != null) newFields.push(`velocityShare: ${fc.velocityShare}`);
    const extra = newFields.length > 0 ? ', ' + newFields.join(', ') : '';
    tsContent += `  { catalogSkuId: "${fc.catalogSkuId}", sku: "${fc.sku}", forecastedDemand30d: ${fc.forecastedDemand30d}, lowerBound: ${fc.lowerBound}, upperBound: ${fc.upperBound}, ewmaDaily: ${fc.ewmaDaily}, seasonalIndex: ${fc.seasonalIndex}, trendMultiplier: ${fc.trendMultiplier}, dataPoints: ${fc.dataPoints}, lastSaleDate: "${fc.lastSaleDate}"${extra} },\n`;
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

  // ---- Write forecast-report.txt ----
  const topUnmatched = Object.entries(unmatchedCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  let report = '';
  report += '='.repeat(90) + '\n';
  report += 'FREEZE PIPE DEMAND FORECAST REPORT — Enterprise Engine v2\n';
  report += `Generated: ${today}  |  Forecast week: ${forecastWeek}  |  Reference date: ${globalLastDate}\n`;
  report += '='.repeat(90) + '\n\n';

  report += '--- SKU MAPPING STATISTICS ---\n';
  report += `Total data rows:       ${rows.length}\n`;
  report += `Matched units:         ${matched}\n`;
  report += `Unmatched units:       ${unmatched}\n`;
  report += `Skipped (qty <= 0):    ${skippedZero}\n`;
  report += `Match rate:            ${matchRate}%\n`;
  report += `Catalog SKUs w/ data:  ${Object.keys(dailyDemand).length} / ${CATALOG.length}\n`;
  report += `Overrides applied:     ${overrideCount}\n\n`;

  report += '--- CATEGORY SUMMARY ---\n';
  report += 'Category'.padEnd(18) + 'SKUs'.padStart(5) + '  Seasonal'.padStart(10) + '  Trend'.padStart(8) + '  R²'.padStart(6) + '   Cat 30d\n';
  report += '-'.repeat(60) + '\n';
  for (const [cat, skus] of Object.entries(categorySkus)) {
    const rsi = categorySeasonals[cat];
    let catSeasonal = 0;
    for (let w = 0; w < 4; w++) { const wk = ((forecastWeek - 1 + w) % 52) + 1; catSeasonal += (rsi[wk] || 1.0); }
    catSeasonal /= 4;
    const catTrend = categoryTrends[cat] || { trend: 1.0, rSquared: 0 };
    const catTotal = forecasts.filter(f => f.category === cat).reduce((s, f) => s + f.forecastedDemand30d, 0);
    report += cat.padEnd(18)
      + String(skus.length).padStart(5)
      + ('  ' + catSeasonal.toFixed(3)).padStart(10)
      + ('  ' + catTrend.trend.toFixed(3)).padStart(8)
      + ('  ' + catTrend.rSquared.toFixed(2)).padStart(6)
      + String(catTotal).padStart(10) + '\n';
  }
  report += '\n';

  report += '--- TOP 20 UNMATCHED SKUs (by volume) ---\n';
  report += 'SKU'.padEnd(45) + 'Units\n';
  report += '-'.repeat(55) + '\n';
  for (const [sku, count] of topUnmatched) {
    report += sku.padEnd(45) + String(count) + '\n';
  }
  report += '\n';

  report += '--- FORECAST BY SKU (sorted by 30d forecast, descending) ---\n';
  report += 'SKU'.padEnd(24) + 'Category'.padEnd(16) + 'Actual'.padStart(7) + '  Fcst'.padStart(7) + '  Ssnl'.padStart(7) + '  Trend'.padStart(7) + '  Share'.padStart(7) + '  Method'.padStart(14) + '\n';
  report += '-'.repeat(96) + '\n';

  for (const fc of forecasts) {
    const series = dailyDemand[fc.sku];
    let last30Actual = 0;
    if (series) {
      const allDates = Object.keys(series).sort();
      const cutoff = allDates.length > 0 ? allDates[allDates.length - 1] : '';
      const cutoffMs = new Date(cutoff + 'T00:00:00Z').getTime();
      for (const [d, v] of Object.entries(series)) {
        const dMs = new Date(d + 'T00:00:00Z').getTime();
        if (dMs > cutoffMs - 30 * DAY_MS) last30Actual += v;
      }
    }

    report += fc.sku.padEnd(24)
      + (fc.category || '').padEnd(16)
      + String(last30Actual).padStart(7)
      + String(fc.forecastedDemand30d).padStart(7)
      + ('  ' + fc.seasonalIndex.toFixed(2)).padStart(7)
      + ('  ' + fc.trendMultiplier.toFixed(2)).padStart(7)
      + (fc.velocityShare != null ? fc.velocityShare.toFixed(1) + '%' : '-').padStart(7)
      + ('  ' + (fc.forecastMethod || 'standard')).padStart(14)
      + (fc.isOverridden ? ' [OVERRIDE]' : '')
      + '\n';
  }

  fs.writeFileSync(reportPath, report, 'utf-8');
  console.log(`Wrote: ${reportPath}`);
  console.log('\nDone!');
}

// Export the resolver so the one-time sales_daily backfill can reuse the
// exact, tested SKU-resolution logic (legacy aliases, bundles, kits, base
// mapping) instead of reimplementing it. Only run main() when invoked
// directly (node build-forecast.cjs), not when required as a module.
module.exports = { resolveShipStationSku, catalogBySkuLower };
if (require.main === module) main();
