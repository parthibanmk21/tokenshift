// This file holds the main code for plugins. Code in this file has access to
// the *figma document* via the figma global object.

/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 1200, height: 700 });

interface ParsedVariable {
  name: string;
  value: any;
  type: "Color" | "Number" | "String" | "Boolean";
  safeName?: string;
  status?: "NEW" | "OVERRIDE";
}

// Convert Figma's internal RGB object back to HEX for the UI Diff
function figmaColorToHex(value: any): string {
  if (!value || typeof value.r !== 'number') return String(value);
  const toHex = (n: number) => {
    const hex = Math.round(n * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  let hex = `#${toHex(value.r)}${toHex(value.g)}${toHex(value.b)}`;
  if (value.a !== undefined && value.a < 1) {
    hex += toHex(value.a); // Support alpha transparency representation
  }
  return hex.toUpperCase();
}

// Parses string to Figma's exact {r, g, b, a} color format
function parseColor(colorStr: string) {
  colorStr = colorStr.trim();
  
  if (/^#/.test(colorStr)) {
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
  return { r: 0, g: 0, b: 0, a: 1 };
}

// Smart comparison to detect if a value actually changed
function isValueChanged(figmaType: string, figmaValue: any, incomingValue: any) {
  if (figmaType === 'COLOR') {
    const parsed = parseColor(String(incomingValue));
    const rDiff = Math.abs((figmaValue.r || 0) - parsed.r) > 0.005;
    const gDiff = Math.abs((figmaValue.g || 0) - parsed.g) > 0.005;
    const bDiff = Math.abs((figmaValue.b || 0) - parsed.b) > 0.005;
    const aDiff = Math.abs((figmaValue.a ?? 1) - parsed.a) > 0.005;
    return rDiff || gDiff || bDiff || aDiff;
  }
  if (figmaType === 'FLOAT') return Number(figmaValue) !== Number(incomingValue);
  if (figmaType === 'BOOLEAN') return Boolean(figmaValue) !== (incomingValue === 'true' || incomingValue === true);
  return String(figmaValue) !== String(incomingValue);
}

// Listen from UI
figma.ui.onmessage = async (msg) => {
  if (msg.type === "NOTIFY") {
    figma.notify(msg.message);
    return;
  }

  // Step 1: UI asks backend to prepare the Diff List
  if (msg.type === "CHECK_EXISTING") {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const collection = collections.find(c => c.name === "TokenShift");
    
    let existingVariables: Variable[] = [];
    if (collection) {
      const allVariables = await figma.variables.getLocalVariablesAsync();
      existingVariables = allVariables.filter(v => v.variableCollectionId === collection.id);
    }

    // Filter Diff Array to ONLY include New or Changed items
    const diffData: any[] = [];
    
    msg.data.forEach((incoming: ParsedVariable) => {
      const safeName = incoming.name.replace(/[{}.]/g, '_');
      const existing = existingVariables.find(v => v.name === safeName);
      
      if (!existing) {
        diffData.push({ ...incoming, safeName, oldValue: null, status: 'NEW' });
      } else if (collection) {
        const rawVal = existing.valuesByMode[collection.modes[0].modeId];
        const changed = isValueChanged(existing.resolvedType, rawVal, incoming.value);
        
        if (changed) {
          let oldValueStr = String(rawVal);
          if (existing.resolvedType === 'COLOR') oldValueStr = figmaColorToHex(rawVal);
          diffData.push({ ...incoming, safeName, oldValue: oldValueStr, status: 'OVERRIDE' });
        }
      }
    });

    if (diffData.length === 0) {
      figma.notify("✅ Everything is already up to date. No changes needed.");
      return;
    }

    const hasOverrides = diffData.some(d => d.status === 'OVERRIDE');

    if (hasOverrides) figma.ui.postMessage({ type: "PROMPT_OVERRIDE", data: diffData });
    else figma.ui.postMessage({ type: "SYNC_READY", data: diffData });
  }

  // Step 2: Final Execution 
  if (msg.type === "SYNC_VARIABLES") {
    await executeSync(msg.data);
  }
};

// Main Execution Function
async function executeSync(variables: ParsedVariable[]) {
  if (variables.length === 0) return; 

  try {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    let collection = collections.find(c => c.name === "TokenShift");
    
    if (!collection) collection = figma.variables.createVariableCollection("TokenShift");

    const allVariables = await figma.variables.getLocalVariablesAsync();
    const existingVariables = allVariables.filter(v => v.variableCollectionId === collection!.id);
    
    let created = 0, updated = 0, failed = 0;

    for (const v of variables) {
      try {
          const safeName = v.safeName || v.name.replace(/[{}.]/g, '_');

          let figmaType: VariableResolvedDataType;
          switch(v.type) {
              case "Color": figmaType = "COLOR"; break;
              case "Number": figmaType = "FLOAT"; break;
              case "Boolean": figmaType = "BOOLEAN"; break;
              case "String": default: figmaType = "STRING"; break;
          }

          let variable = existingVariables.find(ev => ev.name === safeName);

          if (!variable) {
              // @ts-ignore
              variable = figma.variables.createVariable(safeName, collection, figmaType);
              created++;
          } else {
              if (variable.resolvedType !== figmaType) continue;
              updated++;
          }

          let finalValue: VariableValue = v.value;
          if (figmaType === "COLOR") finalValue = parseColor(String(v.value));
          else if (figmaType === "FLOAT") finalValue = Number(v.value);
          else if (figmaType === "BOOLEAN") finalValue = Boolean(v.value);
          else if (figmaType === "STRING") finalValue = String(v.value);

          variable.setValueForMode(collection.modes[0].modeId, finalValue);
      } catch(err) {
          console.error(`Error with ${v.name}:`, err);
          failed++; 
      }
    }

    let msg = `✅ Sync complete! Created: ${created}`;
    if (updated > 0) msg += `, Updated: ${updated}`;
    if (failed > 0) msg += ` ⚠️ Failed: ${failed}`;
    figma.notify(msg);

  } catch (e: any) {
    console.error(e);
    figma.notify(`❌ Sync Error: ${e.message}`);
  }
}