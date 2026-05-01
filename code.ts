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
  // Step 1: UI asks backend to check if variables already exist
  if (msg.type === "CHECK_EXISTING") {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const collection = collections.find(c => c.name === "TokenShift");
    
    if (collection) {
      // If collection exists, let's see if any variables match the incoming names
      const allVariables = await figma.variables.getLocalVariablesAsync();
      const existingVariables = allVariables.filter(v => v.variableCollectionId === collection.id);
      
      const hasOverlap = msg.data.some((incoming: ParsedVariable) => 
        existingVariables.some(existing => existing.name === incoming.name.replace(/[{}.]/g, '_'))
      );

      if (hasOverlap) {
        // Trigger dialog in UI
        figma.ui.postMessage({ type: "PROMPT_OVERRIDE" });
        return; 
      }
    }
    // No collection or no overlap? Just sync directly.
    await executeSync(msg.data, "OVERRIDE_ALL");
  }

  // Step 2: UI confirms sync strategy
  if (msg.type === "SYNC_VARIABLES") {
    await executeSync(msg.data, msg.overrideMode);
  }
};

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

// Main Execution Function taking the overrideMode into account
async function executeSync(variables: ParsedVariable[], overrideMode: "NEW_ONLY" | "OVERRIDE_ALL") {
  try {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    let collection = collections.find(c => c.name === "TokenShift");
    
    if (!collection) {
      collection = figma.variables.createVariableCollection("TokenShift");
    }

    const allVariables = await figma.variables.getLocalVariablesAsync();
    const existingVariables = allVariables.filter(v => v.variableCollectionId === collection!.id);
    
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const v of variables) {
      try {
          // SAFEGUARD 1: Figma names cannot contain {, }, or .
          const safeName = v.name.replace(/[{}.]/g, '_');

          let figmaType: VariableResolvedDataType;
          switch(v.type) {
              case "Color": figmaType = "COLOR"; break;
              case "Number": figmaType = "FLOAT"; break;
              case "Boolean": figmaType = "BOOLEAN"; break;
              case "String": default: figmaType = "STRING"; break;
          }

          let variable = existingVariables.find(ev => ev.name === safeName);

          if (!variable) {
              // SAFEGUARD 2: Passing collection to avoid incremental mode errors
              // @ts-ignore
              variable = figma.variables.createVariable(safeName, collection, figmaType);
              created++;
          } else {
              // It exists. Check user's dialog decision.
              if (overrideMode === "NEW_ONLY") {
                 skipped++;
                 continue; 
              }

              if (variable.resolvedType !== figmaType) {
                  console.warn(`Skipped updating ${safeName}: Type mismatch in Figma.`);
                  skipped++;
                  continue;
              }
              updated++;
          }

          // SAFEGUARD 3: Strictly cast final values to prevent strict-type crashes from Figma API
          let finalValue: VariableValue = v.value;
          if (figmaType === "COLOR") {
              finalValue = parseColor(String(v.value));
          } else if (figmaType === "FLOAT") {
              finalValue = Number(v.value);
          } else if (figmaType === "BOOLEAN") {
              finalValue = Boolean(v.value);
          } else if (figmaType === "STRING") {
              finalValue = String(v.value);
          }

          variable.setValueForMode(collection.modes[0].modeId, finalValue);
      } catch(err) {
          console.error(`Error with ${v.name}:`, err);
          failed++; // Safely fail the single variable and continue loop
      }
    }

    // Report results back to User
    let msg = `✅ Sync complete! Created: ${created}`;
    if (updated > 0) msg += `, Updated: ${updated}`;
    if (skipped > 0) msg += `, Skipped: ${skipped}`;
    if (failed > 0) msg += ` ⚠️ Failed: ${failed}`;

    figma.notify(msg);

  } catch (e: any) {
    console.error(e);
    figma.notify(`❌ Sync Error: ${e.message}`);
  }
}