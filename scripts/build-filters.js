// Usage: node scripts/build-filters.js out.bin list1.txt list2.txt ...
const fs = require('fs');
const { FiltersEngine } = require('@ghostery/adblocker');
const [out, ...lists] = process.argv.slice(2);
const text = lists.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const engine = FiltersEngine.parse(text, { loadCosmeticFilters: false, loadNetworkFilters: true, enableCompression: true, enableHtmlFiltering: false });
fs.writeFileSync(out, Buffer.from(engine.serialize()));
console.log('filters:', engine.getFilters().networkFilters.length, 'bytes:', fs.statSync(out).size);
