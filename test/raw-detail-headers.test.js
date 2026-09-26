import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRawHeaders, projectRawResponseHeaders, validRawHeaders } from '../lib/raw-detail-headers.js';

test('raw header projection permits only fixed structural names and canonical values', () => {
  const projected = projectRawHeaders({
    'Content-Type': 'application/json; charset=utf-8', Accept: 'text/event-stream',
    'content-length': '35000000', 'content-encoding': 'gzip', 'transfer-encoding': 'chunked',
    Authorization: 'Bearer fixture-key', Cookie: 'id=fixture-key', 'Set-Cookie': 'id=fixture-key',
    'X-Private-Key': 'fixture-key', 'X-Authorization': 'Bearer fixture-key', 'Api-Key': 'fixture-key', Referer: 'https://fixture/?api_key=fixture-key',
  });
  assert.deepEqual({ ...projected }, { 'content-type': 'application/json', accept: 'text/event-stream', 'content-length': '35000000', 'content-encoding': 'gzip', 'transfer-encoding': 'chunked', authorization: '[REDACTED]', cookie: '[REDACTED]', 'set-cookie': '[REDACTED]' });
  assert.equal(validRawHeaders(projected), true);
  assert.doesNotMatch(JSON.stringify(projected), /fixture-key|referer|private|x-authorization|api-key/i);
});

test('ambiguous/credential-bearing values never survive the structural parser', () => {
  const value = 'https://fixture/?api_key=fixture-secret';
  const projected = projectRawHeaders({
    'content-type': value, accept: 'application/json, ' + value,
    'content-length': '0001', 'content-encoding': ['gzip', 'br'], 'transfer-encoding': value,
  });
  assert.deepEqual({ ...projected }, Object.fromEntries(['content-type', 'accept', 'content-length', 'content-encoding', 'transfer-encoding'].map((name) => [name, '[REDACTED]'])));
  for (const source of [
    { 'Content-Type': 'application/json', 'content-type': 'text/plain' },
    { 'content-type': ['application/json', 'text/plain'] },
  ]) assert.equal(projectRawHeaders(source)['content-type'], '[REDACTED]');
  assert.equal(projectRawHeaders({ 'content-type': 'application/json' }, ['Content-Type', 'application/json', 'content-type', value])['content-type'], '[REDACTED]');
  assert.deepEqual({ ...projectRawHeaders(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x-${i}`, value]))) }, {});
  assert.deepEqual({ ...projectRawHeaders({ 'content-type': 'application/json' }, Array.from({ length: 258 }, () => value)) }, {});
  assert.equal(projectRawHeaders({ 'content-type': value.repeat(100) })['content-type'], '[REDACTED]');
  assert.deepEqual({ ...projectRawHeaders({ Authorization: 'gzip', Cookie: '0', 'Set-Cookie': 'text/plain' }) }, { authorization: '[REDACTED]', cookie: '[REDACTED]', 'set-cookie': '[REDACTED]' });
});

test('downstream writeHead projects bounded implicit and explicit sources before merging', () => {
  assert.deepEqual({ ...projectRawResponseHeaders({ 'content-type': 'text/plain', cookie: 'private' }, ['Content-Type', 'application/json', 'Set-Cookie', 'private']) }, { 'content-type': 'application/json', cookie: '[REDACTED]', 'set-cookie': '[REDACTED]' });
  assert.equal(projectRawResponseHeaders({}, ['Content-Type', 'application/json', 'content-type', 'text/plain'])['content-type'], '[REDACTED]');
  assert.deepEqual({ ...projectRawResponseHeaders({ 'content-type': 'application/json' }, Array.from({ length: 130 }, (_, i) => i % 2 ? 'private' : 'X-Custom')) }, {});
  assert.deepEqual({ ...projectRawResponseHeaders({ 'content-type': 'application/json' }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x-${i}`, 'private']))) }, {});
});

test('store schema rejects unsafe maps, unknown names, noncanonical or malformed values', () => {
  for (const map of [{ authorization: 'gzip' }, { cookie: '0' }, { 'set-cookie': 'text/plain' }, { 'content-type': 'application/json; charset=utf-8' }, { 'content-type': 'Bearer fixture-secret' }, { 'content-length': '0001' }, { 'content-length': 1 }, { 'accept': ['text/plain'] }, null, [], { '__proto__': null, 'x-private-key': 'fixture-secret' }]) assert.equal(Boolean(validRawHeaders(map)), false);
  assert.equal(validRawHeaders({}), true);
  assert.equal(validRawHeaders({ 'content-type': '[REDACTED]', 'content-length': '0', authorization: '[REDACTED]', cookie: '[REDACTED]', 'set-cookie': '[REDACTED]' }), true);
});
