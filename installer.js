const fs = require('node:fs');
const path = require('node:path');

const FILES = ['main.js', 'providers.js', 'installer.js', 'manifest.json', 'styles.css'];
const PLUGIN_ID = 'personal-knowledge-chat';

function installToVault(sourceDir, vaultDir) {
  const configDir = path.join(vaultDir, '.obsidian');
  if (!fs.existsSync(configDir) || !fs.statSync(configDir).isDirectory()) {
    throw new Error('Выберите папку хранилища Obsidian, в которой есть .obsidian.');
  }
  const pluginsFile = path.join(configDir, 'community-plugins.json');
  const enabled = fs.existsSync(pluginsFile) ? JSON.parse(fs.readFileSync(pluginsFile, 'utf8')) : [];
  if (!Array.isArray(enabled) || enabled.some(id => typeof id !== 'string')) {
    throw new Error('Не удалось прочитать список сторонних плагинов хранилища.');
  }

  const destination = path.join(configDir, 'plugins', PLUGIN_ID);
  if (fs.existsSync(destination)) throw new Error('В этом хранилище плагин уже установлен.');
  for (const file of FILES) {
    if (!fs.statSync(path.join(sourceDir, file)).isFile()) throw new Error(`Отсутствует файл плагина: ${file}`);
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const file of FILES) fs.copyFileSync(path.join(sourceDir, file), path.join(destination, file), fs.constants.COPYFILE_EXCL);
  if (!enabled.includes(PLUGIN_ID)) {
    enabled.push(PLUGIN_ID);
    fs.writeFileSync(pluginsFile, JSON.stringify(enabled, null, 2) + '\n', 'utf8');
  }
}

module.exports = { installToVault };
