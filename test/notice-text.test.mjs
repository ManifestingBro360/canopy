// A notice must say what a signature change means for an existing call.
// In a trial with real agents, two were told "the signature changed" and both
// assumed, wrongly, that their one-argument call would keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paramDelta } from '../src/engine.mjs';

test('N1 a new argument with no default is called out as breaking', () => {
  const t = paramDelta('export function toCents(amount)', 'export function toCents(amount, mode)');
  assert.match(t, /requires a new argument with no default/); assert.match(t, /mode/); assert.match(t, /will not work/);
});
test('N2 a new argument with a default is called safe', () => {
  assert.match(paramDelta('function f(a)', "function f(a, mode = 'round')"), /optional: existing calls keep working/);
  assert.match(paramDelta('function f(a: number)', 'function f(a: number, mode?: string)'), /optional/);
  assert.match(paramDelta('def f(a)', 'def f(a, *rest)'), /optional/);
});
test('N3 a removed argument, a lost default and a reorder are each named', () => {
  assert.match(paramDelta('function f(a, b)', 'function f(a)'), /no longer takes .*b/);
  assert.match(paramDelta('function f(a, b = 1)', 'function f(a, b)'), /had a default is now required/);
  assert.match(paramDelta('function f(a, b)', 'function f(b, a)'), /different order/);
});
test('N4 nested parentheses, defaults with commas and Python self do not confuse it', () => {
  assert.match(paramDelta('function f(a, cb = (x, y) => x)', 'function f(a, cb = (x, y) => x, opts)'), /requires a new argument.*opts/);
  assert.equal(paramDelta('def f(self, a)', 'def f(self, a)'), '');
  assert.equal(paramDelta('const x', 'const y'), '');
});
