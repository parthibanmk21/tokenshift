// This file holds the main code for plugins. Code in this file has access to
// the *figma document* via the figma global object.

/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 1200, height: 700 });

// Listen from UI
figma.ui.onmessage = async (msg) => {
  if (msg.type === "IMPORT_JSON") {
    try {
      const data = JSON.parse(msg.data);
      await processJSON(data);
      figma.notify("✅ Variables created successfully");
    } catch (e) {
      figma.notify("❌ Invalid JSON format");
    }
  }
};

// Flatten JSON to handle deeply nested objects
function flatten(obj: any, parent = "", res: any = {}) {
  for (let key in obj) {
    const propName = parent ? `${parent}/${key}` : key;

    if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
      flatten(obj[key], propName, res);
    } else {
      res[propName] = obj[key];
    }
  }
  return res;
}

// Detect primitive type
function detectType(value: any) {
  if (typeof value === "number") return "FLOAT";
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "string") {
    // Supports HEX and rgb/rgba
    if (/^#([0-9A-F]{3}){1,2}$/i.test(value) || /^rgba?\(/i.test(value)) return "COLOR";
    return "STRING";
  }
}

// Parses string to Figma's exact {r, g, b, a} color format
function parseColor(colorStr: string) {
  colorStr = colorStr.trim();
  
  if (/^#/.test(colorStr)) {
    // HEX parsing
    let hex = colorStr.replace('#', '');
    if (hex.length === 3) {
      hex = hex.split('').map(char => char + char).join('');
    }
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    const a = hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  } else if (/^rgba?/.test(colorStr)) {
    // RGB/RGBA parsing
    const match = colorStr.match(/[\d.]+/g);
    if (match && match.length >= 3) {
      return {
        r: parseFloat(match[0]) / 255,
        g: parseFloat(match[1]) / 255,
        b: parseFloat(match[2]) / 255,
        a: match.length === 4 ? parseFloat(match[3]) : 1
      };
    }
  }
  // Fallback to solid black
  return { r: 0, g: 0, b: 0, a: 1 };
}

// Main processor
async function processJSON(data: any) {
  const flat = flatten(data);

  // Check if collection exists to avoid duplicates, else create it
  let collection = figma.variables.getLocalVariableCollections().find(c => c.name === "TokenShift");
  if (!collection) {
    collection = figma.variables.createVariableCollection("TokenShift");
  }

  for (const key in flat) {
    const value = flat[key];
    const type = detectType(value);

    if (!type) continue;

    // Notice: Figma automatically turns "path/to/var" into grouped folders!
    const variable = figma.variables.createVariable(
      key,
      collection.id,
      type as VariableResolvedDataType
    );

    let finalValue = value;

    if (type === "COLOR") {
      finalValue = parseColor(value as string);
    }

    variable.setValueForMode(collection.modes[0].modeId, finalValue);
  }
}