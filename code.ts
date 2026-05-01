// This plugin will open a window to prompt the user to enter a number, and
// it will then create that many rectangles on the screen.

// This file holds the main code for plugins. Code in this file has access to
// the *figma document* via the figma global object.
// You can access browser APIs in the <script> tag inside "ui.html" which has a
// full browser environment (See https://www.figma.com/plugin-docs/how-plugins-run).

// This shows the HTML page in "ui.html".
/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 900, height: 700 });

// Listen from UI
figma.ui.onmessage = async (msg) => {
  if (msg.type === "IMPORT_JSON") {
    try {
      const data = JSON.parse(msg.data);
      await processJSON(data);
      figma.notify("✅ Variables created successfully");
    } catch (e) {
      figma.notify("❌ Invalid JSON");
    }
  }
};

// Flatten JSON
function flatten(obj: any, parent = "", res: any = {}) {
  for (let key in obj) {
    const propName = parent ? `${parent}/${key}` : key;

    if (typeof obj[key] === "object" && obj[key] !== null) {
      flatten(obj[key], propName, res);
    } else {
      res[propName] = obj[key];
    }
  }
  return res;
}

// Detect type
function detectType(value: any) {
  if (typeof value === "number") return "FLOAT";
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "string") {
    if (/^#([0-9A-F]{3}){1,2}$/i.test(value)) return "COLOR";
    return "STRING";
  }
}

// HEX → RGB
function hexToRgb(hex: string) {
  const bigint = parseInt(hex.slice(1), 16);
  return {
    r: ((bigint >> 16) & 255) / 255,
    g: ((bigint >> 8) & 255) / 255,
    b: (bigint & 255) / 255,
    a: 1
  };
}

// Main processor
async function processJSON(data: any) {
  const flat = flatten(data);

  const collection = figma.variables.createVariableCollection("TokenShift");

  for (const key in flat) {
    const value = flat[key];
    const type = detectType(value);

    if (!type) continue;

    const variable = figma.variables.createVariable(
      key,
      collection.id,
      type as VariableResolvedDataType
    );

    let finalValue = value;

    if (type === "COLOR") {
      finalValue = hexToRgb(value);
    }

    variable.setValueForMode(collection.modes[0].modeId, finalValue);
  }
}