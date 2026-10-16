const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

// Real metrics on the machine running the tests (CI runs it on Linux, Windows
// and macOS): every source must start, answer in the expected shape, and stop.
test(`system metrics on ${process.platform}`, { timeout: 20000 }, async () => {
  const system = require('../system');
  const samples = [];
  await new Promise((resolve) => {
    const done = () => { system.stop(); resolve(); };
    const deadline = setTimeout(done, 12000);
    system.start((s) => {
      samples.push(s);
      if (samples.length >= 3 && s.net.rate) { clearTimeout(deadline); done(); }
    });
  });
  const last = samples.at(-1);
  assert.ok(samples.length >= 3);
  assert.equal(last.cpu.per.length, os.cpus().length);
  assert.ok(last.cpu.per.every((v) => v >= 0 && v <= 100));
  assert.ok(last.ram.total > 0 && last.ram.free > 0 && last.ram.free <= last.ram.total, JSON.stringify(last.ram));
  assert.ok(last.net.rate, 'network counters never came');
  assert.ok(last.net.rate.down >= 0 && last.net.rate.up >= 0);
  if (last.gpu) {
    assert.equal(typeof last.gpu.name, 'string');
    assert.ok(last.gpu.util == null || (last.gpu.util >= 0 && last.gpu.util <= 100), JSON.stringify(last.gpu));
  }
  console.log(JSON.stringify({ ram: last.ram, net: last.net.rate, gpu: last.gpu }));
});
