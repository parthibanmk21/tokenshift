// This file holds the main code for plugins. Code in this file has access to
// the *figma document* via the figma global object.

/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 1200, height: 700 });

interface ParsedVariable {
  name: string;
  value: any;
  type: "Color" | "Number" | "String" | "Boolean";
}

// Listen from UI
figma.ui.onmessage = async (msg) => {
  if (msg.type === "SYNC_VARIABLES") {
    try {
      const result = await syncVariablesToFigma(msg.data);
      figma.notify(`✅ Synced! Created: ${result.created}, Updated: ${result.updated}`);
    } catch (e: any) {
      console.error(e);
      figma.notify(`❌ Sync Error: ${e.message}`);
    }
  }
};

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

// Main execution process directly bridging UI arrays to Figma Variables
async function syncVariablesToFigma(variables: ParsedVariable[]) {
  // Use the new Async methods required by Figma
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let collection = collections.find(c => c.name === "TokenShift");
  
  if (!collection) {
    collection = figma.variables.createVariableCollection("TokenShift");
  }

  // Pre-load existing variables using Async to prevent duplicates/crashing
  const allVariables = await figma.variables.getLocalVariablesAsync();
  const existingVariables = allVariables.filter(v => v.variableCollectionId === collection!.id);
  
  let created = 0;
  let updated = 0;

  for (const v of variables) {
    // Map UI types to Figma backend types
    let figmaType: VariableResolvedDataType;
    switch(v.type) {
        case "Color": figmaType = "COLOR"; break;
        case "Number": figmaType = "FLOAT"; break;
        case "Boolean": figmaType = "BOOLEAN"; break;
        case "String": default: figmaType = "STRING"; break;
    }

    // Identify if the variable already exists to update it rather than creating a duplicate
    let variable = existingVariables.find(ev => ev.name === v.name);

    if (!variable) {
        // FIX: Passed `collection` directly instead of `collection.id`
        variable = figma.variables.createVariable(v.name, collection, figmaType);
        created++;
    } else {
        // Prevent fatal errors if user changed a type of an existing variable key
        if (variable.resolvedType !== figmaType) {
            console.warn(`Skipped updating ${v.name}: Type mismatch in Figma.`);
            continue;
        }
        updated++;
    }

    // Resolve Value Formats
    let finalValue = v.value;
    if (figmaType === "COLOR") {
        finalValue = parseColor(String(v.value));
    }

    // Apply the update to Figma Core
    variable.setValueForMode(collection.modes[0].modeId, finalValue);
  }

  return { created, updated };
}