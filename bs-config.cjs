'use strict';

require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env.development' });

const appPort = Number(process.env.PORT || 3000);
const browserPort = Number(process.env.DEV_BROWSER_PORT || 3001);
const uiPort = Number(process.env.DEV_BROWSER_UI_PORT || 3002);

module.exports = {
  proxy: `http://127.0.0.1:${appPort}`,
  port: browserPort,
  ui: { port: uiPort },
  open: false,
  notify: false,
  ghostMode: false,
  reloadDebounce: 150,
  reloadDelay: 100,
  files: [
    'views/**/*.ejs',
    'public/css/**/*.css',
    'public/js/**/*.js',
    'public/flags/**/*.svg'
  ],
  watchOptions: { ignoreInitial: true }
};
