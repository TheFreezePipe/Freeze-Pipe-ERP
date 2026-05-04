import type {
  ProductSKU,
  InventoryLevel,
  FreightShipment,
  FreightLineItem,
  TaskLog,
  FactoryOrder,
  FactoryOrderItem,
  FactoryOrderFulfillment,
  FulfillmentStage,
} from "@/types/database";

const now = new Date().toISOString();

// Real product data - 128 SKUs
export const demoProducts: ProductSKU[] = [
  { id: "1", sku: "BW20", product_name: "Freeze Pipe", upc_code: null, category: "fillable", display_category: "Pipes", retail_price: 74.95, standard_quantity_per_carton: 12, abc_classification: "A", monthly_demand: 1200, is_active: true, created_at: "", updated_at: "" },
  { id: "2", sku: "BW20P", product_name: "Freeze Pipe Revolver", upc_code: null, category: "fillable", display_category: "Pipes", retail_price: 84.95, standard_quantity_per_carton: 12, abc_classification: "B", monthly_demand: 270, is_active: true, created_at: "", updated_at: "" },
  { id: "3", sku: "BW20DNA", product_name: "Freeze Pipe DNA", upc_code: null, category: "fillable", display_category: "Pipes", retail_price: 94.95, standard_quantity_per_carton: 12, abc_classification: "A", monthly_demand: 1300, is_active: true, created_at: "", updated_at: "" },
  { id: "4", sku: "BW30P", product_name: "Freeze Pipe Ultimate", upc_code: null, category: "fillable", display_category: "Pipes", retail_price: 94.95, standard_quantity_per_carton: 12, abc_classification: "C", monthly_demand: 45, is_active: true, created_at: "", updated_at: "" },
  { id: "5", sku: "bw64", product_name: "Freeze Pipe One Hitter", upc_code: null, category: "fillable", display_category: "Pipes", retail_price: 59.95, standard_quantity_per_carton: 12, abc_classification: "B", monthly_demand: 280, is_active: true, created_at: "", updated_at: "" },
  { id: "6", sku: "BW64P", product_name: "Freeze Pipe One-Hitter Pro", upc_code: null, category: "fillable", display_category: "Pipes", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: "B", monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "7", sku: "BW21P", product_name: "Freeze Pipe Bubbler Pro", upc_code: null, category: "fillable", display_category: "Bubblers", retail_price: 139.95, standard_quantity_per_carton: 12, abc_classification: "A", monthly_demand: 175, is_active: true, created_at: "", updated_at: "" },
  { id: "8", sku: "BW61", product_name: "Freeze Pipe Bubbler Ultimate (Part)", upc_code: null, category: "fillable", display_category: "Bubblers", retail_price: 39.95, standard_quantity_per_carton: 12, abc_classification: "C", monthly_demand: 65, is_active: true, created_at: "", updated_at: "" },
  { id: "9", sku: "BW40", product_name: "GBT", upc_code: null, category: "fillable", display_category: "Joint Chiller", retail_price: 49.95, standard_quantity_per_carton: 24, abc_classification: "A", monthly_demand: 170, is_active: true, created_at: "", updated_at: "" },
  { id: "10", sku: "BW40SP", product_name: "GBT Spiral", upc_code: null, category: "fillable", display_category: "Joint Chiller", retail_price: 69.95, standard_quantity_per_carton: 24, abc_classification: "A", monthly_demand: 330, is_active: true, created_at: "", updated_at: "" },
  { id: "11", sku: "BW60", product_name: "Joint Bubbler", upc_code: null, category: "fillable", display_category: "Joint Chiller", retail_price: 79.95, standard_quantity_per_carton: 24, abc_classification: "B", monthly_demand: 40, is_active: true, created_at: "", updated_at: "" },
  { id: "12", sku: "BW60U", product_name: "Joint Bubbler Ultimate", upc_code: null, category: "fillable", display_category: "Joint Chiller", retail_price: 99.95, standard_quantity_per_carton: 24, abc_classification: "A", monthly_demand: 90, is_active: true, created_at: "", updated_at: "" },
  { id: "13", sku: "NB2", product_name: "Freeze Pipe Bong Pro", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 209.95, standard_quantity_per_carton: 6, abc_classification: "A", monthly_demand: 130, is_active: true, created_at: "", updated_at: "" },
  { id: "14", sku: "NB3U", product_name: "Freeze Pipe Bong Ultimate", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 289.95, standard_quantity_per_carton: 6, abc_classification: "C", monthly_demand: 10, is_active: true, created_at: "", updated_at: "" },
  { id: "15", sku: "BW22", product_name: "Freeze Pipe Beaker Bong", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 139.95, standard_quantity_per_carton: 6, abc_classification: "A", monthly_demand: 165, is_active: true, created_at: "", updated_at: "" },
  { id: "16", sku: "BW22U", product_name: "Freeze Pipe Beaker Bong Ultimate", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 229.95, standard_quantity_per_carton: 6, abc_classification: "B", monthly_demand: 50, is_active: true, created_at: "", updated_at: "" },
  { id: "17", sku: "BW25", product_name: "Freeze Pipe Recycler Bong", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 224.95, standard_quantity_per_carton: 6, abc_classification: "C", monthly_demand: 10, is_active: true, created_at: "", updated_at: "" },
  { id: "18", sku: "BW58B", product_name: "Freeze Pipe Recycler Bong Pro", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 234.95, standard_quantity_per_carton: 6, abc_classification: "B", monthly_demand: 95, is_active: true, created_at: "", updated_at: "" },
  { id: "19", sku: "BW59", product_name: "Freeze Pipe Swiss Bong", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 214.95, standard_quantity_per_carton: 6, abc_classification: "C", monthly_demand: 15, is_active: true, created_at: "", updated_at: "" },
  { id: "20", sku: "BW62", product_name: "Freeze Pipe Combo", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 249.95, standard_quantity_per_carton: 6, abc_classification: "B", monthly_demand: 30, is_active: true, created_at: "", updated_at: "" },
  { id: "21", sku: "BW63", product_name: "Hookah Bong", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 299.95, standard_quantity_per_carton: 6, abc_classification: "B", monthly_demand: 35, is_active: true, created_at: "", updated_at: "" },
  { id: "22", sku: "NB4", product_name: "Straight Tube Bong", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 149.95, standard_quantity_per_carton: 6, abc_classification: "A", monthly_demand: 220, is_active: true, created_at: "", updated_at: "" },
  { id: "23", sku: "NB5", product_name: "Straight Tube Bong Pro", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 169.95, standard_quantity_per_carton: 6, abc_classification: "B", monthly_demand: 60, is_active: true, created_at: "", updated_at: "" },
  { id: "24", sku: "NB6", product_name: "Bong Ultimate", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 0, standard_quantity_per_carton: 6, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "25", sku: "BW68", product_name: "LayFlat Bong", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 0, standard_quantity_per_carton: 6, abc_classification: null, monthly_demand: 30, is_active: true, created_at: "", updated_at: "" },
  { id: "26", sku: "NB1M", product_name: "Freeze Pipe Mini Bong", upc_code: null, category: "fillable", display_category: "Bongs", retail_price: 154.95, standard_quantity_per_carton: 6, abc_classification: "B", monthly_demand: 120, is_active: true, created_at: "", updated_at: "" },
  { id: "27", sku: "S02-NSPM", product_name: "Studio Mini Negative Spoon", upc_code: null, category: "fillable", display_category: "Studio", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "28", sku: "S02-NSP", product_name: "Studio Negative Spoon", upc_code: null, category: "fillable", display_category: "Studio", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "29", sku: "S02-BW51XL", product_name: "Studio XL Tornado", upc_code: null, category: "fillable", display_category: "Studio", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "30", sku: "S02-BW22M", product_name: "Studio Mini Beaker", upc_code: null, category: "fillable", display_category: "Studio", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "31", sku: "BW32-P", product_name: "Freeze Pipe Nectar Collector (Kit)", upc_code: null, category: "fillable", display_category: "Dab Rigs", retail_price: 0, standard_quantity_per_carton: 6, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "32", sku: "BW38", product_name: "Freeze Pipe Mini Dab Rig", upc_code: null, category: "fillable", display_category: "Dab Rigs", retail_price: 129.95, standard_quantity_per_carton: 6, abc_classification: "C", monthly_demand: 45, is_active: true, created_at: "", updated_at: "" },
  { id: "33", sku: "BW34", product_name: "Freeze Pipe Klein Recycler", upc_code: null, category: "fillable", display_category: "Dab Rigs", retail_price: 259.95, standard_quantity_per_carton: 6, abc_classification: "C", monthly_demand: 20, is_active: true, created_at: "", updated_at: "" },
  { id: "34", sku: "BW55", product_name: "Waterfall Dab Rig", upc_code: null, category: "fillable", display_category: "Dab Rigs", retail_price: 159.95, standard_quantity_per_carton: 6, abc_classification: null, monthly_demand: 10, is_active: true, created_at: "", updated_at: "" },
  { id: "35", sku: "E-Rig-Attachment", product_name: "Puffco Peak Attachment", upc_code: null, category: "fillable", display_category: "Dab Rigs", retail_price: 139.95, standard_quantity_per_carton: 6, abc_classification: "B", monthly_demand: 60, is_active: true, created_at: "", updated_at: "" },
  { id: "36", sku: "Mini-ENAIL-Gray", product_name: "Mini-Enail", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 139.95, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 50, is_active: true, created_at: "", updated_at: "" },
  { id: "37", sku: "Vape", product_name: "Vessel Vape Pen", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 44.95, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 20, is_active: true, created_at: "", updated_at: "" },
  { id: "38", sku: "Puffco-Peak", product_name: "Puffco Peak", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 139.95, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 10, is_active: true, created_at: "", updated_at: "" },
  { id: "39", sku: "BW33-14", product_name: "14mm Ash Catcher", upc_code: null, category: "fillable", display_category: "Ash Catchers", retail_price: 74.95, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 50, is_active: true, created_at: "", updated_at: "" },
  { id: "40", sku: "BW33-19", product_name: "18mm Ash Catcher", upc_code: null, category: "fillable", display_category: "Ash Catchers", retail_price: 74.95, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 75, is_active: true, created_at: "", updated_at: "" },
  { id: "41", sku: "BW33-14-45", product_name: "14mm 45 Ash Catcher", upc_code: null, category: "fillable", display_category: "Ash Catchers", retail_price: 74.95, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 50, is_active: true, created_at: "", updated_at: "" },
  { id: "42", sku: "BW33-19-45", product_name: "18mm 45 Ash Catcher", upc_code: null, category: "fillable", display_category: "Ash Catchers", retail_price: 74.95, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 20, is_active: true, created_at: "", updated_at: "" },
  { id: "43", sku: "BW33-14P", product_name: "14mm Ash Catcher Pro", upc_code: null, category: "fillable", display_category: "Ash Catchers", retail_price: 99.95, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 30, is_active: true, created_at: "", updated_at: "" },
  { id: "44", sku: "BW33-19P", product_name: "18mm Ash Catcher Pro", upc_code: null, category: "fillable", display_category: "Ash Catchers", retail_price: 99.95, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 150, is_active: true, created_at: "", updated_at: "" },
  { id: "45", sku: "BW20-Bowl", product_name: "Freeze Pipe Bowl", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 9.95, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 1300, is_active: true, created_at: "", updated_at: "" },
  { id: "46", sku: "14-HC-Bowl", product_name: "14mm Honeycomb Bowl", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 100, is_active: true, created_at: "", updated_at: "" },
  { id: "47", sku: "18-HC-Bowl", product_name: "18mm Honeycomb Bowl", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 150, is_active: true, created_at: "", updated_at: "" },
  { id: "48", sku: "Hybrid-Bowl", product_name: "14/18mm Hybrid Bowl", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 10, is_active: true, created_at: "", updated_at: "" },
  { id: "49", sku: "14-3X-Bowl", product_name: "14mm 3X Honeycomb Bowl", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 30, is_active: true, created_at: "", updated_at: "" },
  { id: "50", sku: "18-3X-Bowl", product_name: "18mm 3X Honeycomb Bowl", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 45, is_active: true, created_at: "", updated_at: "" },
  { id: "51", sku: "14-G-Bowl", product_name: "14mm Glycerin Bowl", upc_code: null, category: "fillable", display_category: "Bowls", retail_price: 29.95, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 60, is_active: true, created_at: "", updated_at: "" },
  { id: "52", sku: "18-G-Bowl", product_name: "18mm Glycerin Bowl", upc_code: null, category: "fillable", display_category: "Bowls", retail_price: 29.95, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 120, is_active: true, created_at: "", updated_at: "" },
  { id: "53", sku: "14-Banger", product_name: "14mm Banger", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 9, is_active: true, created_at: "", updated_at: "" },
  { id: "54", sku: "18-Banger", product_name: "18mm Banger", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 1, is_active: true, created_at: "", updated_at: "" },
  { id: "55", sku: "BW21-Bowl", product_name: "Bubbler Bowl", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 6, is_active: true, created_at: "", updated_at: "" },
  { id: "56", sku: "Quartz-Tip", product_name: "Quartz Tips", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "57", sku: "BC-14", product_name: "14mm Bowl Cooler", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "58", sku: "BC-18", product_name: "18mm Bowl Cooler", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "59", sku: "14-Mag-Bowl", product_name: "14mm Magnetic Bowl", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 35, is_active: true, created_at: "", updated_at: "" },
  { id: "60", sku: "18-Mag-Bowl", product_name: "18mm Magnetic Bowl", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 35, is_active: true, created_at: "", updated_at: "" },
  { id: "61", sku: "J-Bowl", product_name: "Joint Bowl", upc_code: null, category: "non_fillable", display_category: "Bowls", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 40, is_active: true, created_at: "", updated_at: "" },
  { id: "62", sku: "FP-Koozie", product_name: "Koozie", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: "A", monthly_demand: 420, is_active: true, created_at: "", updated_at: "" },
  { id: "63", sku: "Bong-Koozie", product_name: "Bong Koozie", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: "B", monthly_demand: 70, is_active: true, created_at: "", updated_at: "" },
  { id: "64", sku: "XL-Koozie", product_name: "Bong XL Koozie", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: "B", monthly_demand: 90, is_active: true, created_at: "", updated_at: "" },
  { id: "65", sku: "GBT-Koozie", product_name: "GBT Koozie", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "66", sku: "34-Clip", product_name: "34mm Clip", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 60, is_active: true, created_at: "", updated_at: "" },
  { id: "67", sku: "19-Clip", product_name: "18mm Clip", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 110, is_active: true, created_at: "", updated_at: "" },
  { id: "68", sku: "14-Clip", product_name: "14mm Clip", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 5, is_active: true, created_at: "", updated_at: "" },
  { id: "69", sku: "Plastic-Grinder", product_name: "Plastic Grinder", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "70", sku: "1-Hemp", product_name: "Hemp Rope", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 70, is_active: true, created_at: "", updated_at: "" },
  { id: "71", sku: "Dab-Dish", product_name: "Dab Dish", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "72", sku: "Carb-Cap", product_name: "Carb Cap", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 10, is_active: true, created_at: "", updated_at: "" },
  { id: "73", sku: "BW22-Down", product_name: "Beaker Downstem", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 15, is_active: true, created_at: "", updated_at: "" },
  { id: "74", sku: "BW22P-Down", product_name: "Beaker Pro Downstem", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "75", sku: "BW22U-Down", product_name: "Beaker Ultimate Downstem", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 20, is_active: true, created_at: "", updated_at: "" },
  { id: "76", sku: "Cleaning-Bottle", product_name: "Cleaning Solution", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 500, is_active: true, created_at: "", updated_at: "" },
  { id: "77", sku: "Cleaning-Caps", product_name: "Cleaning Kit Caps", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 550, is_active: true, created_at: "", updated_at: "" },
  { id: "78", sku: "Cleaning-Plugs", product_name: "Cleaning Kit Plugs", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 550, is_active: true, created_at: "", updated_at: "" },
  { id: "79", sku: "Pipe-Cleaner", product_name: "Pipe Cleaner", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "80", sku: "GBT-ADP", product_name: "GBT Adapter", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "81", sku: "BW20-Stone", product_name: "Cold Stone", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 450, is_active: true, created_at: "", updated_at: "" },
  { id: "82", sku: "BW40-Stone", product_name: "GBT Cold Stone", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 20, is_active: true, created_at: "", updated_at: "" },
  { id: "83", sku: "BW40XL-Stone", product_name: "GBT Pro Cold Stone", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 40, is_active: true, created_at: "", updated_at: "" },
  { id: "84", sku: "NB2-Stone", product_name: "Beaker Cold Stone", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 65, is_active: true, created_at: "", updated_at: "" },
  { id: "85", sku: "BW20DNA-Stone", product_name: "BW20DNA Cold Stone", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 215, is_active: true, created_at: "", updated_at: "" },
  { id: "86", sku: "Rolling-Tray", product_name: "Rolling Trays", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 15, is_active: true, created_at: "", updated_at: "" },
  { id: "87", sku: "Keychain-Debowler", product_name: "Keychain Debowler", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 500, is_active: true, created_at: "", updated_at: "" },
  { id: "88", sku: "Sleeve", product_name: "Cooling Sleeve", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 45, is_active: true, created_at: "", updated_at: "" },
  { id: "89", sku: "Vault-Box", product_name: "Bong Vault", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 30, is_active: true, created_at: "", updated_at: "" },
  { id: "90", sku: "Carbon-Filter", product_name: "Charcoal Filter Set", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 160, is_active: true, created_at: "", updated_at: "" },
  { id: "91", sku: "Hookah-Adapter", product_name: "Hookah 18mm M Hose Adapter", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "92", sku: "10-Filters", product_name: "Pipe Carbon Filter Packs", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "93", sku: "Filter-ADP", product_name: "Pipe Filter Adapter", upc_code: null, category: "non_fillable", display_category: "Accessories", retail_price: 0, standard_quantity_per_carton: 50, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "94", sku: "HT-3", product_name: "XL Straight Coil", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 10, is_active: true, created_at: "", updated_at: "" },
  { id: "95", sku: "HT-4", product_name: "Bong Revolver Coil", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 20, is_active: true, created_at: "", updated_at: "" },
  { id: "96", sku: "HT-5", product_name: "Bong XL Revolver Coil", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "97", sku: "HT-5M", product_name: "XL Revolver Mirrored", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 50, is_active: true, created_at: "", updated_at: "" },
  { id: "98", sku: "HT-11", product_name: "XL Twisted Revolver", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 20, is_active: true, created_at: "", updated_at: "" },
  { id: "99", sku: "BW21-Spiral", product_name: "Bubbler Coil", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "100", sku: "BW21-Revolver", product_name: "Bubbler Pro Coil", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "101", sku: "NB1-Spiral", product_name: "Bong Coil", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "102", sku: "NB1-XL-Spiral", product_name: "Bong XL Spiral Coil", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "103", sku: "BW32P-Straight", product_name: "NC Straight Coil", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "104", sku: "BW32P-Spiral", product_name: "NC Spiral Coil", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "105", sku: "34-Middle-Revolver", product_name: "34mm Middle Coil Mirrored Revolver", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 60, is_active: true, created_at: "", updated_at: "" },
  { id: "106", sku: "HT-7", product_name: "Small Middle Coil - Straight", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 35, is_active: true, created_at: "", updated_at: "" },
  { id: "107", sku: "34-UFO", product_name: "UFO Perc 34mm", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 30, is_active: true, created_at: "", updated_at: "" },
  { id: "108", sku: "18-UFO", product_name: "UFO Perc 18mm", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 25, is_active: true, created_at: "", updated_at: "" },
  { id: "109", sku: "BW33-14P-Coil", product_name: "14mm Ash Catcher Pro Coil", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "110", sku: "BW33-19P-Coil", product_name: "18mm Ash Catcher Pro Coil", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "111", sku: "HT6", product_name: "Small Revolver Coil", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "112", sku: "34-DNA-Coil", product_name: "DNA Coil", upc_code: null, category: "fillable", display_category: "Coils", retail_price: 0, standard_quantity_per_carton: 24, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "113", sku: "BW21-Base", product_name: "Bubbler Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "114", sku: "BW21P-Base", product_name: "Bubbler Pro Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "115", sku: "NB1M-Base", product_name: "Mini Bong Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "116", sku: "BW51-base", product_name: "Tornado Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "117", sku: "BW51P-Base", product_name: "Tornado Pro Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "118", sku: "BW22-Base", product_name: "Beaker Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "119", sku: "BW22P-Base", product_name: "Beaker Pro Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "120", sku: "BW22U-Base", product_name: "Beaker Ultimate Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "121", sku: "NB1-Base", product_name: "Bong Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "122", sku: "NB2-Base", product_name: "Showerhead Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "123", sku: "BW25-Base", product_name: "Recycler Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "124", sku: "BW53", product_name: "Bell Recycler Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "125", sku: "BW34-Base", product_name: "Klein Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "126", sku: "BW38-base", product_name: "Mini Dab Rig Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "127", sku: "BW32-Base", product_name: "Nectar Collector Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
  { id: "128", sku: "BW63-Base", product_name: "Hookah Base", upc_code: null, category: "non_fillable", display_category: "Bases", retail_price: 0, standard_quantity_per_carton: 12, abc_classification: null, monthly_demand: 0, is_active: true, created_at: "", updated_at: "" },
];

// Real inventory data — keyed by product index (0-based).
// Columns: warehouse_raw, warehouse_in_production, warehouse_finished, warehouse_other.
// The 7 legacy columns (in_transit_*, nancy_*, yx_*) were dropped in
// migration 041; In Transit + On Order are now derived from freight_shipments
// and factory_orders (see src/lib/inventory-aggregates.ts).
const inventoryData: [number, number, number, number][] = [
  /* 1  BW20 */          [0, 0, 906, 0],
  /* 2  BW20P */         [200, 0, 0, 0],
  /* 3  BW20DNA */       [450, 0, 2135, 0],
  /* 4  BW30P */         [0, 0, 3, 0],
  /* 5  bw64 */          [0, 0, 570, 0],
  /* 6  BW64P */         [0, 0, 0, 0],
  /* 7  BW21P */         [0, 0, 497, 0],
  /* 8  BW61 */          [0, 0, 188, 0],
  /* 9  BW40 */          [0, 0, 337, 0],
  /* 10 BW40SP */        [0, 0, 140, 0],
  /* 11 BW60 */          [0, 0, 357, 0],
  /* 12 BW60U */         [0, 0, 59, 0],
  /* 13 NB2 */           [100, 0, 385, 0],
  /* 14 NB3U */          [0, 0, 0, 0],
  /* 15 BW22 */          [204, 0, 354, 0],
  /* 16 BW22U */         [0, 0, 163, 0],
  /* 17 BW25 */          [0, 0, 0, 0],
  /* 18 BW58B */         [78, 0, 9, 0],
  /* 19 BW59 */          [0, 0, 21, 0],
  /* 20 BW62 */          [0, 0, 2, 0],
  /* 21 BW63 */          [0, 0, 134, 0],
  /* 22 NB4 */           [0, 0, 638, 0],
  /* 23 NB5 */           [0, 0, 8, 0],
  /* 24 NB6 */           [0, 0, 77, 0],
  /* 25 BW68 */          [0, 0, 39, 0],
  /* 26 NB1M */          [0, 0, 342, 0],
  /* 27 S02-NSPM */      [0, 0, 0, 0],
  /* 28 S02-NSP */       [0, 0, 0, 0],
  /* 29 S02-BW51XL */    [0, 0, 0, 0],
  /* 30 S02-BW22M */     [0, 0, 0, 0],
  /* 31 BW32-P */        [0, 0, 0, 0],
  /* 32 BW38 */          [0, 0, 15, 0],
  /* 33 BW34 */          [0, 0, 20, 0],
  /* 34 BW55 */          [0, 0, 0, 0],
  /* 35 E-Rig-Attach */  [112, 0, 43, 0],
  /* 36 Mini-ENAIL */    [0, 0, 176, 0],
  /* 37 Vape */          [0, 0, 560, 0],
  /* 38 Puffco-Peak */   [0, 0, 0, 0],
  /* 39 BW33-14 */       [0, 0, 167, 0],
  /* 40 BW33-19 */       [0, 0, 236, 0],
  /* 41 BW33-14-45 */    [0, 0, 16, 0],
  /* 42 BW33-19-45 */    [0, 0, 66, 0],
  /* 43 BW33-14P */      [0, 0, 152, 0],
  /* 44 BW33-19P */      [0, 0, 128, 0],
  /* 45 BW20-Bowl */     [0, 0, 803, 0],
  /* 46 14-HC-Bowl */    [0, 0, 542, 0],
  /* 47 18-HC-Bowl */    [0, 0, 756, 0],
  /* 48 Hybrid-Bowl */   [0, 0, 0, 0],
  /* 49 14-3X-Bowl */    [0, 0, 181, 0],
  /* 50 18-3X-Bowl */    [0, 0, 300, 0],
  /* 51 14-G-Bowl */     [0, 0, 56, 0],
  /* 52 18-G-Bowl */     [0, 0, 169, 0],
  /* 53 14-Banger */     [0, 0, 64, 0],
  /* 54 18-Banger */     [0, 0, 385, 0],
  /* 55 BW21-Bowl */     [0, 0, 35, 0],
  /* 56 Quartz-Tip */    [0, 0, 58, 0],
  /* 57 BC-14 */         [0, 0, 3, 0],
  /* 58 BC-18 */         [0, 0, 46, 0],
  /* 59 14-Mag-Bowl */   [0, 0, 263, 0],
  /* 60 18-Mag-Bowl */   [0, 0, 182, 0],
  /* 61 J-Bowl */        [0, 0, 12, 0],
  /* 62 FP-Koozie */     [0, 0, 403, 0],
  /* 63 Bong-Koozie */   [0, 0, 39, 0],
  /* 64 XL-Koozie */     [0, 0, 214, 0],
  /* 65 GBT-Koozie */    [0, 0, 95, 0],
  /* 66 34-Clip */       [0, 0, 96, 0],
  /* 67 19-Clip */       [0, 0, 247, 0],
  /* 68 14-Clip */       [0, 0, 0, 0],
  /* 69 Plastic-Grinder */ [0, 0, 1400, 0],
  /* 70 1-Hemp */        [0, 0, 0, 0],
  /* 71 Dab-Dish */      [0, 0, 100, 0],
  /* 72 Carb-Cap */      [0, 0, 105, 0],
  /* 73 BW22-Down */     [0, 0, 80, 0],
  /* 74 BW22P-Down */    [0, 0, 0, 0],
  /* 75 BW22U-Down */    [0, 0, 0, 0],
  /* 76 Cleaning-Bottle */ [0, 0, 2176, 0],
  /* 77 Cleaning-Caps */ [0, 0, 714, 0],
  /* 78 Cleaning-Plugs */ [0, 0, 1045, 0],
  /* 79 Pipe-Cleaner */  [0, 0, 1400, 0],
  /* 80 GBT-ADP */       [0, 0, 70, 0],
  /* 81 BW20-Stone */    [0, 0, 857, 0],
  /* 82 BW40-Stone */    [0, 0, 1, 0],
  /* 83 BW40XL-Stone */  [0, 0, 3, 0],
  /* 84 NB2-Stone */     [0, 0, 38, 0],
  /* 85 BW20DNA-Stone */ [0, 0, 226, 0],
  /* 86 Rolling-Tray */  [0, 0, 131, 0],
  /* 87 Keychain-Debowler */ [0, 0, 853, 0],
  /* 88 Sleeve */        [0, 0, 0, 0],
  /* 89 Vault-Box */     [0, 0, 32, 0],
  /* 90 Carbon-Filter */ [442, 0, 382, 0],
  /* 91 Hookah-Adapter */ [0, 0, 40, 0],
  /* 92 10-Filters */    [0, 0, 14, 0],
  /* 93 Filter-ADP */    [0, 0, 584, 0],
  /* 94 HT-3 */          [0, 0, 47, 0],
  /* 95 HT-4 */          [47, 0, 0, 0],
  /* 96 HT-5 */          [0, 0, 0, 0],
  /* 97 HT-5M */         [0, 0, 0, 0],
  /* 98 HT-11 */         [0, 0, 0, 0],
  /* 99 BW21-Spiral */   [0, 0, 0, 0],
  /* 100 BW21-Revolver */ [0, 0, 62, 0],
  /* 101 NB1-Spiral */   [0, 0, 20, 0],
  /* 102 NB1-XL-Spiral */ [0, 0, 20, 0],
  /* 103 BW32P-Straight */ [0, 0, 0, 0],
  /* 104 BW32P-Spiral */ [0, 0, 2, 0],
  /* 105 34-Middle-Revolver */ [0, 0, 41, 0],
  /* 106 HT-7 */         [0, 0, 100, 0],
  /* 107 34-UFO */       [0, 0, 123, 0],
  /* 108 18-UFO */       [0, 0, 167, 0],
  /* 109 BW33-14P-Coil */ [0, 0, 25, 0],
  /* 110 BW33-19P-Coil */ [0, 0, 50, 0],
  /* 111 HT6 */          [0, 0, 0, 0],
  /* 112 34-DNA-Coil */  [0, 0, 0, 0],
  /* 113 BW21-Base */    [0, 0, 0, 0],
  /* 114 BW21P-Base */   [0, 0, 0, 0],
  /* 115 NB1M-Base */    [0, 0, 0, 0],
  /* 116 BW51-base */    [0, 0, 0, 0],
  /* 117 BW51P-Base */   [0, 0, 3, 0],
  /* 118 BW22-Base */    [0, 0, 0, 0],
  /* 119 BW22P-Base */   [0, 0, 3, 0],
  /* 120 BW22U-Base */   [0, 0, 0, 0],
  /* 121 NB1-Base */     [0, 0, 0, 0],
  /* 122 NB2-Base */     [0, 0, 0, 0],
  /* 123 BW25-Base */    [0, 0, 0, 0],
  /* 124 BW53 */         [0, 0, 24, 0],
  /* 125 BW34-Base */    [0, 0, 0, 0],
  /* 126 BW38-base */    [0, 0, 0, 0],
  /* 127 BW32-Base */    [0, 0, 50, 0],
  /* 128 BW63-Base */    [0, 0, 10, 0],
];

export const demoInventory: (InventoryLevel & { product?: ProductSKU })[] = demoProducts.map((p, i) => {
  const d = inventoryData[i];
  return {
    id: `inv-${p.id}`,
    sku_id: p.id,
    warehouse_raw: d[0],
    warehouse_in_production: d[1],
    warehouse_finished: d[2],
    warehouse_other: d[3],
    last_synced_at: now,
    updated_at: now,
    product: p,
  };
});

// Loosen to Partial + require only id — generated FreightShipment picked
// up new columns (origin_supplier_id, idempotency_key, row_version, etc.)
// that demo fixtures predate and don't need. Same pattern as demoFactoryOrders.
export const demoFreight: (Partial<FreightShipment> & { id: string })[] = [
  { id: "f1", shipment_number: "SEA-2026-0315", freight_type: "sea", status: "on_the_water", carrier_name: "Maersk", broker_name: "Pacific Customs", forwarder_code: "FWD-001", tracking_number: "MAEU1234567", ship_date: "2026-03-15", eta: "2026-04-18", eta_original: "2026-04-18", eta_last_checked_at: null, status_overridden_at: null, total_cartons: 22, actual_arrival_date: null, freight_cost: 4200, insurance_cost: 350, duties_cost: 0, total_cost: 4550, notes: "Mixed SKUs - pipes and bongs", created_at: "", updated_at: "" },
  { id: "f2", shipment_number: "SEA-2026-0308", freight_type: "sea", status: "high_risk", carrier_name: "COSCO", broker_name: "Pacific Customs", forwarder_code: "FWD-002", tracking_number: "COSU9876543", ship_date: "2026-03-08", eta: "2026-04-10", eta_original: "2026-04-10", eta_last_checked_at: null, status_overridden_at: null, total_cartons: 14, actual_arrival_date: null, freight_cost: 3800, insurance_cost: 420, duties_cost: 0, total_cost: 4220, notes: "Customs inspection initiated 03/28", created_at: "", updated_at: "" },
  { id: "f3", shipment_number: "AIR-2026-0328", freight_type: "air", status: "cleared_customs", carrier_name: "FedEx", broker_name: null, forwarder_code: "FWD-003", tracking_number: "7489201234", ship_date: "2026-03-28", eta: "2026-04-03", eta_original: "2026-04-03", eta_last_checked_at: null, status_overridden_at: null, total_cartons: 7, actual_arrival_date: null, freight_cost: 1850, insurance_cost: 200, duties_cost: 320, total_cost: 2370, notes: "Rush order - bong pro and GBT spiral", created_at: "", updated_at: "" },
  { id: "f4", shipment_number: "SEA-2026-0220", freight_type: "sea", status: "delivered", carrier_name: "Evergreen", broker_name: "Pacific Customs", forwarder_code: "FWD-001", tracking_number: "EGLV5551234", ship_date: "2026-02-20", eta: "2026-03-25", eta_original: "2026-03-25", eta_last_checked_at: null, status_overridden_at: null, total_cartons: 31, actual_arrival_date: "2026-03-24", freight_cost: 5100, insurance_cost: 400, duties_cost: 890, total_cost: 6390, notes: null, created_at: "", updated_at: "" },
  { id: "f5", shipment_number: "AIR-2026-0325", freight_type: "air", status: "delivered", carrier_name: "DHL", broker_name: null, forwarder_code: "FWD-004", tracking_number: "1234567890", ship_date: "2026-03-25", eta: "2026-03-30", eta_original: "2026-03-30", eta_last_checked_at: null, status_overridden_at: null, total_cartons: 4, actual_arrival_date: "2026-03-29", freight_cost: 980, insurance_cost: 100, duties_cost: 150, total_cost: 1230, notes: "Emergency restock - Freeze Pipe bowls", created_at: "", updated_at: "" },
];

// Hydrate freight shipments from localStorage-persisted tracking updates (demo mode only).
// In production this is replaced by Supabase — each check writes to the row directly.
if (typeof window !== "undefined") {
  try {
    const raw = window.localStorage.getItem("freeze-pipe-freight-tracking-v1");
    if (raw) {
      const store = JSON.parse(raw) as Record<string, { eta: string; eta_original: string; eta_last_checked_at: string; actual_arrival_date: string | null; status?: FreightShipment["status"]; status_overridden_at?: string | null }>;
      for (const shipment of demoFreight) {
        const entry = store[shipment.id];
        if (entry) {
          shipment.eta = entry.eta;
          shipment.eta_original = entry.eta_original;
          shipment.eta_last_checked_at = entry.eta_last_checked_at;
          shipment.actual_arrival_date = entry.actual_arrival_date ?? shipment.actual_arrival_date;
          if (entry.status) shipment.status = entry.status;
          if (entry.status_overridden_at !== undefined) {
            shipment.status_overridden_at = entry.status_overridden_at;
          }
        }
      }
    }
  } catch {
    // Ignore malformed storage — demo data stays at its defaults.
  }
}

// Loosened to Partial + require id — generated FreightLineItem picked up
// supplier-portal columns (quantity_prefilled, source_factory_order_item_id,
// supplier_declared_quantity, row_version, updated_at) that demo fixtures
// predate and don't need. Same pattern as demoFreight / demoFactoryOrders.
export const demoFreightLineItems: (Partial<FreightLineItem> & { id: string; product?: ProductSKU })[] = [
  { id: "fl1", freight_shipment_id: "f1", sku_id: "1", quantity: 144, unit_cost: 8.50, retail_value: 74.95, created_at: "", product: demoProducts[0] },
  { id: "fl2", freight_shipment_id: "f1", sku_id: "7", quantity: 96, unit_cost: 12.00, retail_value: 139.95, created_at: "", product: demoProducts[6] },
  { id: "fl3", freight_shipment_id: "f2", sku_id: "3", quantity: 48, unit_cost: 10.00, retail_value: 94.95, created_at: "", product: demoProducts[2] },
  { id: "fl4", freight_shipment_id: "f2", sku_id: "9", quantity: 108, unit_cost: 5.80, retail_value: 49.95, created_at: "", product: demoProducts[8] },
  { id: "fl5", freight_shipment_id: "f3", sku_id: "13", quantity: 24, unit_cost: 18.00, retail_value: 209.95, created_at: "", product: demoProducts[12] },
  { id: "fl6", freight_shipment_id: "f3", sku_id: "10", quantity: 12, unit_cost: 7.50, retail_value: 69.95, created_at: "", product: demoProducts[9] },
];

export const demoTaskLogs: (TaskLog & { employee_name?: string; sku_name?: string })[] = [
  { id: "t1", employee_id: "emp1", sku_id: "1", task_type: "emptying", quantity_processed: 12, time_started: "2026-04-02T08:00:00Z", time_completed: "2026-04-02T08:25:00Z", notes: null, created_at: "2026-04-02T08:25:00Z", employee_name: "Mike Torres", sku_name: "BW20" },
  { id: "t2", employee_id: "emp2", sku_id: "7", task_type: "filling_capping", quantity_processed: 24, time_started: "2026-04-02T08:15:00Z", time_completed: "2026-04-02T09:00:00Z", notes: null, created_at: "2026-04-02T09:00:00Z", employee_name: "Sarah Chen", sku_name: "BW21P" },
  { id: "t3", employee_id: "emp3", sku_id: "3", task_type: "rtsing", quantity_processed: 8, time_started: "2026-04-02T08:30:00Z", time_completed: "2026-04-02T08:50:00Z", notes: null, created_at: "2026-04-02T08:50:00Z", employee_name: "James Park", sku_name: "BW20DNA" },
  { id: "t4", employee_id: "emp1", sku_id: "13", task_type: "emptying", quantity_processed: 12, time_started: "2026-04-02T09:05:00Z", time_completed: "2026-04-02T09:30:00Z", notes: "Minor packaging damage on 2 units", created_at: "2026-04-02T09:30:00Z", employee_name: "Mike Torres", sku_name: "NB2" },
  { id: "t5", employee_id: "emp2", sku_id: "1", task_type: "rtsing", quantity_processed: 12, time_started: "2026-04-02T09:10:00Z", time_completed: "2026-04-02T09:35:00Z", notes: null, created_at: "2026-04-02T09:35:00Z", employee_name: "Sarah Chen", sku_name: "BW20" },
  { id: "t6", employee_id: "emp3", sku_id: "36", task_type: "prefilled_rtsing", quantity_processed: 100, time_started: "2026-04-02T09:00:00Z", time_completed: "2026-04-02T09:45:00Z", notes: null, created_at: "2026-04-02T09:45:00Z", employee_name: "James Park", sku_name: "Mini-ENAIL-Gray" },
  { id: "t7", employee_id: "emp1", sku_id: "9", task_type: "filling_capping", quantity_processed: 36, time_started: "2026-04-02T09:40:00Z", time_completed: "2026-04-02T10:30:00Z", notes: null, created_at: "2026-04-02T10:30:00Z", employee_name: "Mike Torres", sku_name: "BW40" },
  { id: "t8", employee_id: "emp2", sku_id: "10", task_type: "emptying", quantity_processed: 6, time_started: "2026-04-02T09:45:00Z", time_completed: "2026-04-02T10:05:00Z", notes: null, created_at: "2026-04-02T10:05:00Z", employee_name: "Sarah Chen", sku_name: "BW40SP" },
];

// Demo factory orders are intentionally partial — they predate the schema
// migrations that added supplier_id, row_version, canceled_*, alt-ETA, etc.
// Widening to Partial keeps demo mode rendering without re-seeding every
// field. Real data comes from Supabase via useFactoryOrders.
export const demoFactoryOrders: (Partial<FactoryOrder> & {
  id: string;
  items?: (Partial<FactoryOrderItem> & { id: string; sku_id: string; quantity_ordered: number; product?: ProductSKU })[];
})[] = [
  { id: "fo1", order_number: "NAN-2026-042", status: "in_production", order_date: "2026-03-10", expected_completion: "2026-04-10", notes: "Standard monthly order", created_at: "", updated_at: "", items: [
    { id: "foi1", factory_order_id: "fo1", sku_id: "1", quantity_ordered: 500, quantity_finished: 540, unit_cost: 8.50, created_at: "", product: demoProducts[0] },
    { id: "foi2", factory_order_id: "fo1", sku_id: "9", quantity_ordered: 200, quantity_finished: 200, unit_cost: 5.80, created_at: "", product: demoProducts[8] },
  ]},
  { id: "fo2", order_number: "YX-2026-018", status: "ordered", order_date: "2026-03-20", expected_completion: "2026-04-20", notes: null, created_at: "", updated_at: "", items: [
    { id: "foi3", factory_order_id: "fo2", sku_id: "7", quantity_ordered: 200, quantity_finished: 200, unit_cost: 12.00, created_at: "", product: demoProducts[6] },
    { id: "foi4", factory_order_id: "fo2", sku_id: "13", quantity_ordered: 100, quantity_finished: 0, unit_cost: 18.00, created_at: "", product: demoProducts[12] },
  ]},
  { id: "fo3", order_number: "NAN-2026-041", status: "finished", order_date: "2026-02-15", expected_completion: "2026-03-15", notes: "Ready for pickup", created_at: "", updated_at: "", items: [
    { id: "foi5", factory_order_id: "fo3", sku_id: "3", quantity_ordered: 500, quantity_finished: 500, unit_cost: 10.00, created_at: "", product: demoProducts[2] },
  ]},
];

/**
 * Factory order fulfillments — tracks the physical movement of units out of a
 * factory order line item over time. The commercial record (factory_order_items)
 * stays immutable; a line item can be spread across many fulfillment rows at
 * different stages. Invariant: sum(fulfillments.quantity) === item.quantity_ordered.
 *
 * This demo data intentionally includes split scenarios:
 * - foi1 (BW20 x500): partially shipped early, some at factory, some still in production
 * - foi2 (SKU 9 x200): entirely at factory waiting for a freight
 * - foi3 (SKU 7 x200): everything still in production
 * - foi4 (SKU 13 x100): everything still in production
 * - foi5 (SKU 3 x500): all finished at factory, ready to pick up
 */
export const demoFactoryOrderFulfillments: FactoryOrderFulfillment[] = [
  // foi1: 500 BW20 split across 3 stages
  { id: "ff1", factory_order_item_id: "foi1", quantity: 300, stage: "shipped", freight_shipment_id: "f1", completed_at: "2026-03-14", created_at: "" },
  { id: "ff2", factory_order_item_id: "foi1", quantity: 120, stage: "finished_at_factory", freight_shipment_id: null, completed_at: "2026-03-28", created_at: "" },
  { id: "ff3", factory_order_item_id: "foi1", quantity: 80, stage: "in_production", freight_shipment_id: null, completed_at: null, created_at: "" },
  // foi2: 200 SKU9 all finished at factory
  { id: "ff4", factory_order_item_id: "foi2", quantity: 200, stage: "finished_at_factory", freight_shipment_id: null, completed_at: "2026-03-30", created_at: "" },
  // foi3: 200 SKU7 all still in production
  { id: "ff5", factory_order_item_id: "foi3", quantity: 200, stage: "in_production", freight_shipment_id: null, completed_at: null, created_at: "" },
  // foi4: 100 SKU13 all still in production
  { id: "ff6", factory_order_item_id: "foi4", quantity: 100, stage: "in_production", freight_shipment_id: null, completed_at: null, created_at: "" },
  // foi5: 500 SKU3 all finished at factory (ready to pick up)
  { id: "ff7", factory_order_item_id: "foi5", quantity: 500, stage: "finished_at_factory", freight_shipment_id: null, completed_at: "2026-03-12", created_at: "" },
];

export interface FulfillmentRollup {
  inProduction: number;
  atFactory: number;
  shipped: number;
  total: number;
}

const EMPTY_ROLLUP: FulfillmentRollup = { inProduction: 0, atFactory: 0, shipped: 0, total: 0 };

/** Fulfillments for a single factory order item line. */
export function getFulfillmentsByItem(itemId: string): FactoryOrderFulfillment[] {
  return demoFactoryOrderFulfillments.filter(f => f.factory_order_item_id === itemId);
}

/** Rollup of a single item line's fulfillments into stage totals. */
export function getItemRollup(itemId: string): FulfillmentRollup {
  const rollup: FulfillmentRollup = { ...EMPTY_ROLLUP };
  for (const f of demoFactoryOrderFulfillments) {
    if (f.factory_order_item_id !== itemId) continue;
    rollup.total += f.quantity;
    if (f.stage === "in_production") rollup.inProduction += f.quantity;
    else if (f.stage === "finished_at_factory") rollup.atFactory += f.quantity;
    else if (f.stage === "shipped") rollup.shipped += f.quantity;
  }
  return rollup;
}

/** Rollup of every item in an order into stage totals. */
export function getOrderRollup(orderId: string): FulfillmentRollup {
  const order = demoFactoryOrders.find(o => o.id === orderId);
  if (!order?.items) return { ...EMPTY_ROLLUP };
  return order.items.reduce<FulfillmentRollup>((acc, item) => {
    const r = getItemRollup(item.id);
    return {
      inProduction: acc.inProduction + r.inProduction,
      atFactory: acc.atFactory + r.atFactory,
      shipped: acc.shipped + r.shipped,
      total: acc.total + r.total,
    };
  }, { ...EMPTY_ROLLUP });
}

/**
 * Derived status for a factory order based on where its units actually are.
 * - shipped: every unit has left the factory
 * - finished: no units still in production
 * - in_production: any units still being made
 */
export function deriveOrderStatus(orderId: string): "in_production" | "finished" | "shipped" {
  const r = getOrderRollup(orderId);
  if (r.total > 0 && r.shipped === r.total) return "shipped";
  if (r.inProduction === 0 && r.atFactory + r.shipped > 0) return "finished";
  return "in_production";
}

/** Move units between stages. Mutates the in-memory demo array. */
export function moveFulfillment(
  itemId: string,
  fromStage: FulfillmentStage,
  toStage: FulfillmentStage,
  quantity: number,
  freightShipmentId: string | null = null,
): boolean {
  const fulfillments = demoFactoryOrderFulfillments.filter(
    f => f.factory_order_item_id === itemId && f.stage === fromStage
  );
  let remaining = quantity;
  for (const f of fulfillments) {
    if (remaining <= 0) break;
    const take = Math.min(f.quantity, remaining);
    f.quantity -= take;
    remaining -= take;
    demoFactoryOrderFulfillments.push({
      id: `ff-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      factory_order_item_id: itemId,
      quantity: take,
      stage: toStage,
      freight_shipment_id: toStage === "shipped" ? freightShipmentId : null,
      completed_at: new Date().toISOString().split("T")[0],
      created_at: "",
    });
  }
  // Clean up zero-quantity rows
  for (let i = demoFactoryOrderFulfillments.length - 1; i >= 0; i--) {
    if (demoFactoryOrderFulfillments[i].quantity <= 0) demoFactoryOrderFulfillments.splice(i, 1);
  }
  return remaining === 0;
}

// `demoDemandOverrides` was used for in-memory demand overrides in the
// pre-Supabase demo. The real-data path uses `useSetDemandOverride` /
// `demand_overrides` table; nothing in src/ reads it.
//
// `getEffectiveDemand` + `getProductForecast` moved to src/lib/demand.ts.

/** Manufacturing task → warehouse bucket movement.
 *
 * Three of the four task types shift units between buckets; filling_capping is
 * an in-place transformation (units stay in in_production, just now filled).
 */
const TASK_MOVEMENTS: Record<
  "emptying" | "filling_capping" | "rtsing" | "prefilled_rtsing",
  { from: keyof InventoryLevel | null; to: keyof InventoryLevel | null } | null
> = {
  emptying: { from: "warehouse_raw", to: "warehouse_in_production" },
  rtsing: { from: "warehouse_in_production", to: "warehouse_finished" },
  prefilled_rtsing: { from: "warehouse_raw", to: "warehouse_finished" },
  filling_capping: null, // no bucket move — metadata entry only
};

export interface TaskCompletionResult {
  ok: boolean;
  reason?: "unknown_sku" | "unknown_task" | "insufficient_source_stock";
  available?: number;
}

/**
 * Record a completed manufacturing task: mutates inventory buckets, writes an
 * audit entry (category move or metadata for fill/cap), and returns status.
 *
 * In production this would be a Supabase transaction; in demo mode we mutate
 * demoInventory in place.
 */
export function logTaskCompletion(params: {
  skuId: string;
  taskType: "emptying" | "filling_capping" | "rtsing" | "prefilled_rtsing";
  quantity: number;
  notes: string | null;
  actorUserId: string | null;
}): TaskCompletionResult {
  const product = demoProducts.find(p => p.id === params.skuId);
  if (!product) return { ok: false, reason: "unknown_sku" };

  const inventory = demoInventory.find(inv => inv.sku_id === params.skuId);
  if (!inventory) return { ok: false, reason: "unknown_sku" };

  const movement = TASK_MOVEMENTS[params.taskType];
  const taskLabel = params.taskType.replace(/_/g, " ");

  // Filling & Capping: no bucket move, just log that work was done.
  if (!movement) {
    addMetadataEntry({
      skuId: params.skuId,
      field: "warehouse_in_production",
      transactionType: "task_logged",
      performedBy: params.actorUserId,
      notes: `${product.sku}: ${params.quantity} units ${taskLabel}${params.notes ? ` — ${params.notes}` : ""}`,
    });
    return { ok: true };
  }

  // Validate enough stock in the source bucket.
  const available = inventory[movement.from!] as number;
  if (available < params.quantity) {
    return { ok: false, reason: "insufficient_source_stock", available };
  }

  // Mutate in place.
  (inventory[movement.from!] as number) -= params.quantity;
  (inventory[movement.to!] as number) += params.quantity;

  addCategoryMoveEntry({
    skuId: params.skuId,
    quantity: params.quantity,
    fromField: movement.from!,
    toField: movement.to!,
    transactionType: "task_logged",
    performedBy: params.actorUserId,
    notes: `${product.sku}: ${taskLabel} completed${params.notes ? ` — ${params.notes}` : ""}`,
  });

  return { ok: true };
}

/**
 * Archive (soft-delete) a SKU: hide from default inventory views but
 * keep all historical data intact. Parallels the SQL archive_sku() function.
 *
 * Refuses if the SKU has on-hand inventory (force=false). Pass force=true to
 * archive anyway (e.g., discontinued line with write-off in progress).
 */
export function archiveSku(
  productId: string,
  actorUserId: string | null,
  reason: string,
  opts: { force?: boolean } = {}
): { ok: boolean; error?: string; onHand?: number } {
  const product = demoProducts.find(p => p.id === productId);
  if (!product) return { ok: false, error: "sku not found" };
  if ((product as ProductSKU & { archived_at?: string | null }).archived_at) {
    return { ok: false, error: "already archived" };
  }

  const inv = demoInventory.find(i => i.sku_id === productId);
  // Warehouse-only on-hand check. Pre-migration 041 this also summed the
  // legacy in_transit_* / nancy_* / yx_* columns; those are gone now and
  // transit/on-order are tracked in freight_shipments / factory_orders
  // respectively. A SKU with in-flight freight or pending factory orders
  // can still be archived via this demo helper — the real archive_sku
  // RPC is where the production rule lives.
  const onHand = inv
    ? inv.warehouse_raw + inv.warehouse_in_production + inv.warehouse_finished + inv.warehouse_other
    : 0;

  if (onHand > 0 && !opts.force) {
    return { ok: false, error: "has_on_hand_stock", onHand };
  }

  // Augment product record with archive metadata (the real schema has these columns).
  const p = product as ProductSKU & {
    archived_at?: string | null;
    archived_by?: string | null;
    archive_reason?: string | null;
  };
  p.archived_at = new Date().toISOString();
  p.archived_by = actorUserId;
  p.archive_reason = reason;
  product.is_active = false;

  addMetadataEntry({
    skuId: productId,
    field: "archived_at",
    transactionType: opts.force ? "sku_archived_force" : "sku_archived",
    performedBy: actorUserId,
    notes: `${product.sku} archived${opts.force && onHand > 0 ? ` (force, ${onHand} on-hand units)` : ""}: ${reason}`,
    referenceId: productId,
    referenceType: "product_sku",
  });
  return { ok: true };
}

/** Restore an archived SKU. */
export function restoreSku(productId: string, actorUserId: string | null): boolean {
  const product = demoProducts.find(p => p.id === productId) as
    & ProductSKU
    & { archived_at?: string | null; archived_by?: string | null; archive_reason?: string | null };
  if (!product) return false;
  if (!product.archived_at) return false;

  product.archived_at = null;
  product.archived_by = null;
  product.archive_reason = null;
  product.is_active = true;

  addMetadataEntry({
    skuId: productId,
    field: "archived_at",
    transactionType: "sku_restored",
    performedBy: actorUserId,
    notes: `${product.sku} restored from archive`,
    referenceId: productId,
    referenceType: "product_sku",
  });
  return true;
}

/**
 * Demo-mode parity for rpc_update_user_role. Enforces the same RBAC rules:
 *   - actor must be admin or manager
 *   - no self-role-edits
 *   - managers cannot grant admin
 *   - managers cannot change an existing admin's role
 * Writes a metadata audit entry on success.
 */
export function updateUserRole(
  targetUserId: string,
  newRole: "admin" | "manager" | "user",
  actorUserId: string | null
): { ok: boolean; error?: string; previousRole?: string; newRole?: string } {
  const actor = demoUsers.find(u => u.id === actorUserId);
  const target = demoUsers.find(u => u.id === targetUserId);
  if (!actor) return { ok: false, error: "actor not found" };
  if (!target) return { ok: false, error: "target not found" };
  if (!["admin", "manager"].includes(actor.role)) {
    return { ok: false, error: "only admins and managers can change roles" };
  }
  if (actor.id === target.id) {
    return { ok: false, error: "cannot change your own role" };
  }
  if (actor.role === "manager" && newRole === "admin") {
    return { ok: false, error: "managers cannot grant admin role" };
  }
  if (actor.role === "manager" && target.role === "admin") {
    return { ok: false, error: "managers cannot change an admin role" };
  }
  if (target.role === newRole) {
    return { ok: true, newRole, previousRole: target.role };
  }

  const previous = target.role;
  target.role = newRole;

  addMetadataEntry({
    skuId: null,
    field: "role",
    transactionType: "user_role_change",
    performedBy: actorUserId,
    notes: `${target.full_name}: role changed ${previous} → ${newRole} by ${actor.full_name}`,
    referenceId: targetUserId,
    referenceType: "profile",
  });

  return { ok: true, previousRole: previous, newRole };
}

export function isSkuArchived(productId: string): boolean {
  const product = demoProducts.find(p => p.id === productId) as
    (ProductSKU & { archived_at?: string | null }) | undefined;
  return !!product?.archived_at;
}

/**
 * Toggle a product's is_active status.
 * In production this would be a Supabase update; in demo mode we mutate in place.
 * Logs a metadata audit entry with the acting user.
 */
export function toggleProductActive(productId: string, actorUserId: string | null): boolean {
  const product = demoProducts.find(p => p.id === productId);
  if (!product) return false;
  const previous = product.is_active;
  product.is_active = !product.is_active;
  addMetadataEntry({
    skuId: productId,
    field: "is_active",
    transactionType: "sku_active_toggle",
    performedBy: actorUserId,
    notes: `${product.sku}: ${previous ? "active" : "inactive"} → ${product.is_active ? "active" : "inactive"}`,
  });
  return product.is_active;
}

// `setDemandOverride` (in-memory demo mutator) deleted — no callers.
// Real-data path: useSetDemandOverride hook → demand_overrides table.

// `generateHistoricalSnapshots` moved to src/lib/demand.ts.

// Demo user directory — shared across Settings/UserManagement + ChangeLog
export interface DemoUser {
  id: string;
  full_name: string;
  email: string;
  role: "admin" | "manager" | "user";
  last_active: string;
  created_at: string;
  is_active: boolean;
  /** Linked Homebase employee id, or null if not linked. Drives labor-hours lookup. */
  homebase_employee_id: string | null;
  /** Snapshot of the Homebase employee's name at link time (for display without a lookup). */
  homebase_employee_name: string | null;
}

export const demoUsers: DemoUser[] = [
  { id: "demo-user", full_name: "Chase (Admin)", email: "admin@freezepipe.com", role: "admin", last_active: "2026-04-02T10:30:00Z", created_at: "2025-01-15T00:00:00Z", is_active: true, homebase_employee_id: null, homebase_employee_name: null },
  { id: "emp1", full_name: "Mike Torres", email: "mike@freezepipe.com", role: "user", last_active: "2026-04-02T10:30:00Z", created_at: "2025-03-01T00:00:00Z", is_active: true, homebase_employee_id: "hb-1001", homebase_employee_name: "Mike Torres" },
  { id: "emp2", full_name: "Sarah Chen", email: "sarah@freezepipe.com", role: "user", last_active: "2026-04-02T09:45:00Z", created_at: "2025-03-15T00:00:00Z", is_active: true, homebase_employee_id: "hb-1002", homebase_employee_name: "Sarah Chen" },
  { id: "emp3", full_name: "James Park", email: "james@freezepipe.com", role: "user", last_active: "2026-04-02T09:50:00Z", created_at: "2025-06-01T00:00:00Z", is_active: true, homebase_employee_id: null, homebase_employee_name: null },
  { id: "mgr1", full_name: "Lisa Wang", email: "lisa@freezepipe.com", role: "manager", last_active: "2026-04-01T17:00:00Z", created_at: "2025-02-01T00:00:00Z", is_active: true, homebase_employee_id: null, homebase_employee_name: null },
];

/** A Homebase employee record — what the Homebase API would return. */
export interface HomebaseEmployee {
  id: string;        // Homebase-internal id
  full_name: string;
  email: string | null;
  is_active: boolean;
}

/**
 * Mocked Homebase employee directory. In production this is fetched from the
 * Homebase API (GET /employees) and cached with a periodic sync.
 */
export const demoHomebaseEmployees: HomebaseEmployee[] = [
  { id: "hb-1001", full_name: "Mike Torres", email: "mike.t@homebase", is_active: true },
  { id: "hb-1002", full_name: "Sarah Chen", email: "sarah.c@homebase", is_active: true },
  { id: "hb-1003", full_name: "James Park", email: "james.p@homebase", is_active: true },
  { id: "hb-1004", full_name: "Lisa Wang", email: "lisa.w@homebase", is_active: true },
  { id: "hb-1099", full_name: "Danielle Reyes", email: "danielle.r@homebase", is_active: true },
];

export function getHomebaseEmployee(id: string | null): HomebaseEmployee | null {
  if (!id) return null;
  return demoHomebaseEmployees.find(e => e.id === id) ?? null;
}

/** Which Homebase employees haven't been linked to an ERP user yet. */
export function getUnlinkedHomebaseEmployees(): HomebaseEmployee[] {
  const linkedIds = new Set(demoUsers.map(u => u.homebase_employee_id).filter((x): x is string => !!x));
  return demoHomebaseEmployees.filter(e => !linkedIds.has(e.id) && e.is_active);
}

/**
 * Link an ERP user to a Homebase employee. Logs an audit entry and mutates
 * demoUsers in place. Returns true on success.
 */
export function linkUserToHomebase(
  userId: string,
  homebaseEmployeeId: string,
  actorUserId: string | null
): boolean {
  const user = demoUsers.find(u => u.id === userId);
  const hb = demoHomebaseEmployees.find(e => e.id === homebaseEmployeeId);
  if (!user || !hb) return false;

  // Prevent linking the same Homebase employee to multiple users.
  if (demoUsers.some(u => u.homebase_employee_id === homebaseEmployeeId && u.id !== userId)) {
    return false;
  }

  const previous = user.homebase_employee_name;
  user.homebase_employee_id = hb.id;
  user.homebase_employee_name = hb.full_name;

  addMetadataEntry({
    skuId: null,
    field: "homebase_employee_id",
    transactionType: "user_homebase_link",
    performedBy: actorUserId,
    notes: `Linked ${user.full_name} to Homebase: ${previous ? previous + " → " : ""}${hb.full_name}`,
    referenceId: userId,
    referenceType: "user",
  });
  return true;
}

/** Remove the Homebase link from an ERP user. */
export function unlinkUserFromHomebase(userId: string, actorUserId: string | null): boolean {
  const user = demoUsers.find(u => u.id === userId);
  if (!user || !user.homebase_employee_id) return false;

  const previous = user.homebase_employee_name;
  user.homebase_employee_id = null;
  user.homebase_employee_name = null;

  addMetadataEntry({
    skuId: null,
    field: "homebase_employee_id",
    transactionType: "user_homebase_unlink",
    performedBy: actorUserId,
    notes: `Unlinked ${user.full_name} from Homebase (was: ${previous})`,
    referenceId: userId,
    referenceType: "user",
  });
  return true;
}

export function getUserDisplayName(userId: string | null): string {
  if (!userId) return "System";
  return demoUsers.find(u => u.id === userId)?.full_name ?? userId;
}

// Demo audit log entries
/**
 * A movement's kind determines how the quantity is interpreted:
 *
 * - "net_change"    — true +/- to total inventory. Comes from cycle counts,
 *                     ShipStation sales, or a brand-new factory order being placed.
 * - "category_move" — units shift from one bucket to another (e.g. warehouse_raw
 *                     → warehouse_in_production when a task is logged). Total
 *                     inventory is unchanged; only the category changes.
 * - "metadata"      — no inventory impact at all. Status flips, demand overrides,
 *                     ETA updates, SKU active toggles. Quantity is ignored.
 */
export type MovementKind = "net_change" | "category_move" | "metadata";

export interface AuditLogEntry {
  id: string;
  /** Null for shipment- or order-level events that don't belong to a single SKU. */
  sku_id: string | null;
  transaction_type: string;
  quantity: number;
  /** For net_change: the single bucket the delta hits.
   *  For category_move: the destination (also populated as to_field).
   *  For metadata: the field name that changed (e.g. "status", "demand_override"). */
  field_affected: string;
  movement_kind: MovementKind;
  /** Populated for category_move — the bucket the units came from. */
  from_field: string | null;
  /** Populated for category_move — the bucket the units landed in. */
  to_field: string | null;
  reference_id: string | null;
  reference_type: string | null;
  notes: string | null;
  /** Null when the action was taken by the system (e.g., automated tracking). */
  performed_by: string | null;
  created_at: string;
}

export const demoAuditLog: AuditLogEntry[] = [
  // Cycle counts — true net changes (adjustments to total inventory)
  { id: "al1", sku_id: "1", transaction_type: "cycle_count", quantity: 5, field_affected: "warehouse_finished", movement_kind: "net_change", from_field: null, to_field: null, reference_id: null, reference_type: null, notes: "Cycle count adjustment +5", performed_by: "demo-user", created_at: "2026-04-01T14:30:00Z" },
  { id: "al7", sku_id: "13", transaction_type: "cycle_count", quantity: -3, field_affected: "warehouse_finished", movement_kind: "net_change", from_field: null, to_field: null, reference_id: null, reference_type: null, notes: "Cycle count adjustment -3 (breakage)", performed_by: "demo-user", created_at: "2026-03-30T16:00:00Z" },

  // Task logs — units move between warehouse categories (no net change)
  { id: "al2", sku_id: "3", transaction_type: "task_logged", quantity: 8, field_affected: "warehouse_finished", movement_kind: "category_move", from_field: "warehouse_in_production", to_field: "warehouse_finished", reference_id: "t3", reference_type: "task_log", notes: "RTS completed", performed_by: "emp3", created_at: "2026-04-02T08:50:00Z" },
  { id: "al6", sku_id: "1", transaction_type: "task_logged", quantity: 12, field_affected: "warehouse_in_production", movement_kind: "category_move", from_field: "warehouse_raw", to_field: "warehouse_in_production", reference_id: "t1", reference_type: "task_log", notes: "Emptying completed", performed_by: "emp1", created_at: "2026-04-02T08:25:00Z" },

  // Freight status change — metadata flip on the shipment row
  { id: "al3", sku_id: "3", transaction_type: "freight_status_change", quantity: 0, field_affected: "status", movement_kind: "metadata", from_field: null, to_field: null, reference_id: "f2", reference_type: "freight_shipment", notes: "Marked high risk - customs inspection", performed_by: "demo-user", created_at: "2026-03-28T10:15:00Z" },

  // ShipStation sale — true net out (leaves the system entirely)
  { id: "al4", sku_id: "36", transaction_type: "order_shipped", quantity: -12, field_affected: "warehouse_finished", movement_kind: "net_change", from_field: null, to_field: null, reference_id: "SS-10432", reference_type: "shipstation_order", notes: "ShipStation order shipped", performed_by: null, created_at: "2026-04-02T11:00:00Z" },

  // Freight delivery — units move from in_transit to warehouse_raw (no net change)
  { id: "al5", sku_id: "7", transaction_type: "freight_delivered", quantity: 96, field_affected: "warehouse_raw", movement_kind: "category_move", from_field: "in_transit_sea", to_field: "warehouse_raw", reference_id: "f4", reference_type: "freight_shipment", notes: "SEA-2026-0220 delivered", performed_by: "demo-user", created_at: "2026-03-24T09:00:00Z" },

  // Factory order stage progression — units move from ordered to finished at factory
  { id: "al8", sku_id: "9", transaction_type: "factory_order_update", quantity: 200, field_affected: "nancy_finished", movement_kind: "category_move", from_field: "nancy_ordered", to_field: "nancy_finished", reference_id: "fo1", reference_type: "factory_order", notes: "Nancy batch partially finished", performed_by: "demo-user", created_at: "2026-03-31T08:00:00Z" },
];

let auditIdCounter = demoAuditLog.length;

// --- External-store subscription so UI views stay in sync --------------------
// demoAuditLog is a module-level array; React components can't detect mutations
// to it. We notify subscribers after every write so hooks like useAuditLog can
// re-render. In production this goes away (replaced by TanStack Query on a
// Supabase realtime channel).
const auditSubscribers = new Set<() => void>();

export function subscribeToAuditLog(listener: () => void): () => void {
  auditSubscribers.add(listener);
  return () => auditSubscribers.delete(listener);
}

export function getAuditLogVersion(): number {
  return auditVersion;
}

let auditVersion = 0;
function notifyAuditLog(): void {
  auditVersion++;
  auditSubscribers.forEach(fn => fn());
}

/** Append a new audit log entry. In production this would be a Supabase insert. */
export function addAuditEntry(entry: Omit<AuditLogEntry, "id" | "created_at"> & { created_at?: string }): AuditLogEntry {
  const full: AuditLogEntry = {
    id: `al-runtime-${++auditIdCounter}`,
    created_at: entry.created_at ?? new Date().toISOString(),
    ...entry,
  };
  demoAuditLog.push(full);
  notifyAuditLog();
  return full;
}

// --- Typed helpers so callers can't forget the movement_kind ---------------

/** Net change to total inventory (cycle counts, ShipStation sales, factory order placement). */
export function addNetChangeEntry(params: {
  skuId: string | null;
  quantity: number; // signed
  field: string;
  transactionType: string;
  performedBy: string | null;
  notes: string;
  referenceId?: string | null;
  referenceType?: string | null;
}): AuditLogEntry {
  return addAuditEntry({
    sku_id: params.skuId,
    transaction_type: params.transactionType,
    quantity: params.quantity,
    field_affected: params.field,
    movement_kind: "net_change",
    from_field: null,
    to_field: null,
    reference_id: params.referenceId ?? null,
    reference_type: params.referenceType ?? null,
    notes: params.notes,
    performed_by: params.performedBy,
  });
}

/** Units moving between categories (task logs, freight delivery, factory stages). */
export function addCategoryMoveEntry(params: {
  skuId: string | null;
  quantity: number; // unsigned — it's the count that moved
  fromField: string;
  toField: string;
  transactionType: string;
  performedBy: string | null;
  notes: string;
  referenceId?: string | null;
  referenceType?: string | null;
}): AuditLogEntry {
  return addAuditEntry({
    sku_id: params.skuId,
    transaction_type: params.transactionType,
    quantity: Math.abs(params.quantity),
    field_affected: params.toField,
    movement_kind: "category_move",
    from_field: params.fromField,
    to_field: params.toField,
    reference_id: params.referenceId ?? null,
    reference_type: params.referenceType ?? null,
    notes: params.notes,
    performed_by: params.performedBy,
  });
}

/** Status/metadata changes — no inventory impact. */
export function addMetadataEntry(params: {
  skuId: string | null;
  field: string;
  transactionType: string;
  performedBy: string | null;
  notes: string;
  referenceId?: string | null;
  referenceType?: string | null;
}): AuditLogEntry {
  return addAuditEntry({
    sku_id: params.skuId,
    transaction_type: params.transactionType,
    quantity: 0,
    field_affected: params.field,
    movement_kind: "metadata",
    from_field: null,
    to_field: null,
    reference_id: params.referenceId ?? null,
    reference_type: params.referenceType ?? null,
    notes: params.notes,
    performed_by: params.performedBy,
  });
}

// Removed: computeInventoryTotals — it summed the legacy in_transit_* /
// nancy_* / yx_* columns on inventory_levels that were dropped in
// migration 041. Callers should use `inventoryTotalsReal` from
// src/lib/inventory-aggregates.ts, which derives In Transit + On Order
// from freight_shipments and factory_orders respectively.

/**
 * Supplier / vendor master — mirror of the `suppliers` DB table.
 * The `factory` enum ("nancy" | "yx") is being replaced by supplier_id.
 * During the transition the enum values double as legacy codes on the supplier row.
 */
export interface Supplier {
  id: string;
  code: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  country: string;
  default_lead_time_days: number | null;
  payment_terms: string | null;
  invoice_currency: string;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export const demoSuppliers: Supplier[] = [
  {
    id: "00000000-0000-0000-0000-000000000201",
    code: "NANCY",
    name: "Nancy (Glass)",
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    country: "CN",
    default_lead_time_days: 45,
    payment_terms: "30% deposit, 70% on shipment",
    invoice_currency: "CNY",
    notes: "Glass products: pipes, bongs, bubblers, dab rigs, ash catchers, bases.",
    is_active: true,
    created_at: "",
    updated_at: "",
  },
  {
    id: "00000000-0000-0000-0000-000000000202",
    code: "YX",
    name: "YX (Hardware)",
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    country: "CN",
    default_lead_time_days: 35,
    payment_terms: "Net 30",
    invoice_currency: "CNY",
    notes: "Hardware and accessories: bowls, coils, joint chillers, accessories, studio.",
    is_active: true,
    created_at: "",
    updated_at: "",
  },
];

export function getSupplier(supplierId: string): Supplier | undefined {
  return demoSuppliers.find(s => s.id === supplierId);
}

export function getSupplierByCode(code: string): Supplier | undefined {
  return demoSuppliers.find(s => s.code === code);
}

/**
 * Legacy code → supplier id. Used while code paths are being migrated.
 * Prefer `getSupplierByCode` in new code; this is strictly for bridging
 * places that still use the `'nancy' | 'yx'` string literals.
 */
const LEGACY_CODE_TO_SUPPLIER_ID: Record<"nancy" | "yx", string> = {
  nancy: "00000000-0000-0000-0000-000000000201",
  yx: "00000000-0000-0000-0000-000000000202",
};

export function supplierIdFromLegacyCode(code: "nancy" | "yx"): string {
  return LEGACY_CODE_TO_SUPPLIER_ID[code];
}

/**
 * Primary supplier assignment per SKU (returns a supplier id).
 * Glass categories default to Nancy; everything else defaults to YX.
 * Individual SKUs can be overridden via SKU_SUPPLIER_OVERRIDES.
 */
const SKU_SUPPLIER_OVERRIDES: Record<string, string> = {};

export function getPrimarySupplierId(skuId: string): string {
  if (SKU_SUPPLIER_OVERRIDES[skuId]) return SKU_SUPPLIER_OVERRIDES[skuId];
  const product = demoProducts.find(p => p.id === skuId);
  if (!product) return LEGACY_CODE_TO_SUPPLIER_ID.nancy;
  const nancyCategories = ["Pipes", "Bongs", "Bubblers", "Dab Rigs", "Ash Catchers", "Bases"];
  return nancyCategories.includes(product.display_category)
    ? LEGACY_CODE_TO_SUPPLIER_ID.nancy
    : LEGACY_CODE_TO_SUPPLIER_ID.yx;
}

// Math helpers (computeDOS, computeManufacturingPriority, computeSKUCosts)
// were moved to src/lib/inventory-math.ts during the demo-data split.
// Demand helpers (getEffectiveDemand, getProductForecast,
// generateHistoricalSnapshots) moved to src/lib/demand.ts.
//
// `getPrimaryFactory` (the @deprecated string-enum shim) was deleted —
// no callers remained after the supplier_id migration in 017.
