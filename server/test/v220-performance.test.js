import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const server=fs.readFileSync('server/src/index.js','utf8');
const ui=fs.readFileSync('dashboard/public/app.js','utf8');
const html=fs.readFileSync('dashboard/public/index.html','utf8');
test('boot uses one bootstrap request instead of sequential fleet calls',()=>{assert.match(ui,/api\('\/api\/bootstrap'/);assert.match(server,/app\.get\('\/api\/bootstrap'/);});
test('dashboard fleet refresh uses one request',()=>{assert.match(ui,/api\('\/api\/fleet'/);assert.match(server,/app\.get\('\/api\/fleet'/);});
test('short stale-while-revalidate cache avoids zero flash',()=>{assert.match(ui,/DASH_CACHE_MAX_AGE = 30000/);assert.match(ui,/hydrateDashboardCache/);assert.doesNotMatch(html,/id="total">0</);});
