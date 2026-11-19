import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appHome } from './config.js';
import type { Fields } from './local/storeFiles.js';

export interface GlobalSettings {
  developer: string;
  publisher: string;
}

const file = () => join(appHome(), 'settings.json');

function names(value: GlobalSettings): GlobalSettings {
  if (typeof value?.developer !== 'string' || typeof value?.publisher !== 'string') {
    throw new Error('开发者和发行商名称必须是文本，可留空');
  }
  return { developer: value.developer.trim(), publisher: value.publisher.trim() };
}

export function readGlobalSettings(): GlobalSettings {
  return existsSync(file()) ? names(JSON.parse(readFileSync(file(), 'utf8'))) : { developer: '', publisher: '' };
}

export function writeGlobalSettings(value: GlobalSettings): GlobalSettings {
  const settings = names(value);
  mkdirSync(appHome(), { recursive: true });
  writeFileSync(file(), JSON.stringify(settings, null, 2));
  return settings;
}

export function creatorDefaults(fields: Fields, settings: GlobalSettings): Fields {
  const defaults: Fields = {};
  const roles = [
    { name: settings.developer, first: 'app[game][developers][0][name]', pattern: /^app\[game\]\[developers\]\[\d+\]\[name\]$/ },
    { name: settings.publisher, first: 'app[game][publishers][0]', pattern: /^app\[game\]\[publishers\]\[\d+\]$/ },
  ];
  for (const { name, first, pattern } of roles) {
    if (name && fields[first] === '' && !Object.entries(fields).some(([key, value]) => pattern.test(key) && value)) {
      defaults[first] = name;
    }
  }
  return defaults;
}
