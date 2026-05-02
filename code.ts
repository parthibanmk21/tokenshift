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

function figmaColorToHex(value: any): string {
  if (!value || typeof value.r !== 'number') return String(value);
  const toHex = (n: number) => {
    const hex = Math.round(n * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  let hex = `#${toHex(value.r)}${toHex(value.g)}${toHex(value.b)}`;
  if (value.a !== undefined && value.a < 1) {
    hex += toHex(value.a); 
  }
  return hex.toUpperCase();
}

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

function isValueChanged(figmaType: string, figmaValue: any, incomingValue: any) {
  const isIncomingAlias = typeof incomingValue === 'string' && incomingValue.trim().startsWith('{') && incomingValue.trim().endsWith('}');
  const isFigmaAlias = typeof figmaValue === 'object' && figmaValue !== null && figmaValue.type === 'VARIABLE_ALIAS';

  if (isIncomingAlias !== isFigmaAlias) return true; 
  if (isIncomingAlias && isFigmaAlias) return true; 

  if (figmaType === 'COLOR') {
    const parsed = parseColor(String(incomingValue));
    const rDiff = Math.abs((figmaValue.r || 0) - parsed.r) > 0.005;
    const gDiff = Math.abs((figmaValue.g || 0) - parsed.g) > 0.005;
    const bDiff = Math.abs((figmaValue.b || 0) - parsed.b) > 0.005;
    const aDiff = Math.abs((figmaValue.a ?? 1) - parsed.a) > 0.005;
    return rDiff || gDiff || bDiff || aDiff;
  }
  
  if (figmaType === 'FLOAT') {
      const fVal = Number(Number(figmaValue).toFixed(2));
      const iVal = Number(parseFloat(String(incomingValue)).toFixed(2));
      return fVal !== iVal;
  }
  
  if (figmaType === 'BOOLEAN') return Boolean(figmaValue) !== (incomingValue === 'true' || incomingValue === true);
  
  return String(figmaValue) !== String(incomingValue);
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === "NOTIFY") {
    figma.notify(msg.message);
    return;
  }

  if (msg.type === "FETCH_VARIABLES") {
    try {
      const allVariables = await figma.variables.getLocalVariablesAsync();
      const exported: ParsedVariable[] = [];

      for (const v of allVariables) {
        if(!v.valuesByMode) continue;
        const modes = Object.keys(v.valuesByMode);
        if(modes.length === 0) continue;
        
        const rawVal = v.valuesByMode[modes[0]];
        let val = rawVal;
        let type: "Color" | "Number" | "String" | "Boolean" = "String";

        if (typeof rawVal === 'object' && (rawVal as any).type === 'VARIABLE_ALIAS') {
           const targetVar = allVariables.find(target => target.id === (rawVal as any).id);
           if (targetVar) val = `{${targetVar.name.replace(/_/g, '.')}}`;
           else val = `{unknown_alias}`;
        } else {
            if (v.resolvedType === "COLOR") { val = figmaColorToHex(rawVal); type = "Color"; }
            else if (v.resolvedType === "FLOAT") { 
                val = Number(Number(rawVal).toFixed(2)); 
                type = "Number"; 
            }
            else if (v.resolvedType === "BOOLEAN") { type = "Boolean"; }
        }

        exported.push({ name: v.name, value: val, type: type });
      }

      figma.ui.postMessage({ type: "LOAD_VARIABLES", data: exported });
    } catch (e: any) {
      console.error(e);
      figma.notify("❌ Failed to import variables from Figma.");
    }
    return;
  }

  if (msg.type === "CHECK_EXISTING") {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const collection = collections.find(c => c.name === "TokenShift");
    
    let existingVariables: Variable[] = [];
    if (collection) {
      const allVariables = await figma.variables.getLocalVariablesAsync();
      existingVariables = allVariables.filter(v => v.variableCollectionId === collection.id);
    }

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
          if (typeof rawVal === 'object' && (rawVal as any).type === 'VARIABLE_ALIAS') {
             oldValueStr = `{alias}`;
          } else if (existing.resolvedType === 'COLOR') {
             oldValueStr = figmaColorToHex(rawVal);
          } else if (existing.resolvedType === 'FLOAT') {
             oldValueStr = String(Number(Number(rawVal).toFixed(2)));
          }
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

  if (msg.type === "SYNC_VARIABLES") {
    await executeSync(msg.data);
  }
};

async function executeSync(variables: ParsedVariable[]) {
  if (variables.length === 0) return; 

  try {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    let collection = collections.find(c => c.name === "TokenShift");
    
    if (!collection) collection = figma.variables.createVariableCollection("TokenShift");

    const allVariables = await figma.variables.getLocalVariablesAsync();
    const existingVariables = allVariables.filter(v => v.variableCollectionId === collection!.id);
    
    let created = 0, updated = 0, failed = 0;
    const varMap = new Map<string, Variable>();

    // Pass 1: Create
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
          
          varMap.set(safeName, variable);

          const isAlias = typeof v.value === 'string' && v.value.trim().startsWith('{') && v.value.trim().endsWith('}');
          
          if (!isAlias) {
              let finalValue: VariableValue = v.value;
              if (figmaType === "COLOR") finalValue = parseColor(String(v.value));
              else if (figmaType === "FLOAT") finalValue = Number(Number(parseFloat(String(v.value))).toFixed(2));
              else if (figmaType === "BOOLEAN") finalValue = Boolean(v.value);
              else if (figmaType === "STRING") finalValue = String(v.value);

              variable.setValueForMode(collection.modes[0].modeId, finalValue);
          }
      } catch(err) {
          console.error(`Error with ${v.name}:`, err);
          failed++; 
      }
    }

    existingVariables.forEach(ev => { if (!varMap.has(ev.name)) varMap.set(ev.name, ev); });

    // Pass 2: Aliases
    for (const v of variables) {
       const isAlias = typeof v.value === 'string' && v.value.trim().startsWith('{') && v.value.trim().endsWith('}');
       if (isAlias) {
           const safeName = v.safeName || v.name.replace(/[{}.]/g, '_');
           const variable = varMap.get(safeName);
           if (!variable) continue;

           const targetRawName = v.value.trim().slice(1, -1).replace(/\./g, '/').replace(/[{}.]/g, '_');
           const targetVar = varMap.get(targetRawName);

           if (targetVar) {
               variable.setValueForMode(collection.modes[0].modeId, {
                   type: "VARIABLE_ALIAS",
                   id: targetVar.id
               });
           } else {
               console.warn(`Alias mapping failed: Could not find target ${targetRawName}`);
           }
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