const fs = require('fs');
const path = require('path');

const root = __dirname;
const visionTools = fs.readFileSync(path.join(root, 'vision-tools.js'), 'utf8');
const contentScript = fs.readFileSync(path.join(root, 'content-script.js'), 'utf8');
const backgroundWorker = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const shellSdk = fs.readFileSync(path.join(root, 'floyd-tools.sh'), 'utf8');

const extractAll = (source, pattern) => Array.from(source.matchAll(pattern), (match) => match[1]);

const schemaTools = new Set(extractAll(visionTools, /name:\s*'([a-z_]+)'/g));
const contentTools = new Set(extractAll(contentScript, /case\s+'([a-z_]+)'\s*:/g));
const backgroundTools = new Set(extractAll(backgroundWorker, /case\s+'([a-z_]+)'\s*:/g));
const implementedTools = new Set([...contentTools, ...backgroundTools]);
const sdkTools = new Set(extractAll(shellSdk, /floyd_call\s+([a-z_]+)/g));

const compare = (from, to) => [...from].filter((item) => !to.has(item)).sort();

const missingInContent = compare(schemaTools, implementedTools);
const missingInSchema = compare(implementedTools, schemaTools);
const missingInSdk = compare(schemaTools, sdkTools);
const missingInSchemaFromSdk = compare(sdkTools, schemaTools);

const failures = [];

if (missingInContent.length) failures.push(`schema->content missing: ${missingInContent.join(', ')}`);
if (missingInSchema.length) failures.push(`content->schema missing: ${missingInSchema.join(', ')}`);
if (missingInSdk.length) failures.push(`schema->sdk missing: ${missingInSdk.join(', ')}`);
if (missingInSchemaFromSdk.length) failures.push(`sdk->schema missing: ${missingInSchemaFromSdk.join(', ')}`);

if (failures.length) {
  process.stderr.write(failures.join('\n') + '\n');
  process.exit(1);
}

process.stdout.write(`Contract alignment OK for ${schemaTools.size} tools.\n`);
