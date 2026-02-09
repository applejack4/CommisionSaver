const path = require('path');
const { execSync } = require('child_process');

test('server.js can be parsed without SyntaxError (no duplicate imports)', () => {
  const serverPath = path.resolve(__dirname, '../../server.js');

  // Use Node's --check flag which parses but does not execute.
  // This catches duplicate const declarations.
  expect(() => {
    execSync(`node --check "${serverPath}"`, {
      stdio: 'pipe',
      timeout: 10000
    });
  }).not.toThrow();
});

test('no debug agent fetch calls remain in source files', () => {
  const fs = require('fs');

  const sourceRoot = path.resolve(__dirname, '../..');
  const dirsToScan = [
    'services',
    'routes'
  ];

  function walk(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walk(full));
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        results.push(full);
      }
    }
    return results;
  }

  const violations = [];
  for (const dir of dirsToScan) {
    const files = walk(path.join(sourceRoot, dir));
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('127.0.0.1:7244') || content.includes('127.0.0.1:7242')) {
        violations.push(path.relative(sourceRoot, file));
      }
    }
  }

  expect(violations).toEqual([]);
});
