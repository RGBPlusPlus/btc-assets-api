import { blockchain } from '@ckb-lumos/base';
import { isScriptEqual } from '@rgbpp-sdk/ckb';
import { Cell, Script } from '../routes/rgbpp/types';

/**
 * Get type script from request query
 */
export function getTypeScript(type_script: string | Script | undefined, { allowWildcard = true } = {}) {
  if (type_script === undefined) return undefined;

  try {
    const decoded =
      typeof type_script !== 'string'
        ? type_script
        : type_script.startsWith('0x')
          ? blockchain.Script.unpack(type_script)
          : JSON.parse(decodeURIComponent(type_script));
    const script = Script.parse(decoded);
    // Empty args (without the prefix) are used by existing wildcard filters.
    if (
      !/^0x[0-9a-fA-F]{64}$/.test(script.codeHash) ||
      (!/^0x(?:[0-9a-fA-F]{2})*$/.test(script.args) && !(allowWildcard && script.args === ''))
    ) {
      throw new Error('Invalid script bytes');
    }
    return script;
  } catch {
    throw Object.assign(new Error('Invalid type_script'), { statusCode: 400 });
  }
}

/**
 * Filter cells by type script
 */
export function filterCellsByTypeScript(cells: Cell[], typeScript: Script) {
  return cells.filter((cell) => {
    if (!cell.cellOutput.type) {
      return false;
    }
    // if typeScript.args is empty, only compare codeHash and hashType
    if (!typeScript.args) {
      const script = { ...cell.cellOutput.type, args: '' };
      return isScriptEqual(script, typeScript);
    }
    return isScriptEqual(cell.cellOutput.type, typeScript);
  });
}

/**
 * Filter cell outputs by type script
 */
export function filterOutputsByTypeScript(outputs: CKBComponents.CellOutput[], typeScript: Script) {
  return outputs.filter((output) => {
    if (!output.type) {
      return false;
    }
    if (!typeScript.args) {
      const script = { ...output.type, args: '' };
      return isScriptEqual(script, typeScript);
    }
    return isScriptEqual(output.type, typeScript);
  });
}
